import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import { thinkingDriverEvent, transcriptFromMessages } from "../dist/session-supervisor-utils.js";
import { thinkingTimingsFromEntries } from "../dist/thinking-timing.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

const usage = {
  input: 1,
  output: 40,
  reasoning: 30,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 41,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Streams what pi's providers stream for a reasoning reply: a readable thinking block in
 * deltas, a redacted block that arrives complete (Anthropic's redacted_thinking), then text.
 */
function thinkingReply(model: Parameters<StreamFunction>[0]) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Plan the answer.", thinkingSignature: "sig" },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "opaque",
        redacted: true,
      },
      { type: "text", text: "The answer." },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const partial: AssistantMessage = { ...message, content: [] };
  stream.push({ type: "start", partial });
  partial.content = [{ type: "thinking", thinking: "" }];
  stream.push({ type: "thinking_start", contentIndex: 0, partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Plan the", partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: " answr", partial });
  // The end's content is authoritative: it corrects what the deltas built.
  stream.push({ type: "thinking_end", contentIndex: 0, content: "Plan the answer.", partial });
  partial.content = [...message.content.slice(0, 2)];
  stream.push({ type: "thinking_start", contentIndex: 1, partial });
  stream.push({ type: "thinking_end", contentIndex: 1, content: "[Reasoning redacted]", partial });
  partial.content = [...message.content];
  stream.push({ type: "text_start", contentIndex: 2, partial });
  stream.push({ type: "text_delta", contentIndex: 2, delta: "The answer.", partial });
  stream.push({ type: "text_end", contentIndex: 2, content: "The answer.", partial });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

async function fixture(t: TestContext, streamFunction: StreamFunction) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-thinking-"));
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
        "thinking-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const events: SessionDriverEvent[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback(runtimeOptions);
      runtime.session.agent.streamFunction = streamFunction;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "thinking-workspace", path: cwd },
    { initialModel: { provider: "thinking-test", modelId: "scripted" } },
  );
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const settled = async () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (events.some((event) => event.type === "runCompleted")) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("run did not complete");
  };
  return { driver, ref, events, settled };
}

await test("pi's thinking stream passes through as thinking events, and a reload keeps the blocks", async (t) => {
  const h = await fixture(t, (model) => thinkingReply(model));
  await h.driver.sendUserMessage(h.ref, { text: "Question" });
  await h.settled();

  const streamed = h.events.flatMap((event) => {
    switch (event.type) {
      case "assistantThinkingStarted":
        return [["start", event.contentIndex, event.redacted ?? false]];
      case "assistantThinkingDelta":
        return [["delta", event.contentIndex, event.text]];
      case "assistantThinkingEnded":
        return [["end", event.contentIndex, event.text, event.redacted ?? false]];
      case "assistantDelta":
        return [["text", event.text]];
      default:
        return [];
    }
  });
  assert.deepEqual(streamed, [
    ["start", 0, false],
    ["delta", 0, "Plan the"],
    ["delta", 0, " answr"],
    ["end", 0, "Plan the answer.", false],
    // The provider's placeholder for redacted reasoning is not forwarded as text.
    ["start", 1, true],
    ["end", 1, "", true],
    ["text", "The answer."],
  ]);

  // Thinking never becomes the thread preview.
  const previews = h.events.flatMap((event) =>
    event.type === "sessionUpdated" && event.snapshot.preview ? [event.snapshot.preview] : [],
  );
  assert.ok(
    previews.every((preview) => !preview.includes("Plan the")),
    previews.join(" | "),
  );

  const reloaded = await h.driver.getTranscript(h.ref);
  assert.deepEqual(
    reloaded.map((item) =>
      item.kind === "thinking"
        ? ["thinking", item.text, item.redacted ?? false]
        : item.kind === "message"
          ? [item.role, item.text]
          : [item.kind],
    ),
    [
      ["user", "Question"],
      ["thinking", "Plan the answer.", false],
      ["thinking", "", true],
      ["assistant", "The answer."],
    ],
  );
  const reply = reloaded.find((item) => item.kind === "message" && item.role === "assistant");
  for (const item of reloaded.filter((entry) => entry.kind === "thinking")) {
    assert.equal(item.kind === "thinking" && item.sourceMessageId, reply?.id);
    // Timed while it streamed and saved beside the message, so a restart keeps it.
    assert.equal(typeof (item.kind === "thinking" && item.durationMs), "number");
  }
});

const ref = { workspaceId: "w", sessionId: "s" };
const at = "2026-11-04T10:00:00.000Z";

await test("thinkingDriverEvent maps only thinking parts and hides redacted text", () => {
  const readable = [{ type: "thinking", thinking: "" }];
  const redacted = [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }];
  assert.equal(thinkingDriverEvent({ type: "text_delta" }, readable, ref, at), undefined);
  assert.equal(thinkingDriverEvent({ type: "toolcall_start" }, readable, ref, at), undefined);
  assert.deepEqual(
    thinkingDriverEvent(
      { type: "thinking_delta", contentIndex: 0, delta: "x" } as never,
      readable,
      ref,
      at,
    ),
    { type: "assistantThinkingDelta", sessionRef: ref, timestamp: at, contentIndex: 0, text: "x" },
  );
  assert.equal(
    thinkingDriverEvent(
      { type: "thinking_delta", contentIndex: 0, delta: "x" } as never,
      redacted,
      ref,
      at,
    ),
    undefined,
  );
  assert.deepEqual(
    thinkingDriverEvent(
      { type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" } as never,
      redacted,
      ref,
      at,
    ),
    {
      type: "assistantThinkingEnded",
      sessionRef: ref,
      timestamp: at,
      contentIndex: 0,
      text: "",
      redacted: true,
    },
  );
});

await test("a reload orders thinking before the reply and tool calls; untimed blocks have no duration", () => {
  const transcript = transcriptFromMessages([
    {
      role: "assistant",
      id: "entry-1",
      timestamp: Date.parse(at),
      content: [
        { type: "thinking", thinking: "First." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.parse(at),
    },
    {
      role: "assistant",
      id: "entry-2",
      timestamp: Date.parse(at),
      // An OpenAI reasoning item that carries only its encrypted payload.
      content: [
        { type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"x"}' },
        { type: "text", text: "Done." },
      ],
    },
  ]);
  assert.deepEqual(
    transcript.map((item) =>
      item.kind === "thinking" ? [item.id, item.text, item.durationMs] : [item.kind, item.id],
    ),
    [
      ["entry-1:thinking:0", "First.", undefined],
      ["tool", "call-1"],
      ["entry-2:thinking:0", "", undefined],
      ["message", "entry-2"],
    ],
  );
});

await test("timing entries map each message's blocks to their measured durations", () => {
  const timings = thinkingTimingsFromEntries([
    { type: "message" },
    {
      type: "custom",
      customType: "pi-gui.thinking-timing",
      data: { messageEntryId: "entry-1", durationsMs: { "0": 1200, "2": 300, "3": -1 } },
    },
    { type: "custom", customType: "pi-gui.thinking-timing", data: { messageEntryId: 5 } },
    { type: "custom", customType: "pi-gui.card", data: { messageEntryId: "x", durationsMs: {} } },
  ]);
  assert.deepEqual([...timings.keys()], ["entry-1"]);
  assert.deepEqual(
    [...timings.get("entry-1")!],
    [
      [0, 1200],
      [2, 300],
    ],
  );
});
