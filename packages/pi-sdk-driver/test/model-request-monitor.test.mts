import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { isResumableConnectionFailure } from "../dist/connection-resume.js";
import {
  isModelStallError,
  monitorStreamFunction,
  SseEventScanner,
  stallErrorMessage,
  type ModelRequestDiagnostic,
  type ModelRequestProgress,
} from "../dist/model-request-monitor.js";

type Behavior = "pings" | "silent" | "answer";

/**
 * A local Anthropic Messages endpoint. "pings" accepts the request and sends only keep-alive
 * pings, like the stalled Opus requests; "silent" never sends headers; "answer" streams a reply.
 */
async function anthropicServer(t: TestContext, behaviors: Behavior[]) {
  const sockets = new Set<Socket>();
  const requests: number[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let size = 0;
    request.on("data", (chunk: Buffer) => (size += chunk.length));
    request.on("end", () => {
      requests.push(size);
      const behavior = behaviors.shift() ?? "answer";
      if (behavior === "silent") return;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `req_test_${requests.length}`,
      });
      if (behavior === "pings") {
        const ping = () => response.write('event: ping\ndata: {"type": "ping"}\n\n');
        ping();
        const timer = setInterval(ping, 40);
        response.on("close", () => clearInterval(timer));
        return;
      }
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      send("ping", { type: "ping" });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      });
      send("message_stop", { type: "message_stop" });
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function model(baseUrl: string) {
  return {
    id: "claude-test",
    name: "Claude test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 1_000,
  } as const;
}

const CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

function monitored(timeoutMs: number) {
  const diagnostics: ModelRequestDiagnostic[] = [];
  const progress: ModelRequestProgress[] = [];
  const state = { stalls: 0, outputs: 0 };
  const streamFn = monitorStreamFunction(
    (m: never, c: never, o?: never) => anthropicStream(m, c, o),
    {
      stallTimeoutMs: () => timeoutMs,
      recordStall: () => (state.stalls += 1),
      resetStalls: () => {
        state.stalls = 0;
      },
      onProgress: (entry) => progress.push(entry),
      onFirstOutput: () => (state.outputs += 1),
      onDiagnostic: (entry) => diagnostics.push(entry),
    },
  );
  const run = async (baseUrl: string) => {
    const events = (await streamFn(
      model(baseUrl) as never,
      CONTEXT as never,
      { apiKey: "test-key" } as never,
    )) as unknown as AsyncIterable<{ type: string }> & {
      result(): Promise<AssistantMessage>;
    };
    const types: string[] = [];
    for await (const event of events) types.push(event.type);
    return { message: await events.result(), types };
  };
  return { run, diagnostics, progress, state };
}

await test("SSE scanner reads event names across chunk boundaries and counts comment pings", () => {
  const scanner = new SseEventScanner();
  const encode = (text: string) => new TextEncoder().encode(text);
  assert.deepEqual(scanner.push(encode("event: pi")), []);
  assert.deepEqual(scanner.push(encode('ng\ndata: {"type":"ping"}\n\nevent: message_start\n')), [
    "ping",
  ]);
  assert.deepEqual(scanner.push(encode("data: {}\r\n\r\n: keep-alive\n\ndata: {}\n\n")), [
    "message_start",
    "ping",
    "message",
  ]);
});

await test("a request the provider accepts but only pings is ended as stalled, retryably", async (t) => {
  const server = await anthropicServer(t, ["pings"]);
  const { run, diagnostics, progress, state } = monitored(300);
  const { message } = await run(server.baseUrl);

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, stallErrorMessage(300, false));
  assert.ok(isModelStallError(message.errorMessage));
  // Pi retries it, and connection-resume may resume it, as a timeout.
  assert.equal(isRetryableAssistantError(message), true);
  assert.equal(isResumableConnectionFailure(message), true);
  assert.equal(state.stalls, 1);

  const kinds = diagnostics.map((entry) => entry.kind);
  assert.deepEqual(kinds, ["request_start", "response_headers", "stall", "request_end"]);
  const headers = diagnostics[1] as Extract<ModelRequestDiagnostic, { kind: "response_headers" }>;
  assert.equal(headers.status, 200);
  assert.equal(headers.requestId, "req_test_1");
  const stall = diagnostics[2] as Extract<ModelRequestDiagnostic, { kind: "stall" }>;
  assert.equal(stall.phase, "accepted");
  assert.equal(stall.action, "retry");
  assert.ok(stall.pings >= 2, `pings: ${stall.pings}`);
  const start = diagnostics[0] as Extract<ModelRequestDiagnostic, { kind: "request_start" }>;
  assert.equal(start.cacheWarm, false);
  assert.equal(start.bodyBytes, server.requests[0]);
  assert.equal(start.stallTimeoutMs, 300);

  assert.equal(progress[0]?.phase, "sending");
  assert.ok(progress.some((entry) => entry.phase === "accepted" && entry.pings > 0));
  assert.ok(progress.every((entry) => typeof entry.stallAt === "number"));
});

await test("a second stall in a row fails the run with an error nothing retries", async (t) => {
  const server = await anthropicServer(t, ["pings", "silent"]);
  const { run, diagnostics } = monitored(250);
  await run(server.baseUrl);
  const { message } = await run(server.baseUrl);

  assert.equal(message.errorMessage, stallErrorMessage(250, true));
  assert.equal(isRetryableAssistantError(message), false);
  assert.equal(isResumableConnectionFailure(message), false);
  const stalls = diagnostics.filter((entry) => entry.kind === "stall");
  assert.deepEqual(
    stalls.map((entry) => [entry.phase, entry.action]),
    [
      ["accepted", "retry"],
      // No headers at all: the SDK reports a connection error, which the monitor relabels.
      ["sending", "fail"],
    ],
  );
});

await test("output resets the stall count, and later requests on the same options are cache warms", async (t) => {
  const server = await anthropicServer(t, ["pings", "answer"]);
  const { run, diagnostics, state } = monitored(250);
  await run(server.baseUrl);
  assert.equal(state.stalls, 1);
  const { message, types } = await run(server.baseUrl);
  assert.equal(message.stopReason, "stop");
  assert.ok(types.includes("text_delta"));
  assert.equal(state.stalls, 0);
  assert.equal(state.outputs, 1);
  const second = diagnostics.slice(diagnostics.findIndex((d) => d.kind === "request_end") + 1);
  assert.deepEqual(
    second.map((entry) => entry.kind),
    ["request_start", "response_headers", "first_event", "first_output", "request_end"],
  );
  assert.equal(
    (second[2] as Extract<ModelRequestDiagnostic, { kind: "first_event" }>).event,
    "message_start",
  );
  assert.equal((second[3] as Extract<ModelRequestDiagnostic, { kind: "first_output" }>).pings, 1);
});

await test("a request with no stall timeout is never ended by the monitor", async (t) => {
  const server = await anthropicServer(t, ["answer"]);
  const { run, diagnostics } = monitored(0);
  const { message } = await run(server.baseUrl);
  assert.equal(message.stopReason, "stop");
  assert.equal(diagnostics.filter((entry) => entry.kind === "stall").length, 0);
  const start = diagnostics[0] as Extract<ModelRequestDiagnostic, { kind: "request_start" }>;
  assert.equal(start.stallTimeoutMs, undefined);
});

await test("cache-warming replays through a finished request's fetch are logged, not watched", async () => {
  const diagnostics: ModelRequestDiagnostic[] = [];
  let capturedFetch: typeof fetch | undefined;
  const fakeStream = {
    push(_event: unknown) {},
  };
  const streamFn = monitorStreamFunction(
    (_m: never, _c: never, options?: never) => {
      capturedFetch = (options as unknown as { fetch: typeof fetch }).fetch;
      return fakeStream;
    },
    {
      stallTimeoutMs: () => 10,
      recordStall: () => 1,
      resetStalls: () => undefined,
      onProgress: () => undefined,
      onFirstOutput: () => undefined,
      onDiagnostic: (entry) => diagnostics.push(entry),
      fetch: async () => new Response("{}", { status: 200, headers: { "request-id": "req_w" } }),
    },
  );
  const returned = streamFn({ provider: "anthropic", id: "m", api: "x" } as never, {} as never);
  fakeStream.push({ type: "done", message: { stopReason: "stop" } });
  assert.equal(returned, fakeStream);
  await capturedFetch?.("http://example.invalid", { method: "POST", body: "abcd" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const warm = diagnostics.filter((entry) => "cacheWarm" in entry && entry.cacheWarm);
  assert.deepEqual(
    warm.map((entry) => entry.kind),
    ["request_start", "response_headers"],
  );
  assert.equal(diagnostics.filter((entry) => entry.kind === "stall").length, 0);
});
