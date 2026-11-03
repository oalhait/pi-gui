import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { RefreshIcon } from "../../ui/icons";
import { getSidePanelTabCommand } from "../../../contracts/ipc";
import type {
  TerminalPanelSnapshot,
  TerminalSessionSnapshot,
  TerminalSize,
} from "../../../contracts/ipc";
import { getActiveTheme, useActiveTheme } from "../../ui/active-theme";
import { terminalThemeFor } from "./terminal-theme";

interface TerminalPanelProps {
  /** The one terminal this tab shows. */
  readonly session: TerminalSessionSnapshot;
  /** Output so far, read once when the view mounts. */
  readonly replay: (terminalId: string) => string;
  readonly onPanelChange: (panel: TerminalPanelSnapshot | null) => void;
  readonly onTitleChange: (terminalId: string, title: string) => void;
  /** Starts another terminal in its own tab. */
  readonly onNewTerminal: () => Promise<unknown>;
  /** Whether the new view may take focus: false once the user moved focus elsewhere. */
  readonly shouldFocus: () => boolean;
}

export function TerminalPanel({
  session,
  replay,
  onPanelChange,
  onTitleChange,
  onNewTerminal,
  shouldFocus,
}: TerminalPanelProps) {
  const api = window.piApp;
  const terminalId = session.id;
  const panelRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const focusRequested = useRef<boolean | null>(null);
  if (focusRequested.current === null) focusRequested.current = shouldFocus();
  const lastSizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 });
  const [error, setError] = useState<string>("");
  const activeTheme = useActiveTheme();
  const callbacks = useRef({ replay, onTitleChange, onNewTerminal });
  callbacks.current = { replay, onTitleChange, onNewTerminal };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalThemeFor(activeTheme);
  }, [activeTheme]);

  const restartTerminal = useCallback(async () => {
    if (!api) {
      return;
    }
    const nextPanel = await api.restartTerminalSession(terminalId, lastSizeRef.current);
    terminalRef.current?.reset();
    onPanelChange(nextPanel);
  }, [api, onPanelChange, terminalId]);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon || !containerRef.current) {
      return;
    }
    fitAddon.fit();
    const nextSize = { cols: terminal.cols, rows: terminal.rows };
    if (nextSize.cols === lastSizeRef.current.cols && nextSize.rows === lastSizeRef.current.rows) {
      return;
    }
    lastSizeRef.current = nextSize;
    void api.resizeTerminal(terminalId, nextSize).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [api, terminalId]);

  useLayoutEffect(() => {
    const panelElement = panelRef.current;
    if (!api || !panelElement) {
      return undefined;
    }
    const markFocused = () => {
      void api.setTerminalFocused(true).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
    const markBlurred = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && panelElement.contains(event.relatedTarget)) {
        return;
      }
      void api.setTerminalFocused(false).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
    const trackFocusRequest = (event: FocusEvent) => {
      focusRequested.current = event.target instanceof Node && panelElement.contains(event.target);
    };
    document.addEventListener("focusin", trackFocusRequest);
    panelElement.addEventListener("focusin", markFocused);
    panelElement.addEventListener("focusout", markBlurred);
    return () => {
      document.removeEventListener("focusin", trackFocusRequest);
      panelElement.removeEventListener("focusin", markFocused);
      panelElement.removeEventListener("focusout", markBlurred);
      void api.setTerminalFocused(false).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    // Output is written straight to the view; the workbench keeps the replay for remounts.
    const removeData = api.onTerminalData((event) => {
      if (event.terminalId === terminalId) terminalRef.current?.write(event.data);
    });
    const removeError = api.onTerminalError((event) => {
      if (event.terminalId === terminalId) terminalRef.current?.write(`${event.message}\r\n`);
    });
    return () => {
      removeData();
      removeError();
    };
  }, [api, terminalId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!api || !container) {
      return undefined;
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      scrollback: 2_000,
      theme: terminalThemeFor(getActiveTheme()),
    });
    const fitAddon = new FitAddon();
    const clipboardAddon = new ClipboardAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      void api.openExternal(uri).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(clipboardAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      if (
        getSidePanelTabCommand(api.platform, {
          meta: event.metaKey,
          control: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          key: event.key,
          code: event.code,
        })
      ) {
        // Side panel tab chords switch tabs; the shell never sees them.
        return false;
      }
      const commandModifier = api.platform === "darwin" ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (commandModifier && !event.shiftKey && key === "t") {
        // The shell keeps New Tab: it opens another terminal in its own tab.
        void callbacks.current.onNewTerminal().catch((error: unknown) => {
          setError(error instanceof Error ? error.message : String(error));
        });
        return false;
      }
      if (api.platform !== "darwin" && event.ctrlKey && !event.metaKey && !event.altKey) {
        // Hand these chords back to the browser instead of letting xterm turn them into
        // control characters: paste (Ctrl+V on Windows, Ctrl+Shift+V on Linux, where
        // shells keep Ctrl+V) and Ctrl+J, which App's window listener routes to the terminal
        // toggle. Match the typed letter, not the physical key, so other layouts keep theirs.
        const pasteChord = api.platform === "win32" ? !event.shiftKey : event.shiftKey;
        if ((key === "v" && pasteChord) || (key === "j" && !event.shiftKey)) {
          return false;
        }
      }
      if (api.platform === "darwin" && event.metaKey) {
        const sequence = macTerminalSequenceForEvent(event);
        if (sequence) {
          void api.writeTerminal(terminalId, sequence).catch((error: unknown) => {
            setError(error instanceof Error ? error.message : String(error));
          });
          return false;
        }
      }
      return true;
    });
    terminal.onData((data) => {
      void api.writeTerminal(terminalId, data).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    });
    terminal.onTitleChange((title) => callbacks.current.onTitleChange(terminalId, title));
    terminal.open(container);
    const replayed = callbacks.current.replay(terminalId);
    if (replayed) {
      terminal.write(replayed);
    }
    if (focusRequested.current) terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    window.requestAnimationFrame(fitAndResize);

    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      fitAddonRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [api, fitAndResize, terminalId]);

  return (
    <section
      ref={panelRef}
      className="terminal-panel"
      data-pi-terminal="true"
      data-testid="integrated-terminal"
    >
      <div className="terminal-panel__toolbar">
        <span className="terminal-panel__cwd" title={session.cwd}>
          {session.cwd}
        </span>
        {session.status === "running" ? null : (
          <span className="terminal-panel__exit" role="status">
            {session.status === "error"
              ? "Terminal failed"
              : `Exited${session.exitCode === undefined ? "" : ` (${session.exitCode})`}`}
          </span>
        )}
        <div className="terminal-panel__actions">
          <button
            type="button"
            className="icon-button terminal-panel__action"
            title="Restart terminal"
            aria-label="Restart terminal"
            onClick={() =>
              void restartTerminal().catch((error: unknown) => {
                setError(error instanceof Error ? error.message : String(error));
              })
            }
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      {error ? (
        <div className="terminal-panel__error">{error}</div>
      ) : (
        <div className="terminal-panel__viewport" ref={containerRef} />
      )}
    </section>
  );
}

function macTerminalSequenceForEvent(event: KeyboardEvent): string | undefined {
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      return "\x01";
    case "ArrowRight":
    case "ArrowDown":
      return "\x05";
    case "Backspace":
      return "\x15";
    case "Delete":
      return "\x0b";
    default:
      return undefined;
  }
}
