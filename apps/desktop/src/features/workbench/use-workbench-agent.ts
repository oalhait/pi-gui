import { useEffect, useLayoutEffect, useRef } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { toolRefId, type ToolRef } from "../../../contracts/workbench";
import {
  decodeWorkbenchAgentCommand,
  type WorkbenchAgentRequest,
  type WorkbenchAgentState,
  type WorkbenchCaptureTarget,
} from "../../../contracts/workbench-agent";
import { imageTypeForPath } from "../../../contracts/workspace-images";
import { workbenchToolLabel } from "./workbench";
import type { useTerminalWorkbench } from "./use-terminal-workbench";

type Workbench = ReturnType<typeof useTerminalWorkbench>;

function terminalSession(workbench: Workbench, tool: ToolRef) {
  return tool.kind === "terminal"
    ? workbench.terminalSessions.find((session) => session.id === tool.sessionId)
    : undefined;
}

/** A short text companion to a pane capture; never file or terminal contents. */
function describeTool(tool: Exclude<ToolRef, { kind: "browser" }>, workbench: Workbench) {
  const view = workbench.view;
  switch (tool.kind) {
    case "files":
      return "File explorer";
    case "file": {
      if (!imageTypeForPath(tool.path)) return `Open file: ${tool.path}`;
      // Only the selected tab is mounted; its viewer knows the image's pixel size once loaded.
      const viewer = [...document.querySelectorAll<HTMLElement>('[data-testid="file-image"]')].find(
        (element) => element.dataset.path === tool.path,
      );
      const { width, height, zoom } = viewer?.dataset ?? {};
      return width && height
        ? `Image: ${tool.path}, ${width}×${height} px, shown ${zoom === "actual" ? "at 100%" : "fitted to the pane"}`
        : `Image: ${tool.path}`;
    }
    case "changes": {
      const selected = view.changes.selectedPath;
      return `Review scope: ${view.changes.scope.kind}${selected ? `; selected file: ${selected}` : ""}`;
    }
    case "terminal": {
      const session = terminalSession(workbench, tool);
      return session ? `Terminal: ${session.title} in ${session.cwd}` : "Terminal: no session";
    }
    case "extension":
      return `Extension view ${tool.extensionId}/${tool.viewId}`;
  }
}
export function useWorkbenchAgent(
  api: PiDesktopApi | undefined,
  target: SessionRef | null,
  workbench: Workbench,
) {
  const current = useRef({ target, workbench });
  current.current = { target, workbench };
  const listeners = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    for (const listener of [...listeners.current]) listener();
  });
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const active = new Set<string>();
    const cancelled = new Set<string>();
    const unsubscribeCancel = api.onWorkbenchAgentCancel((id) => {
      if (!active.has(id)) return;
      cancelled.add(id);
      for (const listener of [...listeners.current]) listener();
    });
    let queue = Promise.resolve();
    const checkTarget = (request: WorkbenchAgentRequest) => {
      if (cancelled.has(request.id) || request.expiresAt < Date.now())
        throw new Error("Workbench action cancelled or expired.");
      const selected = current.current.target;
      if (
        !alive ||
        selected?.workspaceId !== request.target.workspaceId ||
        selected?.sessionId !== request.target.sessionId
      )
        throw new Error(
          "This chat is no longer displayed. Another chat's side pane was not changed.",
        );
    };
    const waitFor = async (
      request: WorkbenchAgentRequest,
      predicate: (value: Workbench) => boolean,
    ) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        checkTarget(request);
        if (predicate(current.current.workbench)) return;
        if (current.current.workbench.error) throw new Error(current.current.workbench.error);
        await new Promise<void>((resolve, reject) => {
          const changed = () => {
            clearTimeout(timer);
            listeners.current.delete(changed);
            resolve();
          };
          const timer = setTimeout(
            () => {
              listeners.current.delete(changed);
              reject(new Error("The side pane did not finish updating."));
            },
            Math.max(0, deadline - Date.now()),
          );
          listeners.current.add(changed);
        });
      }
    };
    const state = (): WorkbenchAgentState => {
      const value = current.current.workbench;
      return {
        visible: value.view.visibility === "visible",
        selectedTabId: value.view.selection.kind === "tool" ? value.view.selection.toolId : null,
        tabs: value.view.tools.map((tool) => {
          const page =
            tool.kind === "browser"
              ? value.browserState?.tabs.find((tab) => tab.id === tool.pageId)
              : undefined;
          const title =
            page?.title ??
            terminalSession(value, tool)?.title ??
            (tool.kind === "file" ? tool.path : workbenchToolLabel(tool));
          return {
            id: toolRefId(tool),
            title: title.slice(0, 200),
            ...(page ? { url: page.url } : {}),
          };
        }),
      };
    };
    const captureTarget = (id: string): WorkbenchCaptureTarget => {
      const value = current.current.workbench;
      const tool = value.view.tools.find((entry) => toolRefId(entry) === id);
      if (!tool) throw new Error("Unknown tab_id. Use list to inspect this chat's current tabs.");
      const selected =
        value.view.visibility === "visible" &&
        value.view.selection.kind === "tool" &&
        value.view.selection.toolId === id;
      if (tool.kind === "browser") {
        if (!tool.pageId) throw new Error("This browser tab has no page yet.");
        return { kind: "browser", tabId: id, pageId: tool.pageId, selected };
      }
      const description = describeTool(tool, value);
      const pane = selected ? document.querySelector('[data-testid="workbench"]') : null;
      const box = pane?.getBoundingClientRect();
      const base = {
        kind: "pane" as const,
        tabId: id,
        tool:
          tool.kind === "changes"
            ? ("review" as const)
            : tool.kind === "file"
              ? ("files" as const)
              : tool.kind,
        title: workbenchToolLabel(tool).slice(0, 200),
        description: description.slice(0, 2000),
      };
      if (value.view.visibility !== "visible")
        return { ...base, unavailable: "The side pane is hidden. Use show to open it first." };
      if (!selected)
        return {
          ...base,
          unavailable: "This tab is not the selected side pane tab. Select it to capture it.",
        };
      if (!box || box.width <= 0 || box.height <= 0)
        return { ...base, unavailable: "The side pane has no visible area." };
      return { ...base, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
    };
    const execute = async (
      request: WorkbenchAgentRequest,
    ): Promise<{ state: WorkbenchAgentState; capture?: WorkbenchCaptureTarget }> => {
      checkTarget(request);
      const command = decodeWorkbenchAgentCommand(request.command);
      await waitFor(
        request,
        (value) =>
          value.ready &&
          (!value.view.tools.some((tool) => tool.kind === "browser") ||
            Boolean(value.browserState)),
      );
      const value = current.current.workbench;
      switch (command.action) {
        case "list":
          break;
        case "capture":
        case "read": {
          const id =
            command.tab_id ??
            (value.view.selection.kind === "tool" ? value.view.selection.toolId : undefined);
          if (!id) throw new Error("No side pane tab is selected. Use list to choose a tab_id.");
          const target = captureTarget(id);
          if (command.action === "read" && target.kind !== "browser")
            throw new Error(
              "read works on browser tabs only. Pass a browser tab_id from list, or use capture for this tab.",
            );
          return { state: state(), capture: target };
        }
        case "show":
        case "hide": {
          value.setVisibility(command.action === "show" ? "visible" : "hidden");
          await waitFor(
            request,
            (next) => next.view.visibility === (command.action === "show" ? "visible" : "hidden"),
          );
          break;
        }
        case "select":
        case "close": {
          const id = command.tab_id!;
          if (!value.view.tools.some((tool) => toolRefId(tool) === id))
            throw new Error("Unknown tab_id. Use list to inspect this chat's current tabs.");
          if (command.action === "select") value.activateTool(id);
          else value.closeTool(id);
          await waitFor(request, (next) =>
            command.action === "select"
              ? next.view.selection.kind === "tool" && next.view.selection.toolId === id
              : !next.view.tools.some((tool) => toolRefId(tool) === id),
          );
          break;
        }
        case "open": {
          if (command.tool === "extension") {
            const views = await api.listExtensionViews(request.target);
            checkTarget(request);
            if (
              !views.some(
                (view) =>
                  view.extensionId === command.extension_id &&
                  view.id === command.view_id &&
                  view.state === "ready",
              )
            )
              throw new Error("This extension view is unavailable in this chat.");
          }
          if (command.tool === "browser") {
            if (!value.browserState) {
              value.openTool({ kind: "browser" });
              await waitFor(request, (next) => Boolean(next.browserState?.activeTabId));
            } else value.activateTool("browser");
            checkTarget(request);
            const initial = current.current.workbench.browserState!;
            const created =
              !value.browserState &&
              initial.tabs.length === 1 &&
              initial.tabs[0]?.url === "about:blank"
                ? initial
                : await current.current.workbench.performBrowserAction({ kind: "new-tab" });
            const pageId = created.activeTabId;
            await waitFor(request, (next) =>
              Boolean(next.browserState?.tabs.some((tab) => tab.id === pageId)),
            );
            checkTarget(request);
            if (command.url) {
              const result = await current.current.workbench.performBrowserAction({
                kind: "navigate",
                tabId: pageId,
                url: command.url,
              });
              await waitFor(request, (next) =>
                Boolean(next.browserState && next.browserState.revision >= result.revision),
              );
            }
          } else if (command.tool === "files" && command.path) {
            await value.openFile(
              { workspaceId: request.target.workspaceId, path: command.path },
              () => checkTarget(request),
            );
            const id = toolRefId({ kind: "file", path: command.path });
            await waitFor(
              request,
              (next) =>
                next.view.visibility === "visible" &&
                next.view.selection.kind === "tool" &&
                next.view.selection.toolId === id,
            );
            break;
          } else if (command.tool === "terminal") {
            // The most recently used terminal, or a first one; new=true always adds a tab.
            const created = command.new ? await value.newTerminal() : undefined;
            checkTarget(request);
            if (!created) value.openTool({ kind: "terminal" });
            await waitFor(request, (next) => {
              const starting = next.activeTool?.kind === "terminal" && !next.activeTool.sessionId;
              if (starting && next.terminalError) throw new Error(next.terminalError);
              return (
                next.view.visibility === "visible" &&
                next.activeTool?.kind === "terminal" &&
                (created
                  ? next.activeTool.sessionId === created
                  : Boolean(next.activeTool.sessionId))
              );
            });
            break;
          } else {
            value.openTool(
              command.tool === "extension"
                ? {
                    kind: "extension",
                    extensionId: command.extension_id!,
                    viewId: command.view_id!,
                  }
                : { kind: command.tool === "review" ? "changes" : command.tool! },
            );
          }
          await waitFor(
            request,
            (next) =>
              next.view.visibility === "visible" &&
              next.activeTool?.kind === (command.tool === "review" ? "changes" : command.tool),
          );
          break;
        }
        default: {
          const id =
            command.tab_id ??
            (value.view.selection.kind === "tool" ? value.view.selection.toolId : "");
          const page = value.view.tools.find(
            (tool) => toolRefId(tool) === id && tool.kind === "browser",
          );
          if (!page || page.kind !== "browser" || !page.pageId)
            throw new Error("Select a browser tab first, or pass its tab_id from list.");
          value.activateTool(id);
          await waitFor(
            request,
            (next) => next.view.selection.kind === "tool" && next.view.selection.toolId === id,
          );
          checkTarget(request);
          const result = await current.current.workbench.performBrowserAction({
            kind: command.action,
            tabId: page.pageId,
            url: command.url,
          });
          await waitFor(request, (next) =>
            Boolean(next.browserState && next.browserState.revision >= result.revision),
          );
        }
      }
      checkTarget(request);
      return { state: state() };
    };
    const unsubscribe = api.onWorkbenchAgentRequest((request) => {
      active.add(request.id);
      queue = queue
        .then(async () => {
          try {
            const result = await execute(request);
            await api.respondWorkbenchAgentRequest({ id: request.id, ...result });
          } catch (error) {
            await api.respondWorkbenchAgentRequest({
              id: request.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          active.delete(request.id);
          cancelled.delete(request.id);
        })
        .catch(console.error);
    });
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeCancel();
      for (const listener of [...listeners.current]) listener();
    };
  }, [api]);
}
