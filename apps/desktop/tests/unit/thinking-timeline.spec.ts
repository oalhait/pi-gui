import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TimelineTranscriptItem, TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  applyTimelineEvent,
  timelineFromDriverTranscript,
} from "../../electron/conversation/app-store-timeline";
import { shouldDeferStreamingUiPublish } from "../../electron/conversation/streaming-ui-publisher";
import {
  DEFAULT_THINKING_DISPLAY,
  parseThinkingDisplay,
} from "../../src/features/conversation/thinking-display";
import { buildDisplayTimelineItems } from "../../src/features/conversation/timeline-turns";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, seconds)).toISOString();

function fixture() {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    unpersistedUserMessagesBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  const send = (event: SessionDriverEvent) => applyTimelineEvent(transcript, event, state);
  const start = (contentIndex: number, seconds: number, redacted?: boolean) =>
    send({
      type: "assistantThinkingStarted",
      sessionRef,
      timestamp: at(seconds),
      contentIndex,
      ...(redacted ? { redacted } : {}),
    });
  const delta = (contentIndex: number, text: string) =>
    send({ type: "assistantThinkingDelta", sessionRef, timestamp: at(0), contentIndex, text });
  const end = (contentIndex: number, text: string, seconds: number, redacted?: boolean) =>
    send({
      type: "assistantThinkingEnded",
      sessionRef,
      timestamp: at(seconds),
      contentIndex,
      text,
      ...(redacted ? { redacted } : {}),
    });
  const text = (value: string) =>
    appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, value);
  const rows = () =>
    (transcript.get(key) ?? []).map((item) =>
      item.kind === "thinking"
        ? {
            kind: item.kind,
            text: item.text,
            streaming: item.streaming ?? false,
            durationMs: item.durationMs,
            redacted: item.redacted ?? false,
          }
        : item.kind === "message"
          ? { kind: item.kind, text: item.text }
          : { kind: item.kind },
    );
  return { transcript, state, send, start, delta, end, text, rows };
}

test("a live thinking block streams, then pi's final content replaces the deltas", () => {
  const h = fixture();
  h.start(0, 0);
  h.delta(0, "Plan the");
  h.delta(0, " answr");
  expect(h.rows()).toEqual([
    {
      kind: "thinking",
      text: "Plan the answr",
      streaming: true,
      durationMs: undefined,
      redacted: false,
    },
  ]);
  h.end(0, "Plan the answer.", 12);
  h.text("The answer.");
  expect(h.rows()).toEqual([
    {
      kind: "thinking",
      text: "Plan the answer.",
      streaming: false,
      durationMs: 12_000,
      redacted: false,
    },
    { kind: "message", text: "The answer." },
  ]);
  const thinking = h.transcript.get(key)![0]!;
  expect(thinking).not.toHaveProperty("streamingContentIndex");
});

test("several blocks interleave with tools, and redacted reasoning keeps no text", () => {
  const h = fixture();
  h.start(0, 0);
  h.delta(0, "First");
  h.end(0, "First", 2);
  h.send({
    type: "toolStarted",
    sessionRef,
    timestamp: at(2),
    toolName: "read",
    callId: "call-1",
    input: { path: "a" },
  });
  h.send({ type: "assistantMessageEnded", sessionRef, timestamp: at(3) });
  h.send({ type: "toolFinished", sessionRef, timestamp: at(3), callId: "call-1", success: true });
  // Next message: an encrypted block with no text, then a readable one, then the answer.
  h.start(0, 4, true);
  h.end(0, "", 7, true);
  h.start(1, 7);
  h.delta(1, "Second");
  h.end(1, "Second", 8);
  h.text("Done.");
  expect(h.rows()).toEqual([
    { kind: "thinking", text: "First", streaming: false, durationMs: 2_000, redacted: false },
    { kind: "tool" },
    { kind: "thinking", text: "", streaming: false, durationMs: 3_000, redacted: true },
    { kind: "thinking", text: "Second", streaming: false, durationMs: 1_000, redacted: false },
    { kind: "message", text: "Done." },
  ]);
});

test("text before a thinking block stays above it, and later text starts below", () => {
  const h = fixture();
  h.text("Intro.");
  h.start(1, 0);
  h.end(1, "Then think.", 1);
  h.text("Outro.");
  expect(h.rows().map((row) => row.kind)).toEqual(["message", "thinking", "message"]);
});

test("a block pi never ended is closed by the run's end, keeping its streamed text", () => {
  const h = fixture();
  h.start(0, 0);
  h.delta(0, "Halfway ");
  h.send({
    type: "runFailed",
    sessionRef,
    timestamp: at(5),
    error: { message: "Request was aborted" },
  });
  expect(h.rows()[0]).toEqual({
    kind: "thinking",
    text: "Halfway",
    streaming: false,
    durationMs: 5_000,
    redacted: false,
  });
});

test("a delta for no streaming block changes nothing", () => {
  const h = fixture();
  h.delta(0, "orphan");
  expect(h.transcript.get(key)).toBeUndefined();
});

test("thinking deltas publish on the streaming interval, like reply text", () => {
  expect(
    shouldDeferStreamingUiPublish(
      { type: "assistantThinkingDelta", sessionRef, timestamp: at(0), contentIndex: 0, text: "x" },
      undefined,
    ),
  ).toBe(true);
  expect(
    shouldDeferStreamingUiPublish(
      { type: "assistantThinkingStarted", sessionRef, timestamp: at(0), contentIndex: 0 },
      undefined,
    ),
  ).toBe(false);
});

test("a reloaded transcript keeps its thinking items", () => {
  const items = timelineFromDriverTranscript(
    [
      {
        kind: "thinking",
        id: "entry:thinking:0",
        createdAt: at(0),
        text: "Reason",
        durationMs: 4_000,
        sourceMessageId: "entry",
      },
      { kind: "message", id: "entry", role: "assistant", text: "Answer", createdAt: at(0) },
    ],
    new Map(),
  );
  expect(items.map((item) => item.kind)).toEqual(["thinking", "message"]);
});

test("Hidden leaves thinking out, and the Worked-for marker sits above the reply's reasoning", () => {
  const transcript: TimelineTranscriptItem[] = [
    { kind: "message", id: "u", role: "user", text: "Q", createdAt: at(0) },
    { kind: "thinking", id: "t", text: "Reason", createdAt: at(1), durationMs: 2_000 },
    { kind: "message", id: "a", role: "assistant", text: "A", createdAt: at(5) },
  ];
  expect(buildDisplayTimelineItems(transcript).map((item) => item.id)).toEqual([
    "u",
    "turn-marker:u",
    "t",
    "a",
  ]);
  expect(
    buildDisplayTimelineItems(transcript, { hideThinking: true }).map((item) => item.id),
  ).toEqual(["u", "turn-marker:u", "a"]);
});

test("the Show thinking setting defaults to collapsed and rejects unknown values", () => {
  expect(DEFAULT_THINKING_DISPLAY).toBe("collapsed");
  expect(parseThinkingDisplay("expanded")).toBe("expanded");
  expect(parseThinkingDisplay("hidden")).toBe("hidden");
  expect(parseThinkingDisplay("collapsed")).toBe("collapsed");
  expect(parseThinkingDisplay(null)).toBe("collapsed");
  expect(parseThinkingDisplay("shown")).toBe("collapsed");
});
