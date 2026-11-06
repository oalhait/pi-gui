import type { SessionRecord } from "../../../contracts/desktop-state";
import {
  formatScheduledTaskRecurrence,
  formatScheduledTaskRowMeta,
  type ScheduledTaskRecord,
  type ScheduledTaskStatus,
} from "../../../contracts/scheduled-tasks";
import { ThreadActionItems } from "./thread-actions";
import type { ThreadAction } from "./thread-actions";
import type { ThreadMenuState } from "./hooks/use-thread-actions";
import type { OpenInEditorState } from "./hooks/use-open-in-editor";
import { formatRelativeTime } from "../../lib/string-utils";
import { EditorIcon } from "../../ui/editor-icons";
import { FolderIcon } from "../../ui/icons";

interface ChatHeaderActionsProps {
  readonly session: SessionRecord;
  readonly runningLabel: string;
  readonly threadMenu: ThreadMenuState;
  readonly actions: readonly ThreadAction[] | undefined;
  readonly openInEditor: OpenInEditorState;
  readonly onOpenFolder: () => void;
}

/**
 * The status text and the single "…" menu the topbar shows for an open thread.
 * The menu gathers where to open the project, the shared thread actions (so
 * every surface offers the same set), and the thread's automations.
 */
export function ChatHeaderActions({
  session,
  runningLabel,
  threadMenu,
  actions,
  openInEditor,
  onOpenFolder,
}: ChatHeaderActionsProps) {
  const open = threadMenu.openMenu?.surface === "header";
  const automations = open ? threadMenu.automationsFor(session.id) : [];
  // Every menu item closes the menu first, the same way thread actions do.
  const thenClose = (run: () => void) => () => {
    threadMenu.toggleHeaderMenu();
    run();
  };

  return (
    <>
      <div className="chat-header__status">
        {session.status === "running" ? runningLabel : formatRelativeTime(session.updatedAt)}
      </div>
      <div className="chat-header__menu-wrap" ref={open ? threadMenu.menuWrapRef : undefined}>
        <button
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Thread actions"
          className="icon-button"
          data-testid="thread-header-menu"
          type="button"
          onClick={threadMenu.toggleHeaderMenu}
        >
          …
        </button>
        {open && actions ? (
          <div
            className="workspace-menu chat-header__menu"
            data-testid="thread-header-menu-panel"
            role="menu"
          >
            <div className="chat-header__menu-section" role="group" aria-label="Open project">
              {openInEditor.loading ? (
                <p className="chat-header__menu-note">Looking for editors…</p>
              ) : (
                openInEditor.editors.map((editor) => (
                  <button
                    key={editor.id}
                    className="workspace-menu__item chat-header__menu-item"
                    data-testid={`thread-menu-open-in-${editor.id}`}
                    disabled={openInEditor.busy}
                    role="menuitem"
                    type="button"
                    onClick={thenClose(() => openInEditor.openIn(editor.id))}
                  >
                    <span className="chat-header__menu-item-main">
                      <span className="chat-header__menu-icon">
                        <EditorIcon editorId={editor.id} />
                      </span>
                      <span>Open in {editor.label}</span>
                    </span>
                  </button>
                ))
              )}
              <button
                className="workspace-menu__item chat-header__menu-item"
                data-testid="thread-menu-open-folder"
                role="menuitem"
                type="button"
                onClick={thenClose(onOpenFolder)}
              >
                <span className="chat-header__menu-item-main">
                  <span className="chat-header__menu-icon">
                    <FolderIcon />
                  </span>
                  <span>Open folder</span>
                </span>
              </button>
            </div>
            <div className="chat-header__menu-separator" role="separator" />
            <ThreadActionItems actions={actions} />
            {automations.length > 0 ? (
              <>
                <div className="chat-header__menu-separator" role="separator" />
                <div
                  className="chat-header__menu-section"
                  role="group"
                  aria-label="Automations"
                  data-testid="thread-menu-automations"
                >
                  <p className="chat-header__menu-heading">Automations</p>
                  {automations.map((task) => (
                    <AutomationRow
                      key={task.id}
                      task={task}
                      onOpen={thenClose(() => threadMenu.openAutomation(task.id))}
                      onSetStatus={(status) => threadMenu.setAutomationStatus(task.id, status)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

const STATUS_LABEL: Record<ScheduledTaskStatus, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};

function AutomationRow({
  task,
  onOpen,
  onSetStatus,
}: {
  readonly task: ScheduledTaskRecord;
  readonly onOpen: () => void;
  readonly onSetStatus: (status: ScheduledTaskStatus) => void;
}) {
  // The status label carries "Paused"/"Completed"; only active tasks add the next run.
  const meta =
    task.status === "active"
      ? formatScheduledTaskRowMeta(task)
      : formatScheduledTaskRecurrence(task.schedule);
  const toggle =
    task.status === "active"
      ? { label: "Pause", next: "paused" as const }
      : task.status === "paused"
        ? { label: "Resume", next: "active" as const }
        : undefined;
  return (
    <div className="chat-header__automation" data-testid="thread-menu-automation">
      <button
        className="workspace-menu__item chat-header__automation-open"
        role="menuitem"
        title="Open automation"
        type="button"
        onClick={onOpen}
      >
        <span className="chat-header__automation-title">{task.title}</span>
        <span className="chat-header__automation-meta">
          <span
            className={`chat-header__automation-status chat-header__automation-status--${task.status}`}
            title={task.lastError}
          >
            {task.status === "paused" && task.lastError
              ? "Paused after an error"
              : STATUS_LABEL[task.status]}
          </span>
          <span>{meta}</span>
        </span>
      </button>
      {toggle ? (
        <button
          className="chat-header__automation-toggle"
          data-testid="thread-menu-automation-toggle"
          role="menuitem"
          type="button"
          onClick={() => onSetStatus(toggle.next)}
        >
          {toggle.label}
        </button>
      ) : null}
    </div>
  );
}
