import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import type { ConnectionResumePolicy } from "../dist/connection-resume.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];
type Model = Parameters<StreamFunction>[0];

const TIMED_OUT = "Request timed out.";

/** A reply, or a failure shaped like the 2026-11-04 timeouts: no content, zero usage. */
function response(model: Model, text: string, error?: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: error ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: error ? 0 : 1,
      output: error ? 0 : 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: error ? 0 : 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: error ? "error" : "stop",
    ...(error ? { errorMessage: error } : {}),
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  if (error) {
    stream.push({ type: "error", reason: "error", error: message });
  } else {
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
  }
  return stream;
}

const FAST: ConnectionResumePolicy = { delaysMs: [30, 30, 30], budgetMs: 10_000, onlinePollMs: 5 };

/** The installed pi runtime and the driver's public API; only model streaming is replaced. */
async function fixture(
  t: TestContext,
  streamFunction: StreamFunction,
  policy: ConnectionResumePolicy = FAST,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-connection-resume-"));
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
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("These tests must never use the network");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0, "no network request is permitted"));
  await writeFile(join(agentDir, "auth.json"), "{}");
  // pi's own retry stays on: one retry per failure before the run would settle.
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "resume-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  const rawEvents: AgentSessionEvent[] = [];
  const events: SessionDriverEvent[] = [];
  const changed = new Set<() => void>();
  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogStorage: new JsonCatalogStore({ catalogFilePath: join(root, "catalogs.json") }),
    connectionResume: { policy },
    createAgentSessionRuntimeImpl: async (options) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = streamFunction;
      runtime.session.subscribe((event) => rawEvents.push(event));
      return runtime;
    },
  });
  const { workspace } = await driver.syncWorkspace(cwd, "Resume");
  const snapshot = await driver.createSession(workspace, {
    initialModel: { provider: "resume-test", modelId: "scripted" },
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
    get runtime() {
      return runtime;
    },
    events,
    rawEvents,
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
    retries: () => snapshots().flatMap((s) => (s.connectionRetry ? [s.connectionRetry] : [])),
  };
}

await test(
  "a run that keeps timing out resumes itself and completes once, without a new message",
  { timeout: 15_000 },
  async (t) => {
    // pi tries twice per round (one retry); two rounds fail, then the connection is back.
    let requests = 0;
    const contexts: string[] = [];
    const h = await fixture(t, (model, context) => {
      requests += 1;
      contexts.push(JSON.stringify(context.messages));
      return requests <= 4 ? response(model, "", TIMED_OUT) : response(model, "Back online");
    });
    await h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.completions().length + h.failures().length > 0);

    assert.equal(requests, 5);
    assert.equal(h.failures().length, 0, "no runFailed, so no failure notification");
    assert.equal(h.completions().length, 1);
    const runIds = new Set(
      h.events.flatMap((event) => ("runId" in event && event.runId ? [event.runId] : [])),
    );
    assert.equal(runIds.size, 1, "one desktop run from the prompt to the reply");
    assert.equal(h.rawEvents.filter((event) => event.type === "agent_settled").length, 1);

    // The wait and the attempt were both visible on the snapshot.
    const retries = h.retries();
    assert.ok(retries.some((retry) => retry.attempt === 0 && retry.retryAt));
    assert.ok(retries.some((retry) => retry.attempt === 1 && retry.retryAt));
    assert.ok(retries.some((retry) => retry.attempt === 2 && !retry.retryAt));
    assert.ok(retries.every((retry) => retry.error === TIMED_OUT));
    const final = h.completions()[0];
    assert.ok(final?.type === "runCompleted");
    assert.equal(final.snapshot.status, "idle");
    assert.equal(final.snapshot.connectionRetry, undefined);
    assert.equal(final.snapshot.preview, "Back online");

    // pi's continuation, not a message: one user turn, and the failures left out of context.
    const branch = h.runtime.session.sessionManager.getBranch();
    const users = branch.filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    assert.equal(users.length, 1);
    const failedIds = branch
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "error",
      )
      .map((entry) => entry.id);
    assert.equal(failedIds.length, 4);
    const omitted = branch.flatMap((entry) =>
      entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : [],
    );
    assert.deepEqual(omitted.sort(), [...failedIds].sort());
    const lastContext = JSON.parse(contexts.at(-1) ?? "[]") as { role: string }[];
    assert.deepEqual(
      lastContext.map((message) => message.role).filter((role) => role !== "system"),
      ["user"],
      "the resumed request carries the original prompt and nothing pi-gui made up",
    );
  },
);

await test(
  "an error that is not about the connection fails at once",
  { timeout: 15_000 },
  async (t) => {
    let requests = 0;
    const h = await fixture(t, (model) => {
      requests += 1;
      return response(
        model,
        "",
        '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      );
    });
    await h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.failures().length > 0);
    assert.equal(requests, 1);
    assert.equal(h.failures().length, 1);
    assert.equal(h.completions().length, 0);
    assert.deepEqual(h.retries(), []);
  },
);

await test(
  "stopping while a resume waits leaves the run stopped, not failed",
  { timeout: 15_000 },
  async (t) => {
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, "", TIMED_OUT);
      },
      { delaysMs: [60_000], budgetMs: 120_000, onlinePollMs: 1_000 },
    );
    // The send resolves when the run ends, so it stays pending through the wait.
    const sending = h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.retries().some((retry) => retry.retryAt));
    const before = requests;
    const started = Date.now();
    await h.driver.cancelCurrentRun(h.ref);
    await sending;
    assert.ok(Date.now() - started < 5_000, "Stop did not wait out the 60 s delay");
    assert.equal(requests, before, "no resume after Stop");
    assert.equal(h.failures().length, 0);
    assert.equal(h.completions().length, 0);
    const snapshot = await h.driver.openSession(h.ref);
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.connectionRetry, undefined);
  },
);

await test(
  "when the budget runs out the run fails once, as before",
  { timeout: 15_000 },
  async (t) => {
    let requests = 0;
    const h = await fixture(
      t,
      (model) => {
        requests += 1;
        return response(model, "", TIMED_OUT);
      },
      { delaysMs: [20], budgetMs: 70, onlinePollMs: 5 },
    );
    await h.driver.sendUserMessage(h.ref, { text: "Do the work" });
    await h.until(() => h.failures().length > 0);
    // Rounds of two attempts (pi's one retry); resumes start 20 ms apart until 70 ms is spent.
    assert.ok(requests >= 4 && requests % 2 === 0, `requests: ${requests}`);
    const failure = h.failures()[0];
    assert.ok(failure?.type === "runFailed");
    assert.equal(failure.error.message, TIMED_OUT);
    assert.equal(h.failures().length, 1);
    assert.equal(h.completions().length, 0);
    const snapshot = await h.driver.openSession(h.ref);
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.connectionRetry, undefined);
  },
);
