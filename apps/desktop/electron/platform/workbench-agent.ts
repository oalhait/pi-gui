import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { desktopIpc } from "../../contracts/ipc";
import {
  decodeWorkbenchAgentCommand,
  decodeWorkbenchAgentResponse,
  type WorkbenchAgentCommand,
  type WorkbenchAgentState,
} from "../../contracts/workbench-agent";
import type { WindowOwner } from "../windows/window-owner";
import type { MainFrameHandler } from "../ipc/main-frame-ipc";

interface Pending {
  readonly window: BrowserWindow;
  readonly target: SessionRef;
  readonly resolve: (state: WorkbenchAgentState) => void;
  readonly reject: (error: Error) => void;
}
export class WorkbenchAgentOwner {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly windows: () => WindowOwner) {}
  private matches(window: BrowserWindow, target: SessionRef): boolean {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
    const view = this.windows().viewForWindow(window);
    return (
      view.activeView === "threads" &&
      view.selectedWorkspaceId === target.workspaceId &&
      view.selectedSessionId === target.sessionId
    );
  }
  async execute(
    target: SessionRef,
    command: WorkbenchAgentCommand,
    signal?: AbortSignal,
  ): Promise<WorkbenchAgentState> {
    const window = this.windows()
      .allWindows()
      .find((candidate) => this.matches(candidate, target));
    if (!window)
      throw new Error(
        "Open this chat in pi-gui before changing its side pane. Another chat's pane was not changed.",
      );
    if (signal?.aborted) throw new Error("Workbench action cancelled.");
    const id = randomUUID();
    let cancel = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<WorkbenchAgentState>((resolve, reject) => {
        this.pending.set(id, { window, target, resolve, reject });
        cancel = () => reject(new Error("Workbench action cancelled."));
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The side pane did not acknowledge the action. Inspect it before retrying.",
              ),
            ),
          20_000,
        );
        window.webContents.send(desktopIpc.workbenchAgentRequest, {
          id,
          target,
          command,
          expiresAt: Date.now() + 20_000,
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(id);
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(desktopIpc.workbenchAgentCancel, id);
    }
  }
  register(handle: MainFrameHandler): void {
    handle(desktopIpc.workbenchAgentResponse, decodeWorkbenchAgentResponse, (input, request) => {
      const pending = this.pending.get(input.id);
      if (!pending || pending.window !== request.window) return;
      if (!this.matches(request.window, pending.target))
        pending.reject(
          new Error("The selected chat changed before the workbench action finished."),
        );
      else if (input.error) pending.reject(new Error(String(input.error).slice(0, 2000)));
      else if (input.state && Array.isArray(input.state.tabs) && input.state.tabs.length <= 100)
        pending.resolve(input.state);
      else pending.reject(new Error("Invalid workbench state response."));
    });
  }
}

export function createWorkbenchAgentTool(
  run: (
    ctx: ExtensionContext,
    command: WorkbenchAgentCommand,
    signal?: AbortSignal,
  ) => Promise<WorkbenchAgentState>,
): ToolDefinition<any, unknown> {
  return {
    name: "workbench",
    label: "Manage side pane",
    description:
      "Control this chat's pi-gui side pane directly: list tabs; show/hide the pane; open Browser, Files, Review, Terminal or extension tabs; select/close exact tab IDs; navigate/back/forward/reload/stop browser pages. No macOS desktop permissions are needed. This controls the application UI, not web page contents.",
    promptSnippet:
      "workbench: open websites or localhost previews in pi-gui's browser and manage the side pane's tabs.",
    promptGuidelines: [
      "Use workbench action=open tool=browser url=... when asked to show a page or preview in pi-gui. Do not ask the user to paste a URL or use OS automation for the side pane.",
      "Use list to obtain exact tab_id values before selecting, closing or navigating an existing tab. Browser opens create a new top-level page; navigate changes an existing browser page.",
      "Only the requesting chat's pane is controlled. If this chat is not visible, ask the user to open it rather than changing a different chat.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
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
          ],
        },
        tool: { type: "string", enum: ["browser", "files", "review", "terminal", "extension"] },
        tab_id: { type: "string", description: "Exact top-level tab ID returned by list." },
        url: { type: "string", description: "HTTP/HTTPS URL or localhost address." },
        path: { type: "string", description: "Workspace-relative file to show in Files." },
        extension_id: { type: "string" },
        view_id: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx): Promise<AgentToolResult<unknown>> {
      try {
        const state = await run(ctx, decodeWorkbenchAgentCommand(params), signal);
        return { content: [{ type: "text", text: JSON.stringify(state) }], details: state };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  };
}
export function createWorkbenchAgentExtension(
  run: Parameters<typeof createWorkbenchAgentTool>[0],
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createWorkbenchAgentTool(run));
  };
}
