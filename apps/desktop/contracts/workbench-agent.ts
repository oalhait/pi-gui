import type { WorkspaceSessionTarget } from "./desktop-state";
import { browserUrl } from "./browser";

export interface WorkbenchAgentCommand {
  readonly action:
    | "list"
    | "open"
    | "select"
    | "close"
    | "show"
    | "hide"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "stop";
  readonly tool?: "browser" | "files" | "review" | "terminal" | "extension";
  readonly tab_id?: string;
  readonly url?: string;
  readonly path?: string;
  readonly extension_id?: string;
  readonly view_id?: string;
}
export interface WorkbenchAgentState {
  readonly visible: boolean;
  readonly selectedTabId: string | null;
  readonly tabs: readonly { readonly id: string; readonly title: string; readonly url?: string }[];
}
export interface WorkbenchAgentRequest {
  readonly id: string;
  readonly target: WorkspaceSessionTarget;
  readonly command: WorkbenchAgentCommand;
  readonly expiresAt: number;
}
export interface WorkbenchAgentResponse {
  readonly id: string;
  readonly state?: WorkbenchAgentState;
  readonly error?: string;
}
export function decodeWorkbenchAgentCommand(value: unknown): WorkbenchAgentCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workbench command.");
  const input = value as Record<string, unknown>;
  const keys = ["action", "tool", "tab_id", "url", "path", "extension_id", "view_id"];
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("Unsupported workbench command field.");
  if (
    ![
      "list",
      "open",
      "select",
      "close",
      "show",
      "hide",
      "navigate",
      "back",
      "forward",
      "reload",
      "stop",
    ].includes(String(input.action))
  )
    throw new Error("Unknown workbench action.");
  for (const key of keys.slice(1))
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" ||
        !(input[key] as string).trim() ||
        (input[key] as string).length > 8192 ||
        (input[key] as string).includes("\0"))
    )
      throw new Error(`Invalid ${key}.`);
  if (
    input.tool !== undefined &&
    !["browser", "files", "review", "terminal", "extension"].includes(String(input.tool))
  )
    throw new Error("Unknown workbench tool.");
  if (input.action === "open" && !input.tool) throw new Error("open requires a tool.");
  if ((input.action === "select" || input.action === "close") && !input.tab_id)
    throw new Error("Select or close requires an exact tab_id from list.");
  if (input.action === "navigate" && !input.url) throw new Error("navigate requires a URL.");
  if (
    input.url !== undefined &&
    !(input.action === "navigate" || (input.action === "open" && input.tool === "browser"))
  )
    throw new Error("URLs require opening or navigating a browser page.");
  if (input.path !== undefined && !(input.action === "open" && input.tool === "files"))
    throw new Error("File paths require opening Files.");
  if (input.tool === "extension" && (!input.extension_id || !input.view_id))
    throw new Error("Extension tabs require extension_id and view_id.");
  return {
    ...input,
    ...(input.url === undefined ? {} : { url: browserUrl(input.url as string) }),
  } as unknown as WorkbenchAgentCommand;
}

export function decodeWorkbenchAgentResponse(value: unknown): WorkbenchAgentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workbench response.");
  const input = value as Record<string, unknown>;
  const text = (value: unknown, limit: number): string => {
    if (typeof value !== "string" || !value || value.length > limit || value.includes("\0"))
      throw new Error("Invalid workbench response text.");
    return value;
  };
  const id = text(input.id, 128);
  if (input.error !== undefined) return { id, error: text(input.error, 2000) };
  if (!input.state || typeof input.state !== "object" || Array.isArray(input.state))
    throw new Error("Missing workbench state.");
  const state = input.state as Record<string, unknown>;
  if (typeof state.visible !== "boolean" || !Array.isArray(state.tabs) || state.tabs.length > 100)
    throw new Error("Invalid workbench state.");
  const selectedTabId = state.selectedTabId === null ? null : text(state.selectedTabId, 8192);
  const tabs = state.tabs.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid workbench tab.");
    const tab = value as Record<string, unknown>;
    return {
      id: text(tab.id, 8192),
      title: text(tab.title, 200),
      ...(tab.url === undefined ? {} : { url: text(tab.url, 8192) }),
    };
  });
  if (
    new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
    (selectedTabId !== null && !tabs.some((tab) => tab.id === selectedTabId))
  )
    throw new Error("Invalid selected workbench tab.");
  return { id, state: { visible: state.visible, selectedTabId, tabs } };
}
