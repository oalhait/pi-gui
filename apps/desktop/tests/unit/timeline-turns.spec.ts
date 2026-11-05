import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  buildDisplayTimelineItems,
  LARGE_CONTEXT_TOKENS,
  largeContextForWait,
} from "../../src/features/conversation/timeline-turns";

const base = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

function message(id: string, role: "user" | "assistant", seconds: number): TranscriptMessage {
  return { kind: "message", id, role, text: id, createdAt: at(seconds) };
}

function tool(id: string, seconds: number): TranscriptMessage {
  return {
    kind: "tool",
    id,
    callId: id,
    toolName: "bash",
    status: "success",
    label: id,
    createdAt: at(seconds),
  };
}

const ids = (transcript: readonly TranscriptMessage[], lastTurnRunning = false) =>
  buildDisplayTimelineItems(transcript, { lastTurnRunning }).map((item) => item.id);

test("the marker sits directly above the turn's final assistant reply", () => {
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 2),
    tool("t1", 5),
    tool("t2", 9),
    message("a2", "assistant", 12),
    message("u2", "user", 20),
    tool("t3", 23),
    message("a3", "assistant", 30),
  ];
  expect(ids(transcript)).toEqual([
    "u1",
    "a1",
    "t1",
    "t2",
    "turn-marker:u1",
    "a2",
    "u2",
    "t3",
    "turn-marker:u2",
    "a3",
  ]);
  const markers = buildDisplayTimelineItems(transcript).filter(
    (item) => item.kind === "turn-marker",
  );
  expect(markers.map((marker) => marker.durationMs)).toEqual([12_000, 10_000]);
});

test("a turn without an assistant reply gets its marker at the end of the turn", () => {
  expect(ids([message("u1", "user", 0), tool("t1", 4), message("u2", "user", 10)])).toEqual([
    "u1",
    "t1",
    "turn-marker:u1",
    "u2",
  ]);
});

test("the running turn has no marker until it finishes", () => {
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 5),
    message("u2", "user", 10),
    message("a2", "assistant", 15),
  ];
  expect(ids(transcript, true)).toEqual([
    "u1",
    "turn-marker:u1",
    "a1",
    "u2",
    "a2",
    "working-indicator",
  ]);
  expect(ids(transcript, false)).toEqual([
    "u1",
    "turn-marker:u1",
    "a1",
    "u2",
    "turn-marker:u2",
    "a2",
  ]);
});

test("turns shorter than a second get no marker", () => {
  expect(ids([message("u1", "user", 0), message("a1", "assistant", 0.5)])).toEqual(["u1", "a1"]);
});

test("an extension message or card posted after the run neither stretches the marker nor moves it", () => {
  const custom = (id: string, seconds: number): TranscriptMessage => ({
    kind: "custom",
    id,
    customType: "ci-status",
    text: id,
    createdAt: at(seconds),
  });
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 2),
    custom("steered", 3),
    message("a2", "assistant", 6),
    custom("late-ci-report", 600),
    {
      kind: "card",
      id: "late-ci-card",
      createdAt: at(900),
      card: { title: "CI passed", tone: "success", rows: [], actions: [] },
    },
  ];
  expect(ids(transcript)).toEqual([
    "u1",
    "a1",
    "steered",
    "turn-marker:u1",
    "a2",
    "late-ci-report",
    "late-ci-card",
  ]);
  const marker = buildDisplayTimelineItems(transcript).find((item) => item.kind === "turn-marker");
  expect(marker?.durationMs).toBe(6_000);
});

test("a keyed card updated long after its turn does not stretch that turn's marker", () => {
  const transcript: TranscriptMessage[] = [
    message("u1", "user", 0),
    {
      kind: "card",
      id: "card:ci",
      // The card's latest write, an hour and a half after the turn ended.
      createdAt: at(5_400),
      card: { key: "ci", title: "CI passed", tone: "success", rows: [], actions: [] },
    },
    message("a1", "assistant", 60),
  ];
  const marker = buildDisplayTimelineItems(transcript).find((item) => item.kind === "turn-marker");
  expect(marker?.durationMs).toBe(60_000);
});

test("the working line follows the running turn's newest row and carries the run start", () => {
  const transcript = [message("u1", "user", 0), message("a1", "assistant", 2), tool("t1", 5)];
  const items = buildDisplayTimelineItems(transcript, {
    lastTurnRunning: true,
    runningSince: at(1),
  });
  expect(items.map((item) => item.id)).toEqual(["u1", "a1", "t1", "working-indicator"]);
  expect(items.at(-1)).toEqual({ kind: "working", id: "working-indicator", startedAt: at(1) });

  const grown = buildDisplayTimelineItems([...transcript, tool("t2", 8)], {
    lastTurnRunning: true,
  });
  expect(grown.map((item) => item.id)).toEqual(["u1", "a1", "t1", "t2", "working-indicator"]);
  expect(ids(transcript)).not.toContain("working-indicator");
});

test("a run waiting out a lost connection carries the retry on its working line", () => {
  const retry = { attempt: 1, retryAt: at(30), error: "Request timed out." };
  const items = buildDisplayTimelineItems([message("u1", "user", 0)], {
    lastTurnRunning: true,
    runningSince: at(0),
    connectionRetry: retry,
  });
  expect(items.at(-1)).toEqual({
    kind: "working",
    id: "working-indicator",
    startedAt: at(0),
    connectionRetry: retry,
  });
});

test("a turn waiting for the model carries the wait and its large-context note", () => {
  const modelWait = { since: at(5) };
  const largeContext = { tokens: 407_000, cacheExpired: true };
  const items = buildDisplayTimelineItems([message("u1", "user", 0)], {
    lastTurnRunning: true,
    runningSince: at(0),
    modelWait,
    largeContext,
  });
  expect(items.at(-1)).toEqual({
    kind: "working",
    id: "working-indicator",
    startedAt: at(0),
    modelWait,
    largeContext,
  });
  // The note belongs to a wait; without one the line is the plain Working line.
  const working = buildDisplayTimelineItems([message("u1", "user", 0)], {
    lastTurnRunning: true,
    runningSince: at(0),
    largeContext,
  });
  expect(working.at(-1)).toEqual({ kind: "working", id: "working-indicator", startedAt: at(0) });
});

test("only a large request with a lapsed or unknown prompt cache gets the note", () => {
  const wait = { since: at(600) };
  const usage = (tokens: number, expiresAt?: string) => ({
    context: { tokens, contextWindow: 1_000_000 },
    cache: expiresAt ? { lifetimeSeconds: 300, expiresAt } : {},
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    subscription: false,
  });
  expect(largeContextForWait(wait, usage(407_000, at(300)))).toEqual({
    tokens: 407_000,
    cacheExpired: true,
  });
  expect(largeContextForWait(wait, usage(407_000))).toEqual({
    tokens: 407_000,
    cacheExpired: false,
  });
  // A warm cache answers quickly, a small context needs no note, and a retry says its own.
  expect(largeContextForWait(wait, usage(407_000, at(700)))).toBeUndefined();
  expect(largeContextForWait(wait, usage(LARGE_CONTEXT_TOKENS - 1))).toBeUndefined();
  expect(
    largeContextForWait(
      { ...wait, retry: { attempt: 1, maxAttempts: 3, error: "overloaded" } },
      usage(407_000),
    ),
  ).toBeUndefined();
  expect(largeContextForWait(undefined, usage(407_000))).toBeUndefined();
});
