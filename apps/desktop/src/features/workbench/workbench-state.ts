import {
  MAX_WORKBENCH_FILE_TABS,
  MAX_WORKBENCH_TOOLS,
  toolRefId,
  type TaskWorkbenchTemplate,
  type ToolRef,
} from "../../../contracts/workbench";
import type { TerminalPanelSnapshot } from "../../../contracts/ipc";

export interface WorkspaceFileReference {
  readonly workspaceId: string;
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

export type WorkbenchAction =
  | { readonly type: "open-tool"; readonly tool: ToolRef }
  | { readonly type: "activate-tool"; readonly toolId: string }
  | { readonly type: "close-tool"; readonly toolId: string }
  | { readonly type: "set-visibility"; readonly visibility: "visible" | "hidden" }
  | { readonly type: "set-changes"; readonly changes: TaskWorkbenchTemplate["changes"] }
  | { readonly type: "open-file"; readonly file: WorkspaceFileReference };

/** A task without a saved layout keeps the side workspace closed until the user opens it. */
export function initialWorkbenchView(workspaceId: string): TaskWorkbenchTemplate {
  return {
    visibility: "hidden",
    tools: [{ kind: "changes" }],
    selection: { kind: "tool", toolId: "changes" },
    files: { workspaceId, line: null, lineNonce: 0 },
    changes: { workspaceId, selectedPath: null, scope: { kind: "uncommitted" } },
  };
}

export function activeWorkbenchTool(view: TaskWorkbenchTemplate): ToolRef | undefined {
  const selection = view.selection;
  return selection.kind === "tool"
    ? view.tools.find((tool) => toolRefId(tool) === selection.toolId)
    : undefined;
}

/** Paths of the open file tabs, in tab-row order. */
export function openFilePaths(view: TaskWorkbenchTemplate): readonly string[] {
  return view.tools.flatMap((tool) => (tool.kind === "file" ? [tool.path] : []));
}

/** Rebase explicit actions onto the saved layout before the first write. */
export function restoreWorkbenchView(
  fallback: TaskWorkbenchTemplate,
  saved: TaskWorkbenchTemplate | null,
  pendingActions: readonly WorkbenchAction[],
): { readonly view: TaskWorkbenchTemplate; readonly error: string } {
  return applyWorkbenchActions(saved ?? fallback, pendingActions);
}

function actionLimitError(view: TaskWorkbenchTemplate, action: WorkbenchAction): string {
  const tool: ToolRef | undefined =
    action.type === "open-tool"
      ? action.tool
      : action.type === "open-file"
        ? { kind: "file", path: action.file.path }
        : undefined;
  if (!tool) return "";
  // Opening a file from another checkout replaces this checkout's file tabs.
  const tools =
    action.type === "open-file" && action.file.workspaceId !== view.files.workspaceId
      ? view.tools.filter((entry) => entry.kind !== "file")
      : view.tools;
  const id = toolRefId(tool);
  if (tools.some((entry) => toolRefId(entry) === id)) return "";
  const files = tools.filter((entry) => entry.kind === "file").length;
  if (tool.kind === "file") {
    return files >= MAX_WORKBENCH_FILE_TABS
      ? `You have ${MAX_WORKBENCH_FILE_TABS} file tabs open. Close a file tab before opening another.`
      : "";
  }
  return tools.length - files >= MAX_WORKBENCH_TOOLS
    ? "Close a tool tab before opening another."
    : "";
}

export function applyWorkbenchActions(
  initial: TaskWorkbenchTemplate,
  actions: readonly WorkbenchAction[],
): { readonly view: TaskWorkbenchTemplate; readonly error: string } {
  let view = initial;
  let error = "";
  for (const action of actions) {
    const limitError = actionLimitError(view, action);
    if (limitError) error = limitError;
    else view = reduceWorkbench(view, action);
  }
  return { view, error };
}

/** The sole transition path for a window's live tool layout. */
export function reduceWorkbench(
  view: TaskWorkbenchTemplate,
  action: WorkbenchAction,
): TaskWorkbenchTemplate {
  if (actionLimitError(view, action)) return view;
  switch (action.type) {
    case "open-tool": {
      const toolId = toolRefId(action.tool);
      const existing = view.tools.some((tool) => toolRefId(tool) === toolId);
      if (
        existing &&
        view.visibility === "visible" &&
        view.selection.kind === "tool" &&
        view.selection.toolId === toolId
      ) {
        return view;
      }
      return {
        ...view,
        visibility: "visible",
        tools: existing ? view.tools : [...view.tools, action.tool],
        selection: { kind: "tool", toolId },
      };
    }
    case "activate-tool": {
      const tool = view.tools.find((candidate) => toolRefId(candidate) === action.toolId);
      return tool ? reduceWorkbench(view, { type: "open-tool", tool }) : view;
    }
    case "close-tool": {
      const index = view.tools.findIndex((tool) => toolRefId(tool) === action.toolId);
      if (index < 0) return view;
      const closed = view.tools[index];
      const tools = view.tools.filter((tool) => toolRefId(tool) !== action.toolId);
      const files =
        closed?.kind === "file" && view.files.line?.path === closed.path
          ? { ...view.files, line: null }
          : view.files;
      if (tools.length === 0) {
        return { ...view, tools, files, selection: { kind: "chooser" } };
      }
      if (view.selection.kind !== "tool" || view.selection.toolId !== action.toolId) {
        return { ...view, tools, files };
      }
      const neighbor = tools[Math.min(index, tools.length - 1)];
      return {
        ...view,
        tools,
        files,
        selection: neighbor ? { kind: "tool", toolId: toolRefId(neighbor) } : { kind: "chooser" },
      };
    }
    case "set-visibility":
      return view.visibility === action.visibility
        ? view
        : { ...view, visibility: action.visibility };
    case "set-changes":
      return action.changes === view.changes ? view : { ...view, changes: action.changes };
    case "open-file": {
      const { file } = action;
      const sameCheckout = view.files.workspaceId === file.workspaceId;
      const tools = sameCheckout ? view.tools : view.tools.filter((tool) => tool.kind !== "file");
      const previousLine = sameCheckout ? view.files.line : null;
      const files: TaskWorkbenchTemplate["files"] =
        file.line !== undefined
          ? {
              workspaceId: file.workspaceId,
              line: { path: file.path, start: file.line, end: file.endLine ?? file.line },
              lineNonce: view.files.lineNonce + 1,
            }
          : sameCheckout && previousLine?.path !== file.path
            ? view.files
            : { workspaceId: file.workspaceId, line: null, lineNonce: view.files.lineNonce };
      return reduceWorkbench(
        { ...view, tools, files },
        { type: "open-tool", tool: { kind: "file", path: file.path } },
      );
    }
  }
}

/** Replaces a saved terminal slot with one tab per live terminal of this chat. */
export function projectTerminalWorkbench(
  view: TaskWorkbenchTemplate,
  terminals: Pick<TerminalPanelSnapshot, "activeSessionId" | "sessions"> | undefined,
): TaskWorkbenchTemplate {
  if (!terminals?.sessions.length) return view;
  return {
    ...view,
    tools: view.tools.flatMap((tool): ToolRef[] =>
      tool.kind === "terminal"
        ? terminals.sessions.map((session) => ({ kind: "terminal", sessionId: session.id }))
        : [tool],
    ),
    selection:
      view.selection.kind === "tool" &&
      view.selection.toolId === "terminal" &&
      terminals.activeSessionId
        ? { kind: "tool", toolId: `terminal:${terminals.activeSessionId}` }
        : view.selection,
  };
}

export function projectBrowserWorkbench(
  view: TaskWorkbenchTemplate,
  browser: import("../../../contracts/browser").BrowserPanelState | undefined,
): TaskWorkbenchTemplate {
  return {
    ...view,
    tools: view.tools.flatMap((tool): ToolRef[] =>
      tool.kind === "browser" && browser?.tabs.length
        ? browser.tabs.map((tab) => ({ kind: "browser", pageId: tab.id }))
        : [tool],
    ),
    selection:
      view.selection.kind === "tool" && view.selection.toolId === "browser" && browser?.activeTabId
        ? { kind: "tool", toolId: `browser:${browser.activeTabId}` }
        : view.selection,
  };
}

export function workbenchCloseNeighbor(
  view: TaskWorkbenchTemplate,
  toolId: string,
): string | undefined {
  if (view.selection.kind !== "tool") return undefined;
  if (view.selection.toolId !== toolId) return view.selection.toolId;
  const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
  const tools = view.tools.filter((tool) => toolRefId(tool) !== toolId);
  const neighbor = tools[Math.min(index, tools.length - 1)];
  return neighbor ? toolRefId(neighbor) : undefined;
}
