import type { SessionRef } from "@pi-gui/session-driver/types";
import { decodeReviewScope, type ReviewScope } from "./review";

/** Open file tabs; each file is its own top-level tab. */
export const MAX_WORKBENCH_FILE_TABS = 100;
/** Every other saved tab: built-in tools and extension views. */
export const MAX_WORKBENCH_TOOLS = 32;

/** Every built-in tool; its presentation table must cover each kind. */
export const BUILTIN_TOOL_KINDS = ["files", "changes", "terminal", "browser"] as const;
/** Removed tools; a saved layout that lists one loses that tab, not the whole layout. */
const RETIRED_TOOL_KINDS: readonly unknown[] = ["worktrees"];
export type BuiltinToolKind = (typeof BUILTIN_TOOL_KINDS)[number];

export function isBuiltinToolKind(value: unknown): value is BuiltinToolKind {
  return (BUILTIN_TOOL_KINDS as readonly unknown[]).includes(value);
}

/**
 * One top-level tab. `files` is the explorer; each open file is a `file` tab. Browser pages and
 * terminals live in their main-process owners: a layout saves one `browser`/`terminal` slot and
 * the live tab row expands it into one tab per page or terminal.
 */
export type ToolRef =
  | { readonly kind: "files" | "changes" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "terminal"; readonly sessionId?: string }
  | { readonly kind: "browser"; readonly pageId?: string }
  | { readonly kind: "extension"; readonly extensionId: string; readonly viewId: string };

export type ToolSelection =
  { readonly kind: "chooser" } | { readonly kind: "tool"; readonly toolId: string };

/** A line range highlighted in one open file tab, from a transcript or extension link. */
export interface FileLineMark {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** References and small view preferences only; never file, diff, terminal or extension content. */
export interface TaskWorkbenchTemplate {
  readonly visibility: "visible" | "hidden";
  readonly tools: readonly ToolRef[];
  readonly selection: ToolSelection;
  readonly files: {
    /** The checkout every file tab and the explorer read from. */
    readonly workspaceId: string;
    readonly line: FileLineMark | null;
    /** Increments for each line link, so reopening the same range scrolls to it again. */
    readonly lineNonce: number;
  };
  readonly changes: {
    readonly workspaceId: string;
    readonly selectedPath: string | null;
    readonly scope: ReviewScope;
  };
}

export interface SaveTaskWorkbenchTemplateInput {
  readonly target: SessionRef;
  readonly template: TaskWorkbenchTemplate;
  /** Strictly increasing across this renderer's saves, including task switches. */
  readonly sequence: number;
}

export function toolRefId(tool: ToolRef): string {
  switch (tool.kind) {
    case "extension":
      return JSON.stringify(["extension", tool.extensionId, tool.viewId]);
    case "file":
      return `file:${tool.path}`;
    case "browser":
      return tool.pageId ? `browser:${tool.pageId}` : tool.kind;
    case "terminal":
      return tool.sessionId ? `terminal:${tool.sessionId}` : tool.kind;
    default:
      return tool.kind;
  }
}

/** Shared by the disk reader and IPC boundary so neither can accept a wider schema. */
export function decodeTaskWorkbenchTemplate(value: unknown): TaskWorkbenchTemplate {
  return decodeTemplate(value, false);
}

/**
 * The disk reader also accepts the v19 shape, where one Files tab held a strip of file
 * sub-tabs, and returns it with each of those files as its own top-level tab.
 */
export function decodeStoredTaskWorkbenchTemplate(value: unknown): TaskWorkbenchTemplate {
  return decodeTemplate(value, true);
}

function decodeTemplate(value: unknown, allowLegacy: boolean): TaskWorkbenchTemplate {
  const root = record(value, ["visibility", "tools", "selection", "files", "changes"]);
  if (root.visibility !== "visible" && root.visibility !== "hidden") fail("visibility");
  const filesRecord = record(root.files, ["workspaceId", "tabs", "line", "lineNonce"]);
  const legacy = filesRecord.tabs !== undefined;
  if (legacy && !allowLegacy) fail("unsupported field");
  if (
    !Array.isArray(root.tools) ||
    root.tools.length > MAX_WORKBENCH_TOOLS + MAX_WORKBENCH_FILE_TABS
  )
    fail("tools");
  const retired = new Set<string>();
  let tools: ToolRef[] = root.tools.flatMap((value: unknown): ToolRef[] => {
    const tool = record(value, ["kind", "extensionId", "viewId", "path"]);
    if (tool.kind === "extension") {
      if (tool.path !== undefined) fail("unsupported field");
      return [
        {
          kind: "extension",
          extensionId: text(tool.extensionId, 256),
          viewId: text(tool.viewId, 256),
        },
      ];
    }
    if (tool.kind === "file" && !legacy) {
      if (tool.extensionId !== undefined || tool.viewId !== undefined) fail("file tool fields");
      return [{ kind: "file", path: text(tool.path) }];
    }
    if (tool.extensionId !== undefined || tool.viewId !== undefined || tool.path !== undefined)
      fail("builtin tool fields");
    if (RETIRED_TOOL_KINDS.includes(tool.kind)) {
      retired.add(tool.kind as string);
      return [];
    }
    if (!isBuiltinToolKind(tool.kind)) fail("tool kind");
    return [{ kind: tool.kind }];
  });
  let selected = record(root.selection, ["kind", "toolId"]);
  let files: TaskWorkbenchTemplate["files"];
  if (legacy) {
    const migrated = migrateLegacyFiles(filesRecord, tools, selected);
    tools = migrated.tools;
    selected = migrated.selection;
    files = migrated.files;
  } else {
    let line: FileLineMark | null = null;
    if (filesRecord.line !== null) {
      const mark = record(filesRecord.line, ["path", "start", "end"]);
      const start = integer(mark.start, 1);
      line = { path: text(mark.path), start, end: integer(mark.end, start) };
    }
    files = {
      workspaceId: text(filesRecord.workspaceId),
      line,
      lineNonce: integer(filesRecord.lineNonce),
    };
  }
  const fileCount = tools.filter((tool) => tool.kind === "file").length;
  if (fileCount > MAX_WORKBENCH_FILE_TABS || tools.length - fileCount > MAX_WORKBENCH_TOOLS)
    fail("tools");
  const identities = new Set(tools.map(toolRefId));
  if (identities.size !== tools.length) fail("duplicate tool");
  if (files.line && !identities.has(toolRefId({ kind: "file", path: files.line.path })))
    fail("line without open file");
  let selection: ToolSelection;
  if (selected.kind === "chooser" && selected.toolId === undefined) {
    selection = { kind: "chooser" };
  } else if (
    selected.kind === "tool" &&
    typeof selected.toolId === "string" &&
    identities.has(selected.toolId)
  ) {
    selection = { kind: "tool", toolId: selected.toolId };
  } else if (
    selected.kind === "tool" &&
    typeof selected.toolId === "string" &&
    retired.has(selected.toolId)
  ) {
    selection = tools[0] ? { kind: "tool", toolId: toolRefId(tools[0]) } : { kind: "chooser" };
  } else {
    fail("selection");
  }
  const changes = record(root.changes, ["workspaceId", "selectedPath", "scope"]);
  return {
    visibility: root.visibility,
    tools,
    selection,
    files,
    changes: {
      workspaceId: text(changes.workspaceId),
      selectedPath: changes.selectedPath === null ? null : text(changes.selectedPath),
      scope:
        changes.scope === undefined ? { kind: "uncommitted" } : decodeReviewScope(changes.scope),
    },
  };
}

/**
 * v19 kept open files inside the Files tab. Each becomes a top-level file tab directly after the
 * explorer, in strip order; the strip's selected file becomes the selected tab when Files was.
 * Files of a closed Files tab were already hidden, so they are not resurrected as tabs.
 */
function migrateLegacyFiles(
  files: Record<string, unknown>,
  tools: readonly ToolRef[],
  selection: Record<string, unknown>,
): {
  tools: ToolRef[];
  selection: Record<string, unknown>;
  files: TaskWorkbenchTemplate["files"];
} {
  if (files.line !== undefined || files.lineNonce !== undefined) fail("unsupported field");
  const tabs = record(files.tabs, ["tabs", "active", "line", "lineNonce", "retained"]);
  const paths = pathsList(tabs.tabs);
  const retained = pathsList(tabs.retained);
  const active = tabs.active === null ? null : text(tabs.active);
  if (active !== null && !paths.includes(active)) fail("active file");
  if (retained.some((path) => !paths.includes(path))) fail("retained file");
  let line: FileLineMark | null = null;
  if (tabs.line !== null) {
    const mark = record(tabs.line, ["start", "end"]);
    const start = integer(mark.start, 1);
    const end = integer(mark.end, start);
    if (active === null) fail("line without active file");
    line = { path: active, start, end };
  }
  const explorer = tools.findIndex((tool) => tool.kind === "files");
  const fileTabs = paths.map((path): ToolRef => ({ kind: "file", path }));
  const nextTools =
    explorer < 0
      ? [...tools]
      : [...tools.slice(0, explorer + 1), ...fileTabs, ...tools.slice(explorer + 1)];
  const kept = explorer >= 0;
  return {
    tools: nextTools,
    selection:
      kept && active !== null && selection.kind === "tool" && selection.toolId === "files"
        ? { kind: "tool", toolId: toolRefId({ kind: "file", path: active }) }
        : selection,
    files: {
      workspaceId: text(files.workspaceId),
      line: kept ? line : null,
      lineNonce: integer(tabs.lineNonce),
    },
  };
}

function fail(field: string): never {
  throw new Error(`Invalid workbench template: ${field}`);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail("unsupported field");
  return result;
}

function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
    fail("invalid or oversized reference");
  }
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("integer");
  return value;
}

function pathsList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKBENCH_FILE_TABS) fail("file references");
  const result = value.map((path: unknown) => text(path));
  if (new Set(result).size !== result.length) fail("duplicate file reference");
  return result;
}
