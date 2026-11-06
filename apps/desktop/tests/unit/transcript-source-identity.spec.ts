import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";
import {
  appendAssistantDelta,
  appendUserMessage,
  applyTimelineEvent,
  resolveUserEntryId,
  trackUnpersistedUserMessage,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-09-22T19:00:00.000Z";

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
  const append = (text: string) =>
    appendAssistantDelta(transcript, state.activeAssistantMessageBySession, sessionRef, text);
  const ended = () => send({ type: "assistantMessageEnded", sessionRef, timestamp });
  const persisted = (sourceMessageId: string) =>
    send({ type: "assistantMessagePersisted", sessionRef, timestamp, sourceMessageId });
  return { transcript, state, send, append, ended, persisted };
}

test("persisted source identity attaches to its ended live row without replacing display IDs or metrics", () => {
  const h = fixture();
  h.state.runMetricsBySession.set(key, {
    startedAt: timestamp,
    toolCount: 3,
    searchCount: 1,
    fileCount: 2,
  });
  h.append("First response");
  const first = h.transcript.get(key)![0]!;
  h.ended();
  h.persisted("native-first");
  h.append("Continued response");
  const second = h.transcript.get(key)![1]!;
  h.ended();
  h.persisted("native-second");
  expect(h.transcript.get(key)).toEqual([
    { ...first, sourceMessageId: "native-first" },
    { ...second, sourceMessageId: "native-second" },
  ]);
  expect(h.state.runMetricsBySession.get(key)?.toolCount).toBe(3);
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
});

test("tool-only and repeated persisted events cannot attach to an earlier assistant row", () => {
  const h = fixture();
  h.append("Before tool");
  h.ended();
  h.persisted("native-text");
  const previous = h.transcript.get(key);
  h.ended(); // This assistant emitted tools, but no visible text.
  h.persisted("native-tool-only");
  h.persisted("duplicate-native-event");
  expect(h.transcript.get(key)).toEqual(previous);
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
});

test("a close discards a pending association before any later persisted event", () => {
  const h = fixture();
  h.append("Interrupted response");
  h.ended();
  h.send({ type: "sessionClosed", sessionRef, timestamp, reason: "manual" });
  h.persisted("late-native-id");
  expect(h.state.pendingAssistantMessageBySession.has(key)).toBe(false);
  expect(h.transcript.get(key)![0]).not.toHaveProperty("sourceMessageId");
});

test("Stop preserves the live identity while already-enqueued host events are delayed", async () => {
  const h = fixture();
  h.append("Partial response before Stop");
  const originalId = h.transcript.get(key)![0]!.id;
  // Only the cancellation path is exercised; the event queue intentionally has not drained.
  const owner = createConversationOwner({
    initialize: async () => undefined,
    driver: { cancelCurrentRun: async () => undefined },
    conversationState: {
      activeAssistantMessageBySession: h.state.activeAssistantMessageBySession,
      sessionErrorsBySession: new Map(),
    },
    clearConversationError: () => undefined,
    schedulePersistUiState: () => undefined,
    emit: () => ({}),
    withSessionError: (_ref: unknown, error: unknown) => {
      throw error;
    },
  } as never);
  await owner.cancelCurrentRun(sessionRef);
  expect(h.state.activeAssistantMessageBySession.get(key)).toBe(originalId);
  h.ended();
  h.persisted("native-stopped-response");
  expect(h.transcript.get(key)![0]).toMatchObject({
    id: originalId,
    sourceMessageId: "native-stopped-response",
  });
});

test("an extension's custom message lands as its own row between replies, once", () => {
  const h = fixture();
  h.append("First reply");
  const item = {
    kind: "custom" as const,
    id: "entry-1",
    createdAt: timestamp,
    customType: "ci-status",
    text: "**Build** passed",
  };
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item });
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item });
  h.append("Second reply");
  expect(
    h.transcript.get(key)!.map((row) => (row.kind === "message" ? row.text : row.kind)),
  ).toEqual(["First reply", "custom", "Second reply"]);
});

test("a card or its error row appended mid-reply goes above the streaming reply, which keeps one row", () => {
  const h = fixture();
  h.append("Checking CI.");
  const card = {
    kind: "card" as const,
    id: "entry-card",
    createdAt: timestamp,
    card: { title: "CI failed", tone: "error" as const, rows: [], actions: [] },
  };
  const broken = {
    kind: "custom" as const,
    id: "entry-broken",
    createdAt: timestamp,
    customType: "pi-gui.card",
    text: "This card was not shown: it needs a non-empty string `title`.",
  };
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: card });
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: broken });
  h.append(" Done.");
  expect(h.transcript.get(key)!.map((row) => (row.kind === "message" ? row.text : row.id))).toEqual(
    ["entry-card", "entry-broken", "Checking CI. Done."],
  );
});

test("a keyed card's later write updates it where it is, even mid-reply, without splitting the reply", () => {
  const h = fixture();
  const keyed = (title: string) => ({
    kind: "card" as const,
    id: "card:ci",
    createdAt: timestamp,
    card: { key: "ci", title, tone: "neutral" as const, rows: [], actions: [] },
  });
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: keyed("CI running") });
  h.append("Rerunning.");
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: keyed("CI passed") });
  h.append(" All green.");
  const rows = h.transcript.get(key)!;
  expect(rows.map((row) => (row.kind === "message" ? row.text : row.id))).toEqual([
    "card:ci",
    "Rerunning. All green.",
  ]);
  expect(rows[0]?.kind === "card" && rows[0].card.title).toBe("CI passed");
});

test("a pin appended mid-reply never splits the streaming reply, and later writes replace it", () => {
  const h = fixture();
  const pin = (title: string | null, createdAt = timestamp) => ({
    kind: "pin" as const,
    id: "pin:todo",
    createdAt,
    card: title ? { key: "todo", title, tone: "neutral" as const, rows: [], actions: [] } : null,
  });
  const other = { ...pin("CI"), id: "pin:ci" };
  h.append("Planning.");
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: pin("Plan: 0 done") });
  h.append(" Step one.");
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: other });
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: pin("Plan: 1 done") });
  h.append(" Step two.");
  const rows = () =>
    h.transcript
      .get(key)!
      .map((row) =>
        row.kind === "message" ? row.text : row.kind === "pin" ? (row.card?.title ?? row.id) : "",
      );
  expect(rows()).toEqual(["Planning. Step one. Step two.", "Plan: 1 done", "CI"]);

  // A removal keeps the row so a later write replaces it; a write after removal is a new pin.
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: pin(null) });
  expect(rows()).toEqual(["Planning. Step one. Step two.", "pin:todo", "CI"]);
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: pin("New plan") });
  expect(rows()).toEqual(["Planning. Step one. Step two.", "CI", "New plan"]);
});

test("a malformed pin's error row goes above the streaming reply and updates in place", () => {
  const h = fixture();
  const broken = (text: string) => ({
    kind: "custom" as const,
    id: "pin-error:todo",
    createdAt: timestamp,
    customType: "pi-gui.pin",
    text,
  });
  h.append("Working.");
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: broken("first") });
  h.send({ type: "transcriptItemAppended", sessionRef, timestamp, item: broken("second") });
  h.append(" Done.");
  expect(
    h.transcript.get(key)!.map((row) => (row.kind === "custom" ? row.text : row.kind)),
  ).toEqual(["second", "message"]);
});

test("persisted user entry IDs attach to the live user rows they were sent as, in order", () => {
  const h = fixture();
  const track = (text: string) => {
    const id = appendUserMessage(h.transcript, sessionRef, text);
    trackUnpersistedUserMessage(h.state.unpersistedUserMessagesBySession, sessionRef, id);
    return id;
  };
  const userPersisted = (sourceMessageId: string, text: string) =>
    h.send({ type: "userMessagePersisted", sessionRef, timestamp, sourceMessageId, text });
  const first = track("continue");
  const second = track("continue");
  const skill = track("/skill:review the diff");
  userPersisted("entry-first", "continue");
  userPersisted("entry-second", "continue");
  // Pi expanded the skill, so the persisted text differs; the oldest waiting row takes it.
  userPersisted("entry-skill", "<skill>…</skill> the diff");
  userPersisted("entry-stray", "continue");
  const sourceIds = new Map(
    h.transcript
      .get(key)!
      .map((item) => [item.id, item.kind === "message" ? item.sourceMessageId : undefined]),
  );
  expect(sourceIds.get(first)).toBe("entry-first");
  expect(sourceIds.get(second)).toBe("entry-second");
  expect(sourceIds.get(skill)).toBe("entry-skill");
  expect(h.state.unpersistedUserMessagesBySession.get(key)).toEqual([]);
});

test("an edit finds the entry of a row Pi never identified on the current branch", () => {
  const live = (id: string, text: string, sourceMessageId?: string): TranscriptMessage => ({
    kind: "message",
    id,
    role: "user",
    text,
    createdAt: timestamp,
    ...(sourceMessageId ? { sourceMessageId } : {}),
  });
  const entry = (id: string, text: string) => ({
    kind: "message" as const,
    id,
    sourceMessageId: id,
    role: "user" as const,
    text,
    createdAt: timestamp,
  });
  const rows = [
    live("entry-1", "First", "entry-1"),
    { ...live("reply", "Answer"), role: "assistant" as const },
    live("row-2", "Can you answer the question above"),
    live("row-3", "Can you answer the question above"),
  ];
  const branch = [
    entry("entry-1", "First"),
    entry("entry-2", "Can you answer the question above"),
    entry("entry-3", "Can you answer the question above"),
  ];
  // Identified rows need no branch, whether named by row or entry ID.
  expect(resolveUserEntryId(rows, [], "entry-1")).toBe("entry-1");
  // Same text twice: the place counted from the newest tells them apart.
  expect(resolveUserEntryId(rows, branch, "row-2")).toBe("entry-2");
  expect(resolveUserEntryId(rows, branch, "row-3")).toBe("entry-3");
  // A row queued behind them shifts the places; its unique text still finds it.
  const queued = [...rows, live("row-4", "Queued later")];
  expect(resolveUserEntryId(queued, [...branch, entry("entry-4", "Queued later")], "row-4")).toBe(
    "entry-4",
  );
  expect(resolveUserEntryId(rows, [], "row-2")).toBeUndefined();
  expect(resolveUserEntryId(rows, branch, "unknown")).toBeUndefined();
  expect(resolveUserEntryId([live("row-x", "Never written")], branch, "row-x")).toBeUndefined();
});
