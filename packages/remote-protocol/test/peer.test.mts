import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ErrorCodes, isRemoteError, RemoteError, RpcPeer } from "../dist/index.js";
import { createStreamPeer } from "../dist/node.js";

/** Two peers wired back to back through JSON text, as on the wire. */
function linkedPeers(): { client: RpcPeer; server: RpcPeer } {
  let client!: RpcPeer;
  let server!: RpcPeer;
  const deliver = (target: () => RpcPeer) => (line: string) =>
    queueMicrotask(() => target().receive(JSON.parse(line)));
  client = new RpcPeer(deliver(() => server));
  server = new RpcPeer(deliver(() => client));
  return { client, server };
}

await test("correlates concurrent requests with their responses", async () => {
  const { client, server } = linkedPeers();
  server.handle("echo", async (params) => {
    const { value, delayMs } = params as { value: string; delayMs: number };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return value;
  });
  const results = await Promise.all([
    client.request("echo", { value: "slow", delayMs: 20 }),
    client.request("echo", { value: "fast", delayMs: 0 }),
  ]);
  assert.deepEqual(results, ["slow", "fast"]);
});

await test("returns handler errors with their code and name, and unknown methods", async () => {
  const { client, server } = linkedPeers();
  server.handle("fail", () => {
    const error = new Error("lease held");
    error.name = "SessionLeasedError";
    throw error;
  });
  server.handle("unavailable", () => {
    throw new RemoteError("not on remote", ErrorCodes.unavailable);
  });
  await assert.rejects(client.request("fail"), (error: unknown) => {
    assert.ok(isRemoteError(error, ErrorCodes.failed));
    assert.equal(error.name, "SessionLeasedError");
    assert.equal(error.message, "lease held");
    return true;
  });
  await assert.rejects(client.request("unavailable"), (error: unknown) =>
    isRemoteError(error, ErrorCodes.unavailable),
  );
  await assert.rejects(client.request("missing"), (error: unknown) =>
    isRemoteError(error, ErrorCodes.methodNotFound),
  );
});

await test("cancelling a request aborts the handler on the other side", async () => {
  const { client, server } = linkedPeers();
  let handlerAborted = false;
  server.handle("wait", (_params, { signal }) => {
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        handlerAborted = true;
        resolve("late");
      });
    });
  });
  const controller = new AbortController();
  const pending = client.request("wait", undefined, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => isRemoteError(error, ErrorCodes.cancelled));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(handlerAborted, true);
});

await test("a timeout rejects the request", async () => {
  const { client, server } = linkedPeers();
  server.handle("never", () => new Promise(() => undefined));
  await assert.rejects(client.request("never", undefined, { timeoutMs: 10 }), (error: unknown) =>
    isRemoteError(error, ErrorCodes.cancelled),
  );
});

await test("closing rejects outstanding requests and aborts incoming handlers", async () => {
  const { client, server } = linkedPeers();
  let serverSignal: AbortSignal | undefined;
  server.handle("hang", (_params, { signal }) => {
    serverSignal = signal;
    return new Promise(() => undefined);
  });
  const pending = client.request("hang");
  await new Promise((resolve) => setTimeout(resolve, 5));
  client.close();
  server.close();
  await assert.rejects(pending, (error: unknown) => isRemoteError(error, ErrorCodes.disconnected));
  assert.equal(serverSignal?.aborted, true);
  await assert.rejects(client.request("hang"), (error: unknown) =>
    isRemoteError(error, ErrorCodes.disconnected),
  );
});

await test("a result that cannot be encoded fails that request, not the connection", async () => {
  const { client, server } = linkedPeers();
  server.handle("bigint", () => ({ value: 1n }));
  server.handle("ok", () => "fine");
  await assert.rejects(client.request("bigint"), (error: unknown) =>
    isRemoteError(error, ErrorCodes.failed),
  );
  assert.equal(await client.request("ok"), "fine");
});

await test("notifications reach every listener", async () => {
  const { client, server } = linkedPeers();
  const seen: unknown[] = [];
  client.onNotification("tick", (params) => seen.push(["a", params]));
  client.onNotification("tick", (params) => seen.push(["b", params]));
  server.notify("tick", { n: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [
    ["a", { n: 1 }],
    ["b", { n: 1 }],
  ]);
});

await test("stream peers talk over byte streams and close when the input ends", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = createStreamPeer(serverToClient, clientToServer);
  const server = createStreamPeer(clientToServer, serverToClient);
  server.handle("upper", (params) => String(params).toUpperCase());
  assert.equal(await client.request("upper", "line\u2028sep"), "LINE\u2028SEP");

  const closed = new Promise<Error>((resolve) => client.onClose(resolve));
  serverToClient.end();
  const reason = await closed;
  assert.ok(isRemoteError(reason, ErrorCodes.disconnected));
});

await test("a malformed record closes the stream peer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = createStreamPeer(input, output);
  const closed = new Promise<Error>((resolve) => peer.onClose(resolve));
  input.write("not json\n");
  assert.ok(isRemoteError(await closed, ErrorCodes.invalidRequest));
});
