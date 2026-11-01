import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  BrowserAction,
  BrowserPanelEvent,
  BrowserPanelState,
} from "../../../contracts/browser";
import { type ToolRef } from "../../../contracts/workbench";
import { BrowserPanel } from "./browser-panel";
import {
  activeWorkbenchTool,
  projectBrowserWorkbench,
  workbenchCloseNeighbor,
} from "./workbench-state";
import type { WorkbenchLayout } from "./use-workbench";

export function useBrowserWorkbench(
  api: PiDesktopApi | undefined,
  target: SessionRef | null,
  layout: WorkbenchLayout,
) {
  const enabled = Boolean(
    api && target && layout.ready && layout.view.tools.some((tool) => tool.kind === "browser"),
  );
  const mountId = useMemo(
    () => crypto.randomUUID(),
    [enabled, target?.workspaceId, target?.sessionId],
  );
  const [snapshot, setSnapshot] = useState<{
    mountId: string;
    state: BrowserPanelState;
    event?: BrowserPanelEvent;
  }>();
  const [failure, setFailure] = useState<{ mountId: string; message: string }>();
  const current = useRef({
    mountId,
    layout,
    alive: false,
    revision: -1,
    state: undefined as BrowserPanelState | undefined,
  });
  if (current.current.mountId !== mountId)
    current.current = { mountId, layout, alive: false, revision: -1, state: undefined };
  current.current.layout = layout;
  const accept = useCallback(
    (next: BrowserPanelState, event?: BrowserPanelEvent) => {
      const entry = current.current;
      if (entry.mountId !== mountId || !entry.alive || next.revision < entry.revision) return;
      const previous = entry.state;
      entry.revision = next.revision;
      entry.state = next;
      setSnapshot({ mountId, state: next, event });
      const closedSelected =
        previous &&
        entry.layout.view.selection.kind === "tool" &&
        entry.layout.view.selection.toolId === "browser" &&
        !next.tabs.some((tab) => tab.id === previous.activeTabId);
      if (closedSelected) {
        const neighbor = workbenchCloseNeighbor(
          projectBrowserWorkbench(entry.layout.view, previous),
          `browser:${previous.activeTabId}`,
        );
        if (neighbor && !neighbor.startsWith("browser:")) entry.layout.activateTool(neighbor);
      }
      if (!next.tabs.length) entry.layout.closeTool("browser");
      else if (
        !closedSelected &&
        previous &&
        previous.activeTabId !== next.activeTabId &&
        (next.tabs.length > previous.tabs.length ||
          (entry.layout.view.selection.kind === "tool" &&
            entry.layout.view.selection.toolId === "browser"))
      )
        entry.layout.activateTool("browser");
    },
    [mountId],
  );
  useEffect(() => {
    if (!enabled || !api || !target) return;
    current.current.alive = true;
    const unsubscribe = api.onBrowserChanged((event) => {
      if (event.mountId === mountId) accept(event.state, event);
    });
    api
      .attachBrowser({ mountId, target })
      .then((next) => accept(next))
      .catch((reason: unknown) => {
        if (current.current.mountId === mountId && current.current.alive)
          setFailure({ mountId, message: String(reason) });
      });
    return () => {
      if (current.current.mountId === mountId) current.current.alive = false;
      unsubscribe();
      api.detachBrowser(mountId).catch(console.error);
    };
  }, [api, enabled, mountId, target?.workspaceId, target?.sessionId, accept]);
  const lastAction = useRef(0);
  const act = useCallback(
    (action: Omit<BrowserAction, "mountId">) => {
      if (!api) return;
      const request = ++lastAction.current;
      setFailure(undefined);
      api
        .browserAction({ ...action, mountId })
        .then((next) => accept(next))
        .catch((reason: unknown) => {
          if (
            current.current.mountId === mountId &&
            current.current.alive &&
            request === lastAction.current
          )
            setFailure({
              mountId,
              message: reason instanceof Error ? reason.message : String(reason),
            });
        });
    },
    [api, mountId, accept],
  );
  const state = snapshot?.mountId === mountId ? snapshot.state : undefined;
  const view = useMemo(() => projectBrowserWorkbench(layout.view, state), [layout.view, state]);
  const openTool = useCallback(
    (tool: ToolRef) => {
      if (tool.kind === "browser" && enabled && current.current.state) {
        if (tool.pageId) act({ kind: "select-tab", tabId: tool.pageId });
        else act({ kind: "new-tab" });
        layout.openTool({ kind: "browser" });
      } else layout.openTool(tool);
    },
    [act, enabled, layout.openTool],
  );
  const activateTool = useCallback(
    (id: string) => {
      if (id.startsWith("browser:")) {
        act({ kind: "select-tab", tabId: id.slice(8) });
        layout.activateTool("browser");
      } else layout.activateTool(id);
    },
    [act, layout.activateTool],
  );
  const closeTool = useCallback(
    (id: string) => {
      if (id.startsWith("browser:")) act({ kind: "close-tab", tabId: id.slice(8) });
      else {
        const neighbor = workbenchCloseNeighbor(
          projectBrowserWorkbench(layout.view, current.current.state),
          id,
        );
        layout.closeTool(id);
        if (neighbor?.startsWith("browser:")) {
          act({ kind: "select-tab", tabId: neighbor.slice(8) });
          layout.activateTool("browser");
        }
      }
    },
    [act, layout.closeTool, layout.activateTool, layout.view],
  );
  return {
    ...layout,
    view,
    activeTool: activeWorkbenchTool(view),
    openTool,
    activateTool,
    closeTool,
    presentation: { view, browserTabs: state?.tabs },
    browserPanel:
      api && enabled ? (
        <BrowserPanel
          key={mountId}
          api={api}
          mountId={mountId}
          state={state ?? null}
          event={snapshot?.mountId === mountId ? snapshot.event : undefined}
          error={failure?.mountId === mountId ? failure.message : ""}
          act={act}
        />
      ) : null,
  };
}
