import type { DisplayTimelineItem } from "../../../contracts/timeline-types";

const NONE: ReadonlySet<string> = new Set();

/**
 * The rows an edit of `editingMessageId` will replace once sent: the edited message and
 * everything after it. Empty when nothing is being edited or the row is not shown.
 */
export function supersededRowIds(
  rows: readonly DisplayTimelineItem[],
  editingMessageId: string | undefined,
): ReadonlySet<string> {
  if (!editingMessageId) return NONE;
  const start = rows.findIndex(
    (row) =>
      row.kind === "message" &&
      (row.id === editingMessageId || row.sourceMessageId === editingMessageId),
  );
  return start < 0 ? NONE : new Set(rows.slice(start).map((row) => row.id));
}
