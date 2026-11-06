import { isCardEntryItem, sessionKey } from "@pi-gui/session-driver";
import type { SessionTranscriptItem, SessionTranscriptPin } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import { randomUUID } from "node:crypto";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import type { TimelineThinking } from "../../contracts/timeline-types";
import {
  extensionToolRowLabel,
  toolInputSummary,
  truncate,
  type ExtensionToolLabels,
} from "../../contracts/tool-labels";
import {
  formatElapsedDuration,
  makeActivityItem,
  makeSummaryItem,
  makeToolItem,
  makeTranscriptMessage,
  makeTranscriptMessageWithAttachments,
} from "../application/app-store-utils";
import {
  archiveChildThreadsToolName,
  createChildThreadToolName,
  listThreadsToolName,
  orchestrationToolNames,
  readThreadToolName,
  sendMessageToThreadToolName,
} from "../orchestration/orchestration-runtime";
import { renameThreadToolName } from "../workspace/thread-title-runtime";

export interface RunMetrics {
  readonly startedAt: string;
  /** The run these counts belong to; a Stop settles a run without runCompleted. */
  readonly runId?: string;
  toolCount: number;
  searchCount: number;
  fileCount: number;
}

interface TimelineRuntimeState {
  readonly runMetricsBySession: Map<string, RunMetrics>;
  readonly runningSinceBySession: Map<string, string>;
  readonly activeAssistantMessageBySession: Map<string, string>;
  readonly pendingAssistantMessageBySession: Map<string, string>;
  /** IDs of user rows sent this run, oldest first, still waiting for their session entry ID. */
  readonly unpersistedUserMessagesBySession: Map<string, string[]>;
  /** Labels of the tools the session's folder extensions registered. */
  readonly extensionToolLabels: (sessionRef: SessionRef) => ExtensionToolLabels;
}

export function timelineFromDriverTranscript(
  items: readonly SessionTranscriptItem[],
  extensionToolLabels: ExtensionToolLabels,
): TranscriptMessage[] {
  return items.map((item) => {
    if (item.kind !== "tool") {
      return item;
    }
    const detail = detailFromOutput(item.output);
    const extensionLabel = extensionToolLabels.get(item.toolName);
    return {
      ...makeToolItem(
        item.callId,
        item.toolName,
        item.status,
        extensionLabel === undefined
          ? toolLabel(item.toolName, item.input)
          : extensionToolRowLabel(extensionLabel, item.input),
        {
          ...(detail !== undefined ? { detail } : {}),
          ...(item.input !== undefined ? { input: item.input } : {}),
          ...(item.output !== undefined ? { output: item.output } : {}),
        },
      ),
      createdAt: item.createdAt,
    };
  });
}

export function appendUserMessage(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  sessionRef: SessionRef,
  text: string,
  attachments: NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> = [],
): string {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const message =
    attachments.length > 0
      ? makeTranscriptMessageWithAttachments("user", text, attachments)
      : makeTranscriptMessage("user", text);
  transcript.push(message);
  transcriptCache.set(key, transcript);
  return message.id;
}

/** Remember a user row sent in this run until Pi reports the entry it persisted it as. */
export function trackUnpersistedUserMessage(
  unpersistedUserMessagesBySession: Map<string, string[]>,
  sessionRef: SessionRef,
  messageId: string,
): void {
  const key = sessionKey(sessionRef);
  const pending = unpersistedUserMessagesBySession.get(key) ?? [];
  if (!pending.includes(messageId))
    unpersistedUserMessagesBySession.set(key, [...pending, messageId]);
}

type UserRow = Extract<SessionTranscriptItem, { kind: "message" }>;

function userRows(transcript: readonly (TranscriptMessage | SessionTranscriptItem)[]): UserRow[] {
  return transcript.filter(
    (item): item is UserRow => item.kind === "message" && item.role === "user",
  );
}

/**
 * The session entry ID of the user row someone asked to edit, given by its row ID or entry ID.
 * A row sent in this app run gets its entry ID when Pi reports it (userMessagePersisted). One
 * that never got it is matched against Pi's current branch: the user entry at the same place
 * counting from the newest, if its text agrees, or else the only entry with that text.
 * Undefined when the row is unknown or nothing on the branch matches it.
 */
export function resolveUserEntryId(
  transcript: readonly TranscriptMessage[],
  branch: readonly SessionTranscriptItem[],
  messageId: string,
): string | undefined {
  const rows = userRows(transcript);
  const index = rows.findIndex((row) => row.id === messageId || row.sourceMessageId === messageId);
  const row = rows[index];
  if (!row) return undefined;
  if (row.sourceMessageId) return row.sourceMessageId;
  const entries = userRows(branch);
  const text = row.text.trim();
  const entryId = (entry: UserRow) => entry.sourceMessageId ?? entry.id;
  const samePlace = entries[entries.length - (rows.length - index)];
  if (samePlace && samePlace.text.trim() === text) return entryId(samePlace);
  const sameText = entries.filter((entry) => entry.text.trim() === text);
  return sameText.length === 1 ? entryId(sameText[0]!) : undefined;
}

export function appendQueuedUserMessage(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  sessionRef: SessionRef,
  message: SessionQueuedMessage,
): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const existingIndex = transcript.findIndex(
    (item) => item.kind === "message" && item.id === message.id,
  );
  const nextMessage = {
    kind: "message" as const,
    id: message.id,
    role: "user" as const,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        }
      : {}),
  };

  if (existingIndex >= 0) {
    transcript[existingIndex] = nextMessage;
  } else {
    transcript.push(nextMessage);
  }
  transcriptCache.set(key, transcript);
}

export function appendAssistantDelta(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
  text: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const activeId = activeAssistantMessageBySession.get(key);

  if (activeId) {
    const index = transcript.findIndex((message) => message.id === activeId);
    const current = index >= 0 ? transcript[index] : undefined;
    if (current?.kind === "message") {
      transcript[index] = {
        ...current,
        text: `${current.text}${text}`,
      };
    } else {
      const message = makeTranscriptMessage("assistant", text);
      transcript.push(message);
      activeAssistantMessageBySession.set(key, message.id);
    }
  } else {
    const message = makeTranscriptMessage("assistant", text);
    transcript.push(message);
    activeAssistantMessageBySession.set(key, message.id);
  }

  transcriptCache.set(key, transcript);
}

export function clearActiveAssistantMessage(
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
): void {
  activeAssistantMessageBySession.delete(sessionKey(sessionRef));
}

export function applyTimelineEvent(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  event: SessionDriverEvent,
  state: TimelineRuntimeState,
): void {
  if (event.type === "assistantDelta") {
    return;
  }

  const key = sessionKey(event.sessionRef);
  const previous = transcriptCache.get(key);
  const transcript = [...(previous ?? [])];
  const currentMetrics = state.runMetricsBySession.get(key);

  switch (event.type) {
    case "assistantThinkingStarted": {
      // Reply text after this block starts a new row below it, as a reload orders them.
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      transcript.push({
        kind: "thinking",
        id: randomUUID(),
        createdAt: event.timestamp,
        text: "",
        ...(event.redacted ? { redacted: true } : {}),
        streaming: true,
        streamingContentIndex: event.contentIndex,
      });
      break;
    }
    case "assistantThinkingDelta": {
      const index = streamingThinkingIndex(transcript, event.contentIndex);
      const current = transcript[index];
      if (current?.kind !== "thinking" || !event.text) return;
      transcript[index] = { ...current, text: `${current.text}${event.text}` };
      break;
    }
    case "assistantThinkingEnded": {
      const index = streamingThinkingIndex(transcript, event.contentIndex);
      const current = transcript[index];
      if (current?.kind !== "thinking") return;
      // pi's final content is authoritative over the streamed deltas.
      transcript[index] = endThinking(current, event.timestamp, {
        text: event.text,
        redacted: event.redacted === true || current.redacted === true,
      });
      break;
    }
    case "assistantMessageEnded": {
      endStreamingThinking(transcript, event.timestamp);
      const activeId = state.activeAssistantMessageBySession.get(key);
      if (activeId) state.pendingAssistantMessageBySession.set(key, activeId);
      else state.pendingAssistantMessageBySession.delete(key);
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      return;
    }
    case "assistantMessagePersisted": {
      const endedId = state.pendingAssistantMessageBySession.get(key);
      state.pendingAssistantMessageBySession.delete(key);
      const index = transcript.findIndex((item) => item.id === endedId);
      const ended = transcript[index];
      if (ended?.kind !== "message" || ended.role !== "assistant") return;
      transcript[index] = { ...ended, sourceMessageId: event.sourceMessageId };
      break;
    }
    case "sessionOpened":
      state.pendingAssistantMessageBySession.delete(key);
      transcript.push(
        makeActivityItem("Resumed session", { metadata: relativeDetail(event.timestamp) }),
      );
      break;
    case "sessionUpdated":
      // A Stop publishes only idle, so a new run id (not a missing start) begins a new run.
      if (
        event.snapshot.status === "running" &&
        event.snapshot.runningRunId &&
        (!state.runningSinceBySession.has(key) ||
          (currentMetrics?.runId !== undefined &&
            currentMetrics.runId !== event.snapshot.runningRunId))
      ) {
        state.runningSinceBySession.set(key, event.timestamp);
        state.runMetricsBySession.set(key, {
          startedAt: event.timestamp,
          runId: event.snapshot.runningRunId,
          toolCount: 0,
          searchCount: 0,
          fileCount: 0,
        });
      }
      break;
    case "queuedMessageStarted":
      state.pendingAssistantMessageBySession.delete(key);
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      appendQueuedUserMessage(transcriptCache, event.sessionRef, event.message);
      trackUnpersistedUserMessage(
        state.unpersistedUserMessagesBySession,
        event.sessionRef,
        event.message.id,
      );
      return;
    case "userMessagePersisted": {
      // Pi persists user messages in the order they were sent. Prefer the oldest waiting row
      // with the persisted text; Pi's skill and template expansion can change the text.
      const pending = (state.unpersistedUserMessagesBySession.get(key) ?? []).filter((id) =>
        transcript.some((item) => item.id === id),
      );
      const text = event.text.trim();
      const matched = pending.find((id) =>
        transcript.some(
          (item) => item.id === id && item.kind === "message" && item.text.trim() === text,
        ),
      );
      const rowId = matched ?? pending[0];
      state.unpersistedUserMessagesBySession.set(
        key,
        pending.filter((id) => id !== rowId),
      );
      const index = transcript.findIndex((item) => item.id === rowId);
      const row = transcript[index];
      if (row?.kind !== "message" || row.role !== "user") return;
      transcript[index] = { ...row, sourceMessageId: event.sourceMessageId };
      break;
    }
    case "toolStarted": {
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      const metrics = currentMetrics ?? {
        startedAt: event.timestamp,
        toolCount: 0,
        searchCount: 0,
        fileCount: 0,
      };
      metrics.toolCount += 1;
      const extensionLabel = state.extensionToolLabels(event.sessionRef).get(event.toolName);
      // Extension and thread tools count as tools: their names say nothing about files or searches.
      const nameHeuristics =
        extensionLabel === undefined &&
        !orchestrationToolNames.has(event.toolName) &&
        event.toolName !== renameThreadToolName;
      if (nameHeuristics && looksLikeSearch(event.toolName, event.input)) {
        metrics.searchCount += 1;
      }
      if (nameHeuristics && looksLikeFileExplore(event.toolName, event.input)) {
        metrics.fileCount += 1;
      }
      state.runMetricsBySession.set(key, metrics);
      upsertToolRow(
        transcript,
        event.callId,
        event.toolName,
        "running",
        extensionLabel === undefined
          ? toolLabel(event.toolName, event.input)
          : extensionToolRowLabel(extensionLabel, event.input),
        undefined,
        event.input,
      );
      break;
    }
    case "toolUpdated":
      upsertToolRow(
        transcript,
        event.callId,
        undefined,
        "running",
        undefined,
        event.text ?? progressLabel(event.progress),
      );
      break;
    case "toolFinished":
      upsertToolRow(
        transcript,
        event.callId,
        undefined,
        event.success ? "success" : "error",
        undefined,
        detailFromOutput(event.output),
        undefined,
        event.output,
      );
      break;
    case "runCompleted": {
      endStreamingThinking(transcript, event.timestamp);
      const metrics = currentMetrics;
      clearRunState(key, event.sessionRef, state);
      if (metrics) {
        const label = summaryLabel(metrics);
        if (label) {
          transcript.push(makeSummaryItem(label, { presentation: "inline" }));
        }
        // No "Worked for" row here: the renderer derives one per turn from
        // timestamps and places it above the turn's final reply.
      } else {
        transcript.push(
          makeSummaryItem("Completed", {
            presentation: "divider",
            metadata: relativeDetail(event.timestamp),
          }),
        );
      }
      break;
    }
    case "runFailed": {
      endStreamingThinking(transcript, event.timestamp);
      const metrics = currentMetrics;
      const latestToolError = metrics
        ? latestErrorToolDetail(transcript, metrics.startedAt)
        : undefined;
      const failureLabel = clearerRunFailureLabel(event.error.message, latestToolError);
      const failureDetail = event.error.code;
      clearRunState(key, event.sessionRef, state);
      transcript.push(
        makeActivityItem(failureLabel, {
          tone: "error",
          metadata: metrics ? workedForLabel(metrics.startedAt, event.timestamp) : undefined,
          detail: failureDetail,
        }),
      );
      break;
    }
    case "sessionClosed":
      endStreamingThinking(transcript, event.timestamp);
      clearRunState(key, event.sessionRef, state);
      transcript.push(makeActivityItem("Stopped", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "transcriptItemAppended": {
      // A pin shows above the composer, so it never ends or moves a streaming reply.
      if (event.item.kind === "pin") {
        upsertPin(transcript, event.item);
        break;
      }
      // Same id as the persisted entry, so a transcript reload replaces rather than duplicates it.
      // A keyed card (or a pin's error row) that is already shown updates where it is, as the
      // session file projects it.
      const existingIndex = transcript.findIndex((item) => item.id === event.item.id);
      if (existingIndex >= 0) {
        if (!isCardEntryItem(event.item)) return;
        transcript[existingIndex] = event.item;
        break;
      }
      // pi saves a streaming reply only when it ends, so a card (or its error row) appended
      // mid-reply comes before that reply in the session file. Place it there now so a reload never moves it.
      const streamingId = state.activeAssistantMessageBySession.get(key);
      const streamingIndex =
        isCardEntryItem(event.item) && streamingId
          ? transcript.findIndex((item) => item.id === streamingId)
          : -1;
      if (streamingIndex >= 0) {
        transcript.splice(streamingIndex, 0, event.item);
        break;
      }
      // Otherwise it lands between assistant messages like a tool row: the reply above keeps
      // its row and later text starts a new one below.
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      transcript.push(event.item);
      break;
    }
    case "hostUiRequest":
      // Notices show as toasts; only errors also stay in the transcript.
      if (event.request.kind === "notify" && event.request.level === "error") {
        transcript.push(
          makeActivityItem(event.request.message, {
            tone: "error",
            metadata: relativeDetail(event.timestamp),
          }),
        );
      }
      break;
    default:
      break;
  }

  // Keep the same array when nothing changed: the window skips publishing an unchanged
  // transcript by identity, and frequent events (title updates, running ticks) change nothing.
  if (previous ? sameItems(previous, transcript) : transcript.length === 0) return;
  transcriptCache.set(key, transcript);
}

/** The newest still-streaming thinking row for a content block of the current message. */
function streamingThinkingIndex(transcript: readonly TranscriptMessage[], contentIndex: number) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "thinking" && item.streaming) {
      if (item.streamingContentIndex === contentIndex) return index;
    }
  }
  return -1;
}

function endThinking(
  item: TimelineThinking,
  endedAt: string,
  final?: { readonly text: string; readonly redacted: boolean },
): TimelineThinking {
  const { streaming: _streaming, streamingContentIndex: _index, ...rest } = item;
  const durationMs = Date.parse(endedAt) - Date.parse(item.createdAt);
  const redacted = final?.redacted ?? item.redacted === true;
  return {
    ...rest,
    text: redacted ? "" : (final?.text ?? item.text).trim(),
    ...(redacted ? { redacted: true } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
  };
}

/** A message, run or session that ends closes any block pi never ended (an abort or error). */
function endStreamingThinking(transcript: TranscriptMessage[], endedAt: string): void {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "thinking" && item.streaming) transcript[index] = endThinking(item, endedAt);
  }
}

function sameItems(a: readonly TranscriptMessage[], b: readonly TranscriptMessage[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Replaces a pin's earlier write, as the projection does; a pin written after removal is new. */
function upsertPin(transcript: TranscriptMessage[], pin: SessionTranscriptPin): void {
  const index = transcript.findIndex((item) => item.id === pin.id);
  const existing = transcript[index];
  if (existing?.kind === "pin" && (existing.card || !pin.card)) {
    transcript[index] = pin;
    return;
  }
  if (index >= 0) transcript.splice(index, 1);
  transcript.push(pin);
}

function upsertToolRow(
  transcript: TranscriptMessage[],
  callId: string,
  toolName?: string,
  status?: "running" | "success" | "error",
  label?: string,
  detail?: string,
  input?: unknown,
  output?: unknown,
) {
  const index = transcript.findIndex((item) => item.kind === "tool" && item.callId === callId);
  const existing = index >= 0 ? transcript[index] : undefined;
  const existingTool = existing?.kind === "tool" ? existing : undefined;
  const next = makeToolItem(
    callId,
    toolName ?? existingTool?.toolName ?? "tool",
    status ?? existingTool?.status ?? "running",
    label ?? existingTool?.label ?? "Working",
    {
      detail: detail ?? existingTool?.detail,
      metadata: existingTool?.metadata,
      input: input ?? existingTool?.input,
      output: output ?? existingTool?.output,
    },
  );

  if (index >= 0) {
    transcript[index] = {
      ...next,
      createdAt: existing?.createdAt ?? next.createdAt,
    };
    return;
  }

  transcript.push(next);
}

function clearRunState(key: string, sessionRef: SessionRef, state: TimelineRuntimeState): void {
  clearActiveAssistantMessage(state.activeAssistantMessageBySession, sessionRef);
  state.pendingAssistantMessageBySession.delete(key);
  state.runningSinceBySession.delete(key);
  state.runMetricsBySession.delete(key);
}

function toolLabel(toolName: string, input: unknown): string {
  const detail = toolInputSummary(input);
  if (toolName === createChildThreadToolName) {
    return detail ? `Started child thread: ${detail}` : "Started child thread";
  }
  if (toolName === listThreadsToolName) {
    return "Listed threads";
  }
  if (toolName === readThreadToolName) {
    return detail ? `Read thread: ${detail}` : "Read thread";
  }
  if (toolName === sendMessageToThreadToolName) {
    return detail ? `Sent message to thread: ${detail}` : "Sent message to thread";
  }
  if (toolName === archiveChildThreadsToolName) {
    return "Archived child threads";
  }
  if (toolName === renameThreadToolName) {
    const title = isRecord(input) ? stringProperty(input, "title") : undefined;
    return title ? `Renamed chat to "${truncate(title, 80)}"` : "Renamed chat";
  }
  if (looksLikeSearch(toolName, input)) {
    return detail ? `Searched ${detail}` : `Searched with ${toolName}`;
  }
  if (looksLikeFileExplore(toolName, input)) {
    if (toolName.toLowerCase() === "read") {
      return detail ? `Read ${detail}` : "Read a file";
    }
    return detail ? `Explored ${detail}` : `Explored files with ${toolName}`;
  }
  return detail ? `Ran ${toolName}: ${detail}` : `Ran ${toolName}`;
}

function progressLabel(progress: number | undefined): string | undefined {
  if (progress === undefined) {
    return undefined;
  }
  if (progress <= 1) {
    return `${Math.round(progress * 100)}%`;
  }
  return String(progress);
}

function detailFromOutput(output: unknown): string | undefined {
  if (isRecord(output)) {
    const directError =
      stringProperty(output, "error") ??
      stringProperty(output, "message") ??
      stringProperty(output, "stderr");
    if (directError) {
      return summarizeToolDetail(directError);
    }
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    const text = output.content
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("\n")
      .trim();
    if (text) {
      return summarizeToolDetail(text);
    }
    // The row shows a tool's images itself, so the detail names them rather than dump their data.
    const images = output.content.flatMap((part) =>
      isRecord(part) && part.type === "image"
        ? [`[${stringProperty(part, "mimeType") ?? "image"} image]`]
        : [],
    );
    if (images.length > 0) {
      return summarizeToolDetail(images.join(" "));
    }
  }
  if (typeof output === "string") {
    return summarizeToolDetail(output);
  }
  if (output === undefined || output === null) {
    return undefined;
  }
  return truncate(JSON.stringify(output));
}

function looksLikeSearch(toolName: string, input: unknown): boolean {
  if (toolName.toLowerCase().includes("search")) {
    return true;
  }
  return typeof input === "string" && /https?:\/\/|site:|query|search/i.test(input);
}

function looksLikeFileExplore(toolName: string, input: unknown): boolean {
  if (/(read|glob|ls|list|open)/i.test(toolName)) {
    return true;
  }
  return typeof input === "string" && /\/|\.md|\.ts|file/i.test(input);
}

function summaryLabel(metrics: RunMetrics): string | undefined {
  const parts: string[] = [];
  if (metrics.fileCount > 0) {
    parts.push(`Explored ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}`);
  }
  if (metrics.searchCount > 0) {
    parts.push(`${metrics.searchCount} search${metrics.searchCount === 1 ? "" : "es"}`);
  }
  if (parts.length === 0 && metrics.toolCount > 0) {
    parts.push(`Used ${metrics.toolCount} tool${metrics.toolCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function workedForLabel(startedAt: string, endedAt: string): string {
  return `Worked for ${formatElapsedDuration(startedAt, endedAt)}`;
}

function relativeDetail(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function summarizeToolDetail(value: string): string {
  return truncate(value);
}

function latestErrorToolDetail(
  transcript: readonly TranscriptMessage[],
  runStartedAt: string,
): string | undefined {
  const runStartedAtMs = Date.parse(runStartedAt);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (Number.isFinite(runStartedAtMs) && Date.parse(item.createdAt) < runStartedAtMs) {
      break;
    }
    if (item.kind === "tool" && item.status === "error" && item.detail) {
      return item.detail;
    }
  }
  return undefined;
}

function clearerRunFailureLabel(message: string, latestToolError: string | undefined): string {
  if (!latestToolError) {
    return message;
  }
  const normalized = message.trim().toLowerCase();
  if (
    normalized === "terminated" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "run failed"
  ) {
    return latestToolError;
  }
  return message;
}

function stringProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
