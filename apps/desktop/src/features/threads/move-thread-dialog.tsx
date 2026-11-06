import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { trapDialogFocus } from "../../ui/dialog-focus";
import type { ThreadMenuState } from "./hooks/use-thread-actions";

/** The Move dialog for whichever thread a menu opened it for, if any. */
export function MoveThreadDialogHost({
  threadMenu,
  destinations,
}: {
  readonly threadMenu: ThreadMenuState;
  readonly destinations: readonly WorkspaceRecord[];
}) {
  const move = threadMenu.move;
  if (!move) return null;
  return (
    <MoveThreadDialog
      threadTitle={move.subject.session.title}
      currentWorkspaceId={move.subject.workspaceId}
      destinations={destinations}
      submitting={move.submitting}
      error={move.error}
      onClose={threadMenu.closeMove}
      onSubmit={threadMenu.submitMove}
    />
  );
}

interface MoveThreadDialogProps {
  readonly threadTitle: string;
  /** The workspace the thread is in now; it is listed but cannot be chosen. */
  readonly currentWorkspaceId: string;
  /** Project folders, plus the Chats workspace offered as "No folder". */
  readonly destinations: readonly WorkspaceRecord[];
  readonly submitting: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSubmit: (destinationWorkspaceId: string) => void;
}

function MoveThreadDialog({
  threadTitle,
  currentWorkspaceId,
  destinations,
  submitting,
  error,
  onClose,
  onSubmit,
}: MoveThreadDialogProps) {
  // "No folder" first, then the folders in sidebar order.
  const options = [
    ...destinations.filter((workspace) => workspace.kind === "chats"),
    ...destinations.filter((workspace) => workspace.kind !== "chats"),
  ];
  const [choice, setChoice] = useState(
    () => options.find((workspace) => workspace.id !== currentWorkspaceId)?.id ?? "",
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        aria-modal="true"
        aria-labelledby="move-thread-title"
        className="tree-modal tree-modal--compact"
        data-testid="move-thread-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">Move thread</div>
            <h2 className="tree-modal__title" id="move-thread-title">
              {threadTitle}
            </h2>
          </div>
          <button
            aria-label="Close move dialog"
            className="tree-modal__close"
            disabled={submitting}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="tree-modal__error error-banner" data-testid="move-thread-error">
            {error}
          </div>
        ) : null}

        <div className="tree-modal__summary-step">
          <div className="tree-modal__summary-copy">
            The conversation comes along. Its tools work in the new folder from the next message;
            files it already changed stay where they are.
          </div>

          <fieldset className="move-thread__options" disabled={submitting}>
            <legend className="sr-only">Destination</legend>
            {options.map((workspace) => {
              const current = workspace.id === currentWorkspaceId;
              const label = workspace.kind === "chats" ? "No folder" : workspace.name;
              return (
                <label
                  key={workspace.id}
                  className={`move-thread__option${current ? " move-thread__option--current" : ""}`}
                >
                  <input
                    type="radio"
                    name="move-thread-destination"
                    value={workspace.id}
                    checked={choice === workspace.id}
                    disabled={current}
                    onChange={() => setChoice(workspace.id)}
                  />
                  <span>{label}</span>
                  {current ? <span className="move-thread__current">Current</span> : null}
                </label>
              );
            })}
          </fieldset>

          <div className="tree-modal__footer">
            <div className="tree-modal__hint">Only an idle thread can move.</div>
            <div className="tree-modal__actions">
              <button
                className="button button--secondary"
                disabled={submitting}
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                data-testid="move-thread-confirm"
                disabled={submitting || !choice}
                type="button"
                onClick={() => onSubmit(choice)}
              >
                {submitting ? "Moving…" : "Move"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
