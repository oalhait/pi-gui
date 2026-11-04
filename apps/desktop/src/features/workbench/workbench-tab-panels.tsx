import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { ToolRef } from "../../../contracts/workbench";
import { FileEditorPane } from "./file-editor-pane";
import { TerminalPanel } from "./terminal-panel";
import type { useWorkbench } from "./use-workbench";

type Workbench = ReturnType<typeof useWorkbench>;

/** One open file's tab. */
export function FileTabPanel({
  api,
  workbench,
  tool,
  workspace,
  worktree,
}: {
  readonly api: PiDesktopApi;
  readonly workbench: Workbench;
  readonly tool: Extract<ToolRef, { kind: "file" }>;
  readonly workspace: WorkspaceRecord | undefined;
  readonly worktree: WorktreeRecord | undefined;
}) {
  if (!workspace)
    return (
      <p className="workbench__unavailable" role="status">
        This file checkout is unavailable.
      </p>
    );
  const { line, lineNonce } = workbench.view.files;
  return (
    <FileEditorPane
      key={`${workspace.id}:${tool.path}`}
      api={api}
      line={line?.path === tool.path ? line : null}
      lineNonce={lineNonce}
      path={tool.path}
      worktree={worktree}
      workspace={workspace}
      onNavigate={(next) => workbench.replaceFileTab(tool.path, next)}
    />
  );
}

/** One terminal's tab; a Terminal tab without a live shell shows while one starts. */
export function TerminalTabPanel({
  workbench,
  tool,
}: {
  readonly workbench: Workbench;
  readonly tool: ToolRef;
}) {
  const session =
    tool.kind === "terminal"
      ? workbench.terminalSessions.find((entry) => entry.id === tool.sessionId)
      : undefined;
  return session ? (
    <TerminalPanel
      key={session.id}
      session={session}
      replay={workbench.terminalReplay}
      onPanelChange={workbench.acceptTerminalPanel}
      onTitleChange={workbench.setTerminalTitle}
      onNewTerminal={workbench.newTerminal}
      shouldFocus={workbench.shouldFocusTerminal}
    />
  ) : (
    <p className="workbench__loading" role="status">
      {workbench.terminalError || "Starting terminal…"}
    </p>
  );
}
