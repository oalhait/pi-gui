import type {
  SessionTranscriptCard,
  SessionTranscriptCustomMessage,
  SessionTranscriptMessage,
  SessionTranscriptPin,
  SessionTranscriptRole,
  SessionTranscriptThinking,
} from "@pi-gui/session-driver";
import type { TurnChangeSummary } from "./review";

export type SessionRole = SessionTranscriptRole;
export type TimelineTone = "neutral" | "success" | "warning" | "error";
export type TimelineToolStatus = "running" | "success" | "error";
export type TimelineSummaryPresentation = "inline" | "divider";

export interface TimelineActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly tone?: TimelineTone;
}

export interface TimelineToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: TimelineToolStatus;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly createdAt: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface TimelineSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly metadata?: string;
  readonly presentation: TimelineSummaryPresentation;
}

/**
 * A reasoning block. `streaming` is set only while a live block is still arriving; its
 * `createdAt` is when the block started, so the row can tick its elapsed time.
 */
export interface TimelineThinking extends SessionTranscriptThinking {
  readonly streaming?: boolean;
  /** While streaming, the block's index in the assistant message content. */
  readonly streamingContentIndex?: number;
}

export type TranscriptMessage =
  | SessionTranscriptMessage
  | TimelineThinking
  | SessionTranscriptCustomMessage
  | SessionTranscriptCard
  | SessionTranscriptPin
  | TimelineActivity
  | TimelineToolCall
  | TimelineSummary;

/**
 * What the conversation timeline draws: the transcript without its pins, which show above the
 * composer. The renderer splits them off once, so a pin reaching the timeline fails typecheck.
 */
export type TimelineTranscriptItem = Exclude<TranscriptMessage, SessionTranscriptPin>;

/**
 * A derived, view-only marker inserted between turns to show how long the agent
 * worked on the preceding user prompt. Never persisted or produced by the store;
 * the timeline computes it from real message/tool timestamps at render time, so
 * it is kept out of {@link TranscriptMessage} to avoid leaking into store code.
 */
export interface TimelineTurnMarker {
  readonly kind: "turn-marker";
  readonly id: string;
  readonly durationMs: number;
}

/** A derived, view-only card listing the files one captured turn changed, placed after that turn. */
export interface TimelineTurnChanges {
  readonly kind: "turn-changes";
  readonly id: string;
  readonly turn: TurnChangeSummary;
}

/**
 * A derived, view-only "Working" line kept at the bottom of the turn that is still running, so
 * it stays under the latest tool row or reply text. `startedAt` is when the run began.
 */
export interface TimelineWorkingIndicator {
  readonly kind: "working";
  readonly id: "working-indicator";
  readonly startedAt?: string;
}

export type DisplayTimelineItem =
  TimelineTranscriptItem | TimelineTurnMarker | TimelineTurnChanges | TimelineWorkingIndicator;
