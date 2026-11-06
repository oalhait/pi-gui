import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import { stallErrorMessage } from "../dist/model-request-monitor.js";
import type { RunDiagnostic } from "../dist/run-diagnostics.js";

const STALL_MS = 400;

/** An Anthropic Messages endpoint: "pings" accepts and only pings; "answer" replies. */
async function anthropicServer(t: TestContext, behaviors: ("pings" | "answer")[]) {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `req_run_${requests}`,
      });
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if ((behaviors.shift() ?? "answer") === "pings") {
        const timer = setInterval(() => send("ping", { type: "ping" }), 50);
        response.on("close", () => clearInterval(timer));
        return;
      }
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Recovered" },
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
  return { baseUrl: `http://127.0.0.1:${port}`, requests: () => requests };
}

async function fixture(t: TestContext, behaviors: ("pings" | "answer")[]) {
  const server = await anthropicServer(t, behaviors);
  const root = await mkdtemp(join(tmpdir(), "pi-gui-model-stall-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "stall-test": {
          baseUrl: server.baseUrl,
          apiKey: "LOCAL_TEST_KEY",
          api: "anthropic-messages",
          models: [{ id: "claude-test", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
        },
      },
    }),
  );

  const diagnostics: RunDiagnostic[] = [];
  const events: SessionDriverEvent[] = [];
  const changed = new Set<() => void>();
  const driver = new PiSdkDriver({
    agentDir,
    catalogStorage: new JsonCatalogStore({ catalogFilePath: join(root, "catalogs.json") }),
    // Fast enough that a resume would show up in the test, were one to start.
    connectionResume: { policy: { delaysMs: [20], budgetMs: 10_000, onlinePollMs: 5 } },
    modelStallTimeoutMs: () => STALL_MS,
    onRunDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    generateThreadTitleOverride: async () => null,
    createAgentSessionRuntimeImpl: (options) =>
      createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] }),
  });
  const { workspace } = await driver.syncWorkspace(cwd, "Stall");
  const snapshot = await driver.createSession(workspace, {
    initialModel: { provider: "stall-test", modelId: "claude-test" },
  });
  const ref = snapshot.ref;
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
    for (const listener of changed) listener();
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const snapshots = () =>
    events.flatMap((event): SessionSnapshot[] =>
      event.type === "sessionUpdated" || event.type === "runCompleted" ? [event.snapshot] : [],
    );
  return {
    driver,
    ref,
    server,
    diagnostics,
    events,
    snapshots,
    until(predicate: () => boolean) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!predicate()) return;
          changed.delete(check);
          resolve();
        };
        changed.add(check);
      });
    },
    completions: () => events.filter((event) => event.type === "runCompleted"),
    failures: () => events.filter((event) => event.type === "runFailed"),
  };
}

await test(
  "a request that only gets pings is ended, retried once by Pi, and the run completes",
  { timeout: 20_000 },
  async (t) => {
    const h = await fixture(t, ["pings", "answer"]);
    await h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.completions().length + h.failures().length > 0);

    assert.equal(h.server.requests(), 2);
    assert.equal(h.failures().length, 0);
    const final = h.completions()[0];
    assert.ok(final?.type === "runCompleted");
    assert.equal(final.snapshot.preview, "Recovered");
    assert.equal(final.snapshot.modelWait, undefined);

    // The waiting line saw the request accepted, then pinging, then Pi's retry for the stall.
    const waits = h.snapshots().flatMap((s) => (s.modelWait ? [s.modelWait] : []));
    assert.ok(waits.some((w) => w.request?.phase === "sending" && w.request.stallAt));
    assert.ok(waits.some((w) => w.request?.phase === "accepted" && w.request.status === 200));
    assert.ok(waits.some((w) => (w.request?.pings ?? 0) > 0));
    assert.ok(
      waits.some((w) => w.retry?.retryAt && w.retry.error === stallErrorMessage(STALL_MS, false)),
    );
    assert.equal(
      h.snapshots().some((s) => s.connectionRetry),
      false,
    );

    const kinds = h.diagnostics.map((d) => d.kind);
    assert.deepEqual(kinds, [
      "prompt_start",
      "agent_start",
      "turn_start",
      "request_start",
      "response_headers",
      "stall",
      "request_end",
      "retry_backoff",
      "agent_start",
      "turn_start",
      "request_start",
      "response_headers",
      "first_event",
      "first_output",
      "request_end",
      "retry_end",
      "run_end",
    ]);
    const runIds = new Set(h.diagnostics.map((d) => d.runId));
    assert.equal(runIds.size, 1, "every entry belongs to the one run");
    assert.ok(h.diagnostics.every((d) => d.sessionId === h.ref.sessionId));
    const end = h.diagnostics.at(-1);
    assert.ok(end?.kind === "run_end" && end.outcome === "completed");
  },
);

await test(
  "two stalls in a row fail the run visibly instead of retrying or resuming",
  { timeout: 20_000 },
  async (t) => {
    const h = await fixture(t, ["pings", "pings", "answer"]);
    await h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.completions().length + h.failures().length > 0);
    // Give a resume, were one scheduled, time to start.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(h.server.requests(), 2);
    assert.equal(h.completions().length, 0);
    const failure = h.failures()[0];
    assert.ok(failure?.type === "runFailed");
    assert.equal(failure.error.message, stallErrorMessage(STALL_MS, true));
    assert.equal(
      h.snapshots().some((s) => s.connectionRetry),
      false,
    );
    const stalls = h.diagnostics.flatMap((d) => (d.kind === "stall" ? [d.action] : []));
    assert.deepEqual(stalls, ["retry", "fail"]);
    assert.equal(h.diagnostics.filter((d) => d.kind === "connection_resume_wait").length, 0);
    const end = h.diagnostics.at(-1);
    assert.ok(end?.kind === "run_end" && end.outcome === "failed");
  },
);
