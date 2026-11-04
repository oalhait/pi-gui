import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** The custom entry that records how long each thinking block of one assistant message took. */
export const THINKING_TIMING_CUSTOM_TYPE = "pi-gui.thinking-timing";

export interface ThinkingTimingData {
  /** The assistant message entry the blocks belong to. */
  readonly messageEntryId: string;
  /** Milliseconds per thinking block, keyed by its index in the message content. */
  readonly durationsMs: Readonly<Record<string, number>>;
}

/**
 * Pi saves thinking blocks without their timing, so a reloaded "Thought for 12s" would have
 * nothing to show. This measures each block from its `thinking_start` to `thinking_end` on a
 * monotonic clock and, once Pi has saved the message (turn_end), appends one custom entry
 * with those durations. Custom entries never reach the model's context.
 */
export function createThinkingTimingExtension(): ExtensionFactory {
  return (pi) => {
    let started = new Map<number, number>();
    let durations = new Map<number, number>();
    pi.on("message_start", (event) => {
      if (event.message.role !== "assistant") return;
      started = new Map();
      durations = new Map();
    });
    pi.on("message_update", (event) => {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start") {
        started.set(update.contentIndex, performance.now());
      } else if (update.type === "thinking_end") {
        const startedAt = started.get(update.contentIndex);
        if (startedAt !== undefined) {
          durations.set(update.contentIndex, Math.round(performance.now() - startedAt));
        }
      }
    });
    pi.on("turn_end", (event) => {
      if (durations.size === 0) return;
      const data: ThinkingTimingData = {
        messageEntryId: event.messageEntryId,
        durationsMs: Object.fromEntries(durations),
      };
      started = new Map();
      durations = new Map();
      pi.appendEntry(THINKING_TIMING_CUSTOM_TYPE, data);
    });
  };
}

/** Each message's saved block durations, from the timing entries on a branch. */
export function thinkingTimingsFromEntries(
  entries: readonly {
    readonly type: string;
    readonly customType?: string;
    readonly data?: unknown;
  }[],
): ReadonlyMap<string, ReadonlyMap<number, number>> {
  const timings = new Map<string, Map<number, number>>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== THINKING_TIMING_CUSTOM_TYPE) continue;
    const data = entry.data as Partial<ThinkingTimingData> | undefined;
    if (typeof data?.messageEntryId !== "string" || typeof data.durationsMs !== "object") continue;
    const durations = new Map<number, number>();
    for (const [index, ms] of Object.entries(data.durationsMs ?? {})) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
        durations.set(Number(index), ms);
    }
    timings.set(data.messageEntryId, durations);
  }
  return timings;
}
