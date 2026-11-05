import { useMemo } from "react";
import type { SessionRecord } from "../../../../contracts/desktop-state";
import type { TimelineTranscriptItem } from "../../../../contracts/timeline-types";
import type { TurnChangeSummary } from "../../../../contracts/review";
import { useThinkingDisplay } from "../thinking-display";
import { buildDisplayTimelineItems } from "../timeline-turns";

/**
 * The selected thread's display rows: its transcript with turn markers, change cards and,
 * while it runs, the Working line (or the lost-connection line while it waits to resume).
 */
export function useTimelineRows(
  transcript: readonly TimelineTranscriptItem[],
  session: SessionRecord | undefined,
  turnChanges: readonly TurnChangeSummary[],
) {
  const [thinkingDisplay] = useThinkingDisplay();
  const running = session?.status === "running";
  const runningSince = running ? session?.runningSince : undefined;
  const connectionRetry = running ? session?.connectionRetry : undefined;
  return useMemo(
    () =>
      buildDisplayTimelineItems(transcript, {
        lastTurnRunning: running,
        runningSince,
        connectionRetry,
        turnChanges,
        hideThinking: thinkingDisplay === "hidden",
      }),
    [transcript, running, runningSince, connectionRetry, turnChanges, thinkingDisplay],
  );
}
