import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionTranscriptItem } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

/** Answers every turn with "Answer to <latest user text>". */
const answerLatest: StreamFunction = (model, context) => {
  const latest = [...context.messages].reverse().find((message) => message.role === "user");
  const asked =
    typeof latest?.content === "string"
      ? latest.content
      : (latest?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
  const text = `Answer to ${asked}`;
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
};

/** Real installed pi with persisted session entries; only the provider is fake. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-rewind-"));
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
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "rewind-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: [],
      });
      runtime.session.agent.streamFunction = answerLatest;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "rewind-workspace", path: cwd },
    { initialModel: { provider: "rewind-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  const waiters = new Set<() => void>();
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
    for (const waiter of waiters) waiter();
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const completed = () => events.filter((event) => event.type === "runCompleted").length;
  const send = async (text: string) => {
    const before = completed();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (completed() <= before) return;
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
      driver.sendUserMessage(ref, { text }).catch(reject);
    });
  };
  const messages = async () =>
    (await driver.getTranscript(ref)).flatMap((item: SessionTranscriptItem) =>
      item.kind === "message" ? [`${item.role}: ${item.text}`] : [],
    );
  /** User entry IDs the driver reported while runs were live, keyed by persisted text. */
  const persistedUserIds = () =>
    new Map(
      events.flatMap((event) =>
        event.type === "userMessagePersisted" ? [[event.text, event.sourceMessageId] as const] : [],
      ),
    );
  return { driver, ref, send, messages, persistedUserIds };
}

await test("reports each user message's session entry ID as Pi persists it", async (t) => {
  const h = await fixture(t);
  await h.send("First");
  await h.send("Second");
  const users = (await h.driver.getTranscript(h.ref)).filter(
    (item) => item.kind === "message" && item.role === "user",
  );
  assert.deepEqual(
    [...h.persistedUserIds()],
    users.map((item) => [item.kind === "message" ? item.text : "", item.id]),
  );
});

await test("rewinds to before an earlier user message by its reported entry ID", async (t) => {
  const h = await fixture(t);
  await h.send("First");
  await h.send("Second");
  await h.send("Third");

  const result = await h.driver.rewindToUserMessage(h.ref, h.persistedUserIds().get("Second")!);
  assert.equal(result.cancelled, false);
  assert.equal(result.editorText, "Second");
  // The session's own earlier turns grew the file; the transcript must still show the new leaf.
  assert.deepEqual(await h.messages(), ["user: First", "assistant: Answer to First"]);

  await h.send("Second, edited");
  assert.deepEqual(await h.messages(), [
    "user: First",
    "assistant: Answer to First",
    "user: Second, edited",
    "assistant: Answer to Second, edited",
  ]);
});

await test("rewinds to before the first user message", async (t) => {
  const h = await fixture(t);
  await h.send("First");
  await h.send("Second");

  const result = await h.driver.rewindToUserMessage(h.ref, h.persistedUserIds().get("First")!);
  assert.equal(result.editorText, "First");
  assert.deepEqual(await h.messages(), []);

  await h.send("First, edited");
  assert.deepEqual(await h.messages(), [
    "user: First, edited",
    "assistant: Answer to First, edited",
  ]);
});

await test("refuses to rewind to a message that is not a user message", async (t) => {
  const h = await fixture(t);
  await h.send("First");
  const assistant = (await h.driver.getTranscript(h.ref)).find(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  await assert.rejects(
    h.driver.rewindToUserMessage(h.ref, assistant!.id),
    new RegExp(`no user message ${assistant!.id}`),
  );
  await assert.rejects(h.driver.rewindToUserMessage(h.ref, "missing"), /no user message missing/);
});
