import { useMemo } from "react";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { SessionRecord } from "../../../../contracts/desktop-state";
import type { TimelineTranscriptItem } from "../../../../contracts/timeline-types";
import type { TurnChangeSummary } from "../../../../contracts/review";
import { useThinkingDisplay } from "../thinking-display";
import { buildDisplayTimelineItems, largeContextForWait } from "../timeline-turns";

/**
 * The selected thread's display rows: its transcript with turn markers, change cards and,
 * while it runs, the Working line (or the lost-connection line while it waits to resume, or
 * the waiting-for-the-model line before the model's first output).
 */
export function useTimelineRows(
  transcript: readonly TimelineTranscriptItem[],
  session: SessionRecord | undefined,
  turnChanges: readonly TurnChangeSummary[],
  usage?: SessionUsageSnapshot | undefined,
) {
  const [thinkingDisplay] = useThinkingDisplay();
  const running = session?.status === "running";
  const runningSince = running ? session?.runningSince : undefined;
  const connectionRetry = running ? session?.connectionRetry : undefined;
  const modelWait = running ? session?.modelWait : undefined;
  // Usage refreshes at turn ends, so during a wait it describes the request being sent.
  const largeContext = useMemo(() => largeContextForWait(modelWait, usage), [modelWait, usage]);
  return useMemo(
    () =>
      buildDisplayTimelineItems(transcript, {
        lastTurnRunning: running,
        runningSince,
        connectionRetry,
        modelWait,
        largeContext,
        turnChanges,
        hideThinking: thinkingDisplay === "hidden",
      }),
    [
      transcript,
      running,
      runningSince,
      connectionRetry,
      modelWait,
      largeContext,
      turnChanges,
      thinkingDisplay,
    ],
  );
}
