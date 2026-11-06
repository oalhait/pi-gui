import test from "node:test";
import assert from "node:assert/strict";
import {
  ErrorCodes,
  isRemoteError,
  PROTOCOL_VERSION,
  RpcPeer,
  type SessionEventParams,
} from "@pi-gui/remote-protocol";
import type {
  HostUiRequest,
  SessionDriverEvent,
  SessionEventListener,
  SessionRef,
} from "@pi-gui/session-driver";
import { HostServer, type HostDriver } from "../dist/index.js";

const sessionRef: SessionRef = { workspaceId: "/srv/project", sessionId: "s1" };

/** A driver double: records calls and lets the test emit session events. */
function fakeDriver() {
  const listeners = new Set<SessionEventListener>();
  const calls: { method: string; args: unknown[] }[] = [];
  let titleSignal: AbortSignal | undefined;
  const record =
    (method: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const driver = {
    listWorkspaces: record("listWorkspaces", { workspaces: [{ workspaceId: "/srv/project" }] }),
    renameSession: record("renameSession"),
    respondToHostUiRequest: record("respondToHostUiRequest"),
    generateThreadTitle: (_workspace: unknown, options: { signal?: AbortSignal }) => {
      titleSignal = options.signal;
      return new Promise<string | null>(() => undefined);
    },
    subscribe: (_ref: SessionRef, listener: SessionEventListener) => {
      listeners.add(listener);
      Promise.resolve(
        listener({ type: "sessionUpdated", sessionRef, timestamp: "t" } as SessionDriverEvent),
      ).catch(() => undefined);
      return () => listeners.delete(listener);
    },
    runtimeSupervisor: {
      getRuntimeSnapshot: record("runtime.getRuntimeSnapshot", { providers: [] }),
    },
  } as unknown as HostDriver;
  return {
    driver,
    calls,
    get listenerCount() {
      return listeners.size;
    },
    get titleSignal() {
      return titleSignal;
    },
    emit(event: SessionDriverEvent) {
      for (const listener of listeners) Promise.resolve(listener(event)).catch(() => undefined);
    },
  };
}

const hostInfo = {
  version: "test",
  hostname: "box",
  platform: "linux",
  arch: "x64",
  homeDir: "/home/me",
  nodeVersion: "22",
  pid: 1,
  startedAt: "t",
};

/** Connects a new client peer to `server` through JSON text. */
function connect(server: HostServer) {
  let client!: RpcPeer;
  let host!: RpcPeer;
  const deliver = (target: () => RpcPeer) => (line: string) =>
    queueMicrotask(() => target().receive(JSON.parse(line)));
  client = new RpcPeer(deliver(() => host));
  host = new RpcPeer(deliver(() => client));
  server.attach(host);
  const events: SessionEventParams[] = [];
  client.onNotification("session/event", (params) => events.push(params as SessionEventParams));
  return {
    client,
    events,
    hello: () =>
      client.request("hello", {
        protocolVersion: PROTOCOL_VERSION,
        client: { id: "laptop", name: "test", version: "0" },
      }),
    disconnect: () => {
      client.close();
      host.close();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const dialog = (requestId: string): HostUiRequest =>
  ({ kind: "confirm", requestId, title: "Proceed?", message: "" }) as HostUiRequest;

const hostUiEvent = (request: HostUiRequest): SessionDriverEvent => ({
  type: "hostUiRequest",
  sessionRef,
  timestamp: "t",
  request,
});

await test("refuses calls before hello and incompatible protocol versions", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const connection = connect(server);
  await assert.rejects(connection.client.request("driver/listWorkspaces", []), (error: unknown) =>
    isRemoteError(error, ErrorCodes.invalidRequest),
  );
  await assert.rejects(
    connection.client.request("hello", { protocolVersion: 999, client: { id: "x" } }),
    (error: unknown) => isRemoteError(error, ErrorCodes.incompatible),
  );
  const hello = (await connection.hello()) as { host: { protocolVersion: number } };
  assert.equal(hello.host.protocolVersion, PROTOCOL_VERSION);
});

await test("forwards driver and runtime calls with their arguments", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const connection = connect(server);
  await connection.hello();
  const workspaces = await connection.client.request("driver/listWorkspaces", []);
  assert.deepEqual(workspaces, { workspaces: [{ workspaceId: "/srv/project" }] });
  await connection.client.request("driver/renameSession", [sessionRef, "New name"]);
  await connection.client.request("runtime/getRuntimeSnapshot", [{ workspaceId: "/srv/project" }]);
  assert.deepEqual(fake.calls.slice(1), [
    { method: "renameSession", args: [sessionRef, "New name"] },
    { method: "runtime.getRuntimeSnapshot", args: [{ workspaceId: "/srv/project" }] },
  ]);
  await assert.rejects(connection.client.request("driver/subscribe", []), (error: unknown) =>
    isRemoteError(error, ErrorCodes.methodNotFound),
  );
});

await test("cancelling generateThreadTitle aborts the host-side signal", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const connection = connect(server);
  await connection.hello();
  const controller = new AbortController();
  const title = connection.client.request(
    "driver/generateThreadTitle",
    [{ workspaceId: "/srv/project", path: "/srv/project" }, { prompt: "hi" }],
    { signal: controller.signal },
  );
  await tick();
  assert.equal(fake.titleSignal?.aborted, false);
  controller.abort();
  await assert.rejects(title);
  await tick();
  assert.equal(fake.titleSignal?.aborted, true);
});

await test("delivers events for a client-chosen subscription, including the first one", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const connection = connect(server);
  await connection.hello();
  await connection.client.request("session/subscribe", { sessionRef, subscriptionId: "a" });
  fake.emit({ type: "runCompleted", sessionRef, timestamp: "t" } as SessionDriverEvent);
  await tick();
  assert.deepEqual(
    connection.events.map((params) => [params.subscriptionId, params.event.type]),
    [
      ["a", "sessionUpdated"],
      ["a", "runCompleted"],
    ],
  );
  await assert.rejects(
    connection.client.request("session/subscribe", { sessionRef, subscriptionId: "a" }),
    (error: unknown) => isRemoteError(error, ErrorCodes.invalidRequest),
  );
});

await test("a reconnecting client receives dialogs opened while it was away", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const first = connect(server);
  await first.hello();
  await first.client.request("session/subscribe", { sessionRef, subscriptionId: "a" });
  first.disconnect();
  await tick();

  // Raised with no client connected; then one is dismissed by pi and one answered elsewhere.
  fake.emit(hostUiEvent(dialog("open")));
  fake.emit(hostUiEvent(dialog("dismissed")));
  fake.emit(hostUiEvent({ kind: "dismiss", requestId: "dismissed" } as HostUiRequest));
  fake.emit(hostUiEvent(dialog("answered")));

  const other = connect(server);
  await other.hello();
  await other.client.request("driver/respondToHostUiRequest", [
    sessionRef,
    { requestId: "answered", confirmed: true },
  ]);

  const second = connect(server);
  await second.hello();
  await second.client.request("session/subscribe", { sessionRef, subscriptionId: "b" });
  await tick();
  const replayed = second.events
    .filter((params) => params.event.type === "hostUiRequest")
    .map((params) => (params.event as { request: HostUiRequest }).request.requestId);
  assert.deepEqual(replayed, ["open"]);
});

await test("closing a connection drops only its subscriptions", async () => {
  const fake = fakeDriver();
  const server = new HostServer({ driver: fake.driver, hostInfo });
  const one = connect(server);
  const two = connect(server);
  await one.hello();
  await two.hello();
  await one.client.request("session/subscribe", { sessionRef, subscriptionId: "a" });
  await two.client.request("session/subscribe", { sessionRef, subscriptionId: "a" });
  const withBoth = fake.listenerCount;
  one.disconnect();
  await tick();
  assert.equal(fake.listenerCount, withBoth - 1);
  assert.equal(server.connectionCount, 1);
  fake.emit({ type: "runCompleted", sessionRef, timestamp: "t" } as SessionDriverEvent);
  await tick();
  assert.ok(two.events.some((params) => params.event.type === "runCompleted"));
});
