import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type {
  PiDesktopApi,
  TerminalPanelSnapshot,
  TerminalSessionSnapshot,
} from "../../../contracts/ipc";
import { appendTerminalReplay, type TerminalReplayUpdate } from "../../../contracts/terminal-model";
import type { ToolRef } from "../../../contracts/workbench";
import type { useBrowserWorkbench } from "./use-browser-workbench";
import {
  activeWorkbenchTool,
  projectTerminalWorkbench,
  workbenchCloseNeighbor,
} from "./workbench-state";

type BrowserWorkbench = ReturnType<typeof useBrowserWorkbench>;

const TERMINAL_PREFIX = "terminal:";
/** A shell starts at this size; its view fits it to the pane once it mounts. */
const INITIAL_TERMINAL_SIZE = { cols: 80, rows: 24 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows each of this chat's terminals as its own top-level tab. Terminals belong to the main
 * process and are never saved: the layout keeps one `terminal` slot, and this hook expands it
 * into one tab per live terminal. Replay bytes stay in a ref so output never re-renders the app.
 */
export function useTerminalWorkbench(
  api: PiDesktopApi | undefined,
  target: SessionRef | null,
  inner: BrowserWorkbench,
) {
  const key = target ? JSON.stringify([target.workspaceId, target.sessionId]) : "";
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    /** Null when this chat has no terminal in this window. */
    readonly panel: TerminalPanelSnapshot | null;
  }>();
  const [failure, setFailure] = useState<{ readonly key: string; readonly message: string }>();
  const replays = useRef(new Map<string, TerminalReplayUpdate>());
  // Where focus was when a terminal was last requested. A terminal that appears later takes
  // focus only if the user has not moved it elsewhere meanwhile, such as into the composer.
  const focusAtRequest = useRef<Element | null>(null);
  const requestFocus = () => {
    focusAtRequest.current = document.activeElement;
  };
  const panel = loaded?.key === key ? loaded.panel : undefined;
  const current = useRef({ api, target, key, inner, panel });
  current.current = { api, target, key, inner, panel };

  const accept = useCallback((forKey: string, next: TerminalPanelSnapshot | null) => {
    if (current.current.key !== forKey) return;
    for (const session of next?.sessions ?? [])
      replays.current.set(session.id, { replay: session.replay, truncated: session.truncated });
    setLoaded({
      key: forKey,
      panel: next
        ? { ...next, sessions: next.sessions.map((session) => ({ ...session, replay: "" })) }
        : null,
    });
    setFailure(undefined);
  }, []);
  const fail = useCallback((forKey: string, error: unknown) => {
    if (current.current.key === forKey) setFailure({ key: forKey, message: errorMessage(error) });
  }, []);
  const updateSession = useCallback(
    (terminalId: string, update: (session: TerminalSessionSnapshot) => TerminalSessionSnapshot) =>
      setLoaded((previous) =>
        previous?.panel?.sessions.some((session) => session.id === terminalId)
          ? {
              ...previous,
              panel: {
                ...previous.panel,
                sessions: previous.panel.sessions.map((session) =>
                  session.id === terminalId ? update(session) : session,
                ),
              },
            }
          : previous,
      ),
    [],
  );

  // Terminals outlive task switches; read this chat's live set without starting a shell.
  const workspaceId = target?.workspaceId;
  const sessionId = target?.sessionId;
  useEffect(() => {
    if (!api || !workspaceId || !sessionId) return;
    const forKey = JSON.stringify([workspaceId, sessionId]);
    api.getTerminalPanel(workspaceId, sessionId).then(
      (next) => accept(forKey, next),
      (error: unknown) => {
        fail(forKey, error);
      },
    );
  }, [accept, api, fail, sessionId, workspaceId]);

  useEffect(() => {
    if (!api) return undefined;
    const removeData = api.onTerminalData((event) => {
      const replay = replays.current.get(event.terminalId);
      if (replay)
        replays.current.set(
          event.terminalId,
          appendTerminalReplay(replay.replay, event.data, replay.truncated),
        );
    });
    const removeExit = api.onTerminalExit((event) =>
      updateSession(event.terminalId, (session) => ({
        ...session,
        status: "exited",
        exitCode: event.exitCode,
        signal: event.signal,
      })),
    );
    const removeError = api.onTerminalError((event) => {
      const replay = replays.current.get(event.terminalId);
      if (replay)
        replays.current.set(
          event.terminalId,
          appendTerminalReplay(replay.replay, `${event.message}\r\n`, replay.truncated),
        );
      updateSession(event.terminalId, (session) => ({ ...session, status: "error" }));
    });
    return () => {
      removeData();
      removeExit();
      removeError();
    };
  }, [api, updateSession]);

  // A selected Terminal slot without a live shell (a new tab, or after a restart) starts one.
  const wantsShell =
    inner.ready &&
    panel === null &&
    inner.view.visibility === "visible" &&
    inner.view.selection.kind === "tool" &&
    inner.view.selection.toolId === "terminal";
  const starting = useRef("");
  useEffect(() => {
    if (!wantsShell || !api || !workspaceId || !sessionId) return;
    const forKey = JSON.stringify([workspaceId, sessionId]);
    if (starting.current === forKey) return;
    starting.current = forKey;
    api
      .ensureTerminalPanel(workspaceId, sessionId, INITIAL_TERMINAL_SIZE)
      .then(
        (next) => accept(forKey, next),
        (error: unknown) => fail(forKey, error),
      )
      .finally(() => {
        if (starting.current === forKey) starting.current = "";
      });
  }, [accept, api, fail, sessionId, wantsShell, workspaceId]);

  /** Always starts another terminal in its own tab. */
  const newTerminal = useCallback(async (): Promise<string> => {
    const { api: desktopApi, target: ref, key: forKey } = current.current;
    if (!desktopApi || !ref) throw new Error("Terminal is unavailable.");
    requestFocus();
    try {
      const next = await desktopApi.createTerminalSession(
        ref.workspaceId,
        ref.sessionId,
        INITIAL_TERMINAL_SIZE,
      );
      accept(forKey, next);
      if (current.current.key === forKey) current.current.inner.openTool({ kind: "terminal" });
      return next.activeSessionId;
    } catch (error) {
      fail(forKey, error);
      throw error;
    }
  }, [accept, fail]);

  const activateTool = useCallback(
    (id: string) => {
      const { api: desktopApi, target: ref, key: forKey, inner: wrapped } = current.current;
      if (!id.startsWith(TERMINAL_PREFIX)) {
        wrapped.activateTool(id);
        return;
      }
      const terminalId = id.slice(TERMINAL_PREFIX.length);
      requestFocus();
      setLoaded((previous) =>
        previous?.key === forKey && previous.panel
          ? { ...previous, panel: { ...previous.panel, activeSessionId: terminalId } }
          : previous,
      );
      wrapped.activateTool("terminal");
      if (desktopApi && ref)
        desktopApi.setActiveTerminalSession(ref.workspaceId, ref.sessionId, terminalId).then(
          (next) => accept(forKey, next),
          (error: unknown) => fail(forKey, error),
        );
    },
    [accept, fail],
  );

  const openTool = useCallback(
    (tool: ToolRef) => {
      if (tool.kind === "terminal" && tool.sessionId)
        activateTool(`${TERMINAL_PREFIX}${tool.sessionId}`);
      // The most recently used terminal, or a first one when the chat has none.
      else if (tool.kind === "terminal") {
        requestFocus();
        current.current.inner.openTool({ kind: "terminal" });
      } else current.current.inner.openTool(tool);
    },
    [activateTool],
  );

  const view = useMemo(
    () => projectTerminalWorkbench(inner.view, panel ?? undefined),
    [inner.view, panel],
  );
  const viewRef = useRef(view);
  viewRef.current = view;

  const closeTool = useCallback(
    (id: string) => {
      const { api: desktopApi, key: forKey, inner: wrapped } = current.current;
      if (!id.startsWith(TERMINAL_PREFIX)) {
        wrapped.closeTool(id);
        return;
      }
      if (!desktopApi) return;
      const terminalId = id.slice(TERMINAL_PREFIX.length);
      const neighbor = workbenchCloseNeighbor(viewRef.current, id);
      desktopApi.closeTerminalSession(terminalId).then(
        (next) => {
          replays.current.delete(terminalId);
          accept(forKey, next);
          if (current.current.key !== forKey) return;
          if (!next) current.current.inner.closeTool("terminal");
          else if (neighbor && !neighbor.startsWith(TERMINAL_PREFIX))
            current.current.inner.activateTool(neighbor);
        },
        (error: unknown) => fail(forKey, error),
      );
    },
    [accept, fail],
  );

  /** The Add tab menu: Terminal always adds a terminal; other kinds open or focus their tab. */
  const openNewTab = useCallback(
    (tool: ToolRef) => {
      if (tool.kind === "terminal") newTerminal().catch(() => undefined);
      else current.current.inner.openTool(tool);
    },
    [newTerminal],
  );

  const setTerminalTitle = useCallback(
    (terminalId: string, title: string) => {
      const desktopApi = current.current.api;
      desktopApi?.setTerminalTitle(terminalId, title).catch(console.error);
      const trimmed = title.trim();
      if (trimmed)
        updateSession(terminalId, (session) => ({ ...session, title: trimmed.slice(0, 80) }));
    },
    [updateSession],
  );
  const acceptTerminalPanel = useCallback(
    (next: TerminalPanelSnapshot | null) => accept(current.current.key, next),
    [accept],
  );
  const shouldFocusTerminal = useCallback(() => {
    const active = document.activeElement;
    return (
      !active ||
      active === document.body ||
      active === focusAtRequest.current ||
      !active.isConnected ||
      Boolean(active.closest("#task-workbench"))
    );
  }, []);
  const terminalReplay = useCallback(
    (terminalId: string) => replays.current.get(terminalId)?.replay ?? "",
    [],
  );

  return {
    ...inner,
    view,
    activeTool: activeWorkbenchTool(view),
    openTool,
    activateTool,
    closeTool,
    newTerminal,
    openNewTab,
    presentation: {
      ...inner.presentation,
      view,
      terminalSessions: panel?.sessions,
    },
    terminalSessions: panel?.sessions ?? [],
    terminalError: failure?.key === key ? failure.message : "",
    setTerminalTitle,
    acceptTerminalPanel,
    terminalReplay,
    shouldFocusTerminal,
  };
}
