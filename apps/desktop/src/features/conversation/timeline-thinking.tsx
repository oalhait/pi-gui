import { useState } from "react";
import type { TimelineThinking } from "../../../contracts/timeline-types";
import { ChevronRightIcon, CopyIcon } from "../../ui/icons";
import { formatElapsedDuration } from "./elapsed-duration";
import { MessageMarkdown } from "./message-markdown";

/**
 * A model's reasoning, Codex-style: "Thinking…" with the newest lines while it streams,
 * then one muted "Thought for 12s" line the user can expand. Redacted or encrypted
 * reasoning has no text, so it is the line alone.
 */
export function TimelineThinkingItem({
  item,
  expanded,
  onToggle,
}: {
  readonly item: TimelineThinking;
  readonly expanded: boolean;
  readonly onToggle?: (id: string, expanded: boolean) => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const hasText = item.text.trim().length > 0;
  const label = item.streaming
    ? "Thinking…"
    : item.durationMs === undefined
      ? "Thought"
      : `Thought for ${formatElapsedDuration(item.durationMs)}`;
  const showBody = expanded && hasText;
  const bodyId = `thinking-body-${item.id}`;

  return (
    <article
      className={`timeline-thinking${item.streaming ? " timeline-thinking--streaming" : ""}`}
      data-testid="timeline-thinking"
      data-state={item.streaming ? "streaming" : "done"}
    >
      {hasText ? (
        <button
          aria-controls={showBody ? bodyId : undefined}
          aria-expanded={showBody}
          className="timeline-thinking__header"
          type="button"
          onClick={() => onToggle?.(item.id, !showBody)}
        >
          <span className="timeline-thinking__label">{label}</span>
          <span
            aria-hidden="true"
            className={`timeline-thinking__chevron${showBody ? " timeline-thinking__chevron--expanded" : ""}`}
          >
            <ChevronRightIcon />
          </span>
        </button>
      ) : (
        <div className="timeline-thinking__header timeline-thinking__header--static">
          <span className="timeline-thinking__label">{label}</span>
        </div>
      )}
      {showBody ? (
        <div
          className={`timeline-thinking__body${item.streaming ? " timeline-thinking__body--live" : ""}`}
          id={bodyId}
        >
          {/* While streaming the box keeps a fixed height and shows the newest lines. */}
          <div className="timeline-thinking__text">
            <MessageMarkdown text={item.text} />
          </div>
          {item.streaming ? null : (
            <div className="timeline-thinking__actions">
              <button
                aria-label={copyState === "copied" ? "Copied" : "Copy thinking"}
                className="timeline-item__action"
                title={copyState === "failed" ? "Copy failed. Try again" : "Copy thinking"}
                type="button"
                onBlur={() => setCopyState("idle")}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(item.text)
                    .then(() => setCopyState("copied"))
                    .catch(() => setCopyState("failed"));
                }}
              >
                <CopyIcon />
              </button>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}
