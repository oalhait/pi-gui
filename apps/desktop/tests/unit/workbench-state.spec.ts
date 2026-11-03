import { expect, test } from "@playwright/test";
import {
  decodeTaskWorkbenchTemplate,
  MAX_WORKBENCH_FILE_TABS,
  toolRefId,
  type ToolRef,
} from "../../contracts/workbench";
import {
  activeWorkbenchTool,
  applyWorkbenchActions,
  initialWorkbenchView,
  openFilePaths,
  reduceWorkbench,
  projectBrowserWorkbench,
  projectTerminalWorkbench,
  workbenchCloseNeighbor,
  restoreWorkbenchView,
} from "../../src/features/workbench/workbench-state";

test("tasks without a saved layout keep the workbench hidden with Changes ready", () => {
  const existing = initialWorkbenchView("checkout");
  expect(existing).toMatchObject({
    visibility: "hidden",
    tools: [{ kind: "changes" }],
    selection: { kind: "tool", toolId: "changes" },
    changes: { scope: { kind: "uncommitted" }, workspaceId: "checkout", selectedPath: null },
  });
  expect(decodeTaskWorkbenchTemplate(existing)).toEqual(existing);
});

test("opening a tool adds or focuses its singleton without discarding other tools", () => {
  const initial = initialWorkbenchView("checkout");
  const files = reduceWorkbench(initial, { type: "open-tool", tool: { kind: "files" } });
  const terminal = reduceWorkbench(files, { type: "open-tool", tool: { kind: "terminal" } });
  const focused = reduceWorkbench(terminal, { type: "open-tool", tool: { kind: "files" } });
  expect(focused.tools.map(toolRefId)).toEqual(["changes", "files", "terminal"]);
  expect(focused.selection).toEqual({ kind: "tool", toolId: "files" });
  expect(reduceWorkbench(focused, { type: "open-tool", tool: { kind: "files" } })).toBe(focused);
  expect(reduceWorkbench(focused, { type: "activate-tool", toolId: "missing" })).toBe(focused);
});

test("close selects a neighbor, preserves inactive selection, and leaves a chooser after the last tab", () => {
  let view = initialWorkbenchView("checkout");
  for (const kind of ["files", "terminal"] as const) {
    view = reduceWorkbench(view, { type: "open-tool", tool: { kind } });
  }
  const closedInactive = reduceWorkbench(view, { type: "close-tool", toolId: "changes" });
  expect(closedInactive.selection).toEqual({ kind: "tool", toolId: "terminal" });
  const files = reduceWorkbench(closedInactive, { type: "close-tool", toolId: "terminal" });
  expect(files.selection).toEqual({ kind: "tool", toolId: "files" });
  const changes = reduceWorkbench(
    reduceWorkbench(files, { type: "open-tool", tool: { kind: "changes" } }),
    { type: "close-tool", toolId: "files" },
  );
  const empty = reduceWorkbench(changes, { type: "close-tool", toolId: "changes" });
  expect(empty).toMatchObject({ tools: [], visibility: "visible", selection: { kind: "chooser" } });
  expect(activeWorkbenchTool(empty)).toBeUndefined();
  expect(reduceWorkbench(empty, { type: "close-tool", toolId: "missing" })).toBe(empty);
  expect(decodeTaskWorkbenchTemplate(empty)).toEqual(empty);
});

test("hiding and tab switching retain file tabs and Changes selection", () => {
  let view = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-file",
    file: { workspaceId: "checkout", path: "README.md", line: 5, endLine: 7 },
  });
  view = reduceWorkbench(view, {
    type: "set-changes",
    changes: {
      scope: { kind: "uncommitted" },
      workspaceId: "checkout",
      selectedPath: "src/index.ts",
    },
  });
  const hidden = reduceWorkbench(view, { type: "set-visibility", visibility: "hidden" });
  expect(hidden.tools).toBe(view.tools);
  expect(hidden.selection).toBe(view.selection);
  expect(hidden.files).toBe(view.files);
  const changes = reduceWorkbench(hidden, { type: "open-tool", tool: { kind: "changes" } });
  expect(changes.visibility).toBe("visible");
  expect(openFilePaths(changes)).toEqual(["README.md"]);
  expect(changes.files.line).toEqual({ path: "README.md", start: 5, end: 7 });
  expect(changes.changes.selectedPath).toBe("src/index.ts");
  expect(decodeTaskWorkbenchTemplate(changes)).toEqual(changes);
});

test("each opened file is its own tab; reopening focuses it and closing removes only it", () => {
  let view = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-tool",
    tool: { kind: "files" },
  });
  for (const path of ["a.ts", "b.ts"])
    view = reduceWorkbench(view, { type: "open-file", file: { workspaceId: "checkout", path } });
  expect(view.tools.map(toolRefId)).toEqual(["changes", "files", "file:a.ts", "file:b.ts"]);
  expect(view.selection).toEqual({ kind: "tool", toolId: "file:b.ts" });
  const refocused = reduceWorkbench(view, {
    type: "open-file",
    file: { workspaceId: "checkout", path: "a.ts" },
  });
  expect(refocused.tools).toBe(view.tools);
  expect(refocused.selection).toEqual({ kind: "tool", toolId: "file:a.ts" });
  // A line link marks that file; opening it again without a line clears the mark.
  const marked = reduceWorkbench(refocused, {
    type: "open-file",
    file: { workspaceId: "checkout", path: "b.ts", line: 3 },
  });
  expect(marked.files).toEqual({
    workspaceId: "checkout",
    line: { path: "b.ts", start: 3, end: 3 },
    lineNonce: 1,
  });
  expect(
    reduceWorkbench(marked, { type: "open-file", file: { workspaceId: "checkout", path: "a.ts" } })
      .files.line,
  ).toEqual(marked.files.line);
  expect(
    reduceWorkbench(marked, { type: "open-file", file: { workspaceId: "checkout", path: "b.ts" } })
      .files.line,
  ).toBeNull();
  const closed = reduceWorkbench(marked, { type: "close-tool", toolId: "file:b.ts" });
  expect(closed.tools.map(toolRefId)).toEqual(["changes", "files", "file:a.ts"]);
  expect(closed.selection).toEqual({ kind: "tool", toolId: "file:a.ts" });
  expect(closed.files.line).toBeNull();
  expect(decodeTaskWorkbenchTemplate(closed)).toEqual(closed);
});

test("opening a file from another checkout replaces the previous checkout's file tabs", () => {
  let view = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-file",
    file: { workspaceId: "checkout", path: "a.ts", line: 2 },
  });
  view = reduceWorkbench(view, { type: "open-tool", tool: { kind: "terminal" } });
  const other = reduceWorkbench(view, {
    type: "open-file",
    file: { workspaceId: "worktree", path: "b.ts" },
  });
  expect(other.tools.map(toolRefId)).toEqual(["changes", "terminal", "file:b.ts"]);
  expect(other.files).toEqual({ workspaceId: "worktree", line: null, lineNonce: 1 });
});

test("saved extension references retain their own identity without a registered frontend", () => {
  const first: ToolRef = { kind: "extension", extensionId: "review", viewId: "pull-request" };
  const second: ToolRef = { kind: "extension", extensionId: "other", viewId: "pull-request" };
  let view = reduceWorkbench(initialWorkbenchView("checkout"), { type: "open-tool", tool: first });
  view = reduceWorkbench(view, { type: "open-tool", tool: second });
  expect(view.tools).toHaveLength(3);
  expect(activeWorkbenchTool(view)).toEqual(second);
  expect(decodeTaskWorkbenchTemplate(view)).toEqual(view);
});

test("restore rebases early explicit actions without losing saved tools or document tabs", () => {
  const untouched = initialWorkbenchView("checkout");
  const saved = reduceWorkbench(untouched, {
    type: "open-file",
    file: { workspaceId: "checkout", path: "saved.ts", line: 2 },
  });
  expect(restoreWorkbenchView(untouched, saved, []).view).toBe(saved);
  expect(restoreWorkbenchView(untouched, null, []).view).toBe(untouched);
  const { view: live } = restoreWorkbenchView(untouched, saved, [
    { type: "open-tool", tool: { kind: "terminal" } },
    { type: "open-file", file: { workspaceId: "checkout", path: "early-link.ts", line: 5 } },
  ]);
  expect(live.tools.map(toolRefId)).toEqual([
    "changes",
    "file:saved.ts",
    "terminal",
    "file:early-link.ts",
  ]);
  expect(live.selection).toEqual({ kind: "tool", toolId: "file:early-link.ts" });
  // A second window can load the durable template without mutating the first window's value.
  const secondWindow = restoreWorkbenchView(initialWorkbenchView("checkout"), saved, []).view;
  const editedSecond = reduceWorkbench(secondWindow, {
    type: "close-tool",
    toolId: "file:saved.ts",
  });
  expect(editedSecond.tools).toEqual([{ kind: "changes" }]);
  expect(saved.tools).toEqual([{ kind: "changes" }, { kind: "file", path: "saved.ts" }]);
});

test("file tabs and other tabs have separate limits that keep existing references", () => {
  const initial = initialWorkbenchView("checkout");
  const paths = Array.from({ length: MAX_WORKBENCH_FILE_TABS }, (_, index) => `file-${index}.ts`);
  const full = applyWorkbenchActions(
    initial,
    paths.map((path) => ({ type: "open-file", file: { workspaceId: "checkout", path } })),
  ).view;
  expect(openFilePaths(full)).toHaveLength(MAX_WORKBENCH_FILE_TABS);
  const action = {
    type: "open-file",
    file: { workspaceId: "checkout", path: "one-too-many.ts" },
  } as const;
  const blocked = applyWorkbenchActions(full, [action]);
  expect(blocked.view).toBe(full);
  expect(blocked.error).toContain("Close a file tab");
  expect(restoreWorkbenchView(initial, full, [action])).toEqual(blocked);
  expect(decodeTaskWorkbenchTemplate(blocked.view)).toEqual(full);
  const existing = applyWorkbenchActions(full, [
    { type: "open-file", file: { workspaceId: "checkout", path: "file-0.ts" } },
  ]);
  expect(existing.error).toBe("");
  expect(existing.view.selection).toEqual({ kind: "tool", toolId: "file:file-0.ts" });
  // Files do not count against the tool limit.
  const terminal = applyWorkbenchActions(full, [{ type: "open-tool", tool: { kind: "terminal" } }]);
  expect(terminal.error).toBe("");
  expect(terminal.view.tools).toHaveLength(MAX_WORKBENCH_FILE_TABS + 2);
  expect(decodeTaskWorkbenchTemplate(terminal.view)).toEqual(terminal.view);
});

test("terminals project into one tab each without changing the saved slot", () => {
  const saved = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-tool",
    tool: { kind: "terminal" },
  });
  expect(projectTerminalWorkbench(saved, undefined)).toBe(saved);
  expect(projectTerminalWorkbench(saved, { activeSessionId: "", sessions: [] })).toBe(saved);
  const session = (id: string) => ({
    id,
    workspaceId: "checkout",
    cwd: "/repo",
    shell: "/bin/zsh",
    title: id,
    status: "running" as const,
    replay: "",
    truncated: false,
  });
  const live = projectTerminalWorkbench(saved, {
    activeSessionId: "t2",
    sessions: [session("t1"), session("t2")],
  });
  expect(live.tools.map(toolRefId)).toEqual(["changes", "terminal:t1", "terminal:t2"]);
  expect(live.selection).toEqual({ kind: "tool", toolId: "terminal:t2" });
  expect(saved.tools.map(toolRefId)).toEqual(["changes", "terminal"]);
  expect(decodeTaskWorkbenchTemplate(saved)).toEqual(saved);
  expect(workbenchCloseNeighbor(live, "terminal:t2")).toBe("terminal:t1");
  const other = projectTerminalWorkbench(
    { ...saved, selection: { kind: "tool", toolId: "changes" } },
    { activeSessionId: "t2", sessions: [session("t1"), session("t2")] },
  );
  expect(other.selection).toEqual({ kind: "tool", toolId: "changes" });
  expect(() =>
    decodeTaskWorkbenchTemplate({ ...saved, tools: live.tools, selection: live.selection }),
  ).toThrow(/builtin tool fields|unsupported field/);
});

test("browser pages project into the tool row without changing the saved placement", () => {
  const saved = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-tool",
    tool: { kind: "browser" },
  });
  const browser = {
    revision: 1,
    activeTabId: "two",
    tabs: ["one", "two"].map((id) => ({
      id,
      title: id,
      url: "about:blank",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
  const visible = projectBrowserWorkbench(saved, browser);
  expect(visible.tools.map(toolRefId)).toEqual(["changes", "browser:one", "browser:two"]);
  expect(visible.selection).toEqual({ kind: "tool", toolId: "browser:two" });
  expect(saved.tools.map(toolRefId)).toEqual(["changes", "browser"]);
  expect(decodeTaskWorkbenchTemplate(saved)).toEqual(saved);
  expect(workbenchCloseNeighbor(visible, "changes")).toBe("browser:two");
  expect(workbenchCloseNeighbor(visible, "browser:two")).toBe("browser:one");
  const terminal = { ...visible, tools: [...visible.tools, { kind: "terminal" as const }] };
  expect(workbenchCloseNeighbor(terminal, "browser:two")).toBe("terminal");
  expect(
    workbenchCloseNeighbor(
      { ...visible, selection: { kind: "tool", toolId: "changes" } },
      "changes",
    ),
  ).toBe("browser:one");
});
