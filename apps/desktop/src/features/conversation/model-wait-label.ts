import type { SessionModelWait } from "@pi-gui/session-driver";
import type { TimelineLargeContext } from "../../../contracts/timeline-types";
import { formatElapsedDuration } from "./elapsed-duration";

/** After this long with no output, the line says the provider may be stuck. */
export const SLOW_FIRST_OUTPUT_MS = 60_000;

export interface ModelWaitText {
  /** The status line, with elapsed time or the retry countdown. */
  readonly label: string;
  /** Quieter lines under it: a slow-start warning, then the large-context note. */
  readonly notes: readonly string[];
}

/**
 * What the Working line says while a turn waits for the model's first output: how long it has
 * waited, or that Pi is backing off before retrying a failed request and why.
 */
export function modelWaitText(
  wait: SessionModelWait,
  largeContext: TimelineLargeContext | undefined,
  nowMs: number,
): ModelWaitText {
  const elapsed = formatElapsedDuration(Math.max(0, nowMs - Date.parse(wait.since)));
  const retry = wait.retry;
  if (retry) {
    const attempt = `attempt ${retry.attempt} of ${retry.maxAttempts}`;
    const seconds = retry.retryAt ? Math.ceil((Date.parse(retry.retryAt) - nowMs) / 1000) : 0;
    const label =
      seconds > 0
        ? `Model request failed (${retryReason(retry.error)}). Retrying in ${seconds}s, ${attempt}`
        : `Retrying the model request, ${attempt} · ${elapsed}`;
    return { label, notes: [] };
  }
  const notes: string[] = [];
  if (nowMs - Date.parse(wait.since) >= SLOW_FIRST_OUTPUT_MS) {
    notes.push(
      "No response yet. The provider may be slow or overloaded; you can stop and send again.",
    );
  }
  if (largeContext) {
    const tokens = `${Math.round(largeContext.tokens / 1000)}k tokens`;
    notes.push(
      largeContext.cacheExpired
        ? `Large context (${tokens}) and its prompt cache has expired, so the first response may take a while.`
        : `Large context (${tokens}), so the first response may take a while.`,
    );
  }
  return { label: `Waiting for the model · ${elapsed}`, notes };
}

/** A short reason for a provider error, whose full text can be a JSON body. */
export function retryReason(error: string): string {
  if (/overload|\b529\b/i.test(error)) return "provider overloaded";
  if (/rate.?limit|\b429\b|too many requests/i.test(error)) return "rate limited";
  if (/time(d)?.?out/i.test(error)) return "timed out";
  if (/\b5\d\d\b|server error|internal error|unavailable|bad gateway/i.test(error)) {
    return "server error";
  }
  if (/network|connection|socket|econn|fetch failed|terminated/i.test(error)) {
    return "connection error";
  }
  const firstLine = error.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || "unknown error";
}
