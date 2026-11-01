import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import {
  browserShortcut,
  type BrowserAction,
  type BrowserPanelState,
} from "../../../contracts/browser";
import {
  BrowserPreviewIcon,
  ChevronRightIcon,
  CloseIcon,
  PlusIcon,
  RefreshIcon,
} from "../../ui/icons";

export function BrowserPanel({
  api,
  target,
}: {
  readonly api: PiDesktopApi;
  readonly target: WorkspaceSessionTarget;
}) {
  const [mountId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<BrowserPanelState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const lastRevision = useRef(-1);
  const lastAction = useRef(0);
  const acceptState = useCallback((next: BrowserPanelState) => {
    if (next.revision < lastRevision.current) return false;
    lastRevision.current = next.revision;
    setState(next);
    return true;
  }, []);
  const editingAddress = useRef(false);
  const shownTabId = useRef<string | undefined>(undefined);
  const tabList = useRef<HTMLDivElement>(null);
  const tab = state?.tabs.find((entry) => entry.id === state.activeTabId);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = api.onBrowserChanged((event) => {
      if (event.mountId !== mountId || !alive.current) return;
      if (event.releaseAddress) editingAddress.current = false;
      const accepted = acceptState(event.state);
      if (accepted && event.releaseAddress) {
        const url = event.state.tabs.find((entry) => entry.id === event.state.activeTabId)?.url;
        setAddress(url === "about:blank" ? "" : (url ?? ""));
      }
      if (accepted && event.focusAddress) {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    });
    api
      .attachBrowser({ mountId, target })
      .then((next) => {
        if (alive.current) acceptState(next);
      })
      .catch((reason: unknown) => {
        if (alive.current) setError(String(reason));
      });
    return () => {
      alive.current = false;
      unsubscribe();
      api.detachBrowser(mountId).catch(console.error);
    };
  }, [api, mountId, target.workspaceId, target.sessionId, acceptState]);

  useEffect(() => {
    const stopEditing = () => {
      editingAddress.current = false;
    };
    window.addEventListener("blur", stopEditing);
    return () => window.removeEventListener("blur", stopEditing);
  }, []);

  useLayoutEffect(() => {
    if (
      shownTabId.current !== tab?.id ||
      !document.hasFocus() ||
      document.activeElement !== addressInput.current
    )
      editingAddress.current = false;
    if (!editingAddress.current) setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
    shownTabId.current = tab?.id;
    tabList.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab?.id, tab?.url]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !state) return;
    let frame = 0;
    let previous = "";
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const overlay = document.querySelector(
        '[role="dialog"], [role="menu"], [aria-modal="true"], .sidebar-drawer-backdrop',
      );
      const layout = {
        mountId,
        focused: Boolean(element.closest(".browser-panel")?.contains(document.activeElement)),
        visible:
          !overlay &&
          !tab?.error &&
          tab?.url !== "about:blank" &&
          rect.width > 0 &&
          rect.height > 0,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      const serialized = JSON.stringify(layout);
      if (serialized === previous) return;
      previous = serialized;
      api.layoutBrowser(layout).catch((reason: unknown) => {
        if (alive.current) setError(String(reason));
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "open"],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", update);
    window.addEventListener("scroll", schedule, true);
    update();
    return () => {
      document.removeEventListener("focusin", update);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [api, error, mountId, state !== null, tab?.id, tab?.url, tab?.error]);

  const act = useCallback(
    (action: Omit<BrowserAction, "mountId">) => {
      const request = ++lastAction.current;
      setError("");
      api
        .browserAction({ ...action, mountId })
        .then((next) => {
          if (alive.current) acceptState(next);
        })
        .catch((reason: unknown) => {
          if (alive.current && request === lastAction.current)
            setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [api, mountId, acceptState],
  );

  return (
    <section
      className="browser-panel"
      data-testid="browser-panel"
      aria-label="Browser"
      onKeyDown={(event) => {
        const kind = browserShortcut({
          key: event.key,
          meta: event.metaKey,
          control: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          platform: api.platform,
        });
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        if (kind === "focus-address") {
          addressInput.current?.focus();
          addressInput.current?.select();
        } else {
          act({ kind });
          if (kind === "new-tab") addressInput.current?.focus();
        }
      }}
    >
      <div className="browser-panel__tabs">
        <div role="tablist" aria-label="Browser tabs" ref={tabList}>
          {state?.tabs.map((entry) => (
            <div
              className={`browser-panel__tab${entry.id === state.activeTabId ? " browser-panel__tab--active" : ""}`}
              key={entry.id}
            >
              <button
                type="button"
                role="tab"
                aria-selected={entry.id === state.activeTabId}
                title={entry.url}
                onClick={() => act({ kind: "select-tab", tabId: entry.id })}
              >
                {entry.loading ? (
                  <span className="session-row__status session-row__status--running" />
                ) : (
                  <BrowserPreviewIcon />
                )}
                <span>{entry.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close browser tab ${entry.title}`}
                onClick={() => act({ kind: "close-tab", tabId: entry.id })}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="New browser tab"
          disabled={!state}
          onClick={() => {
            act({ kind: "new-tab" });
            addressInput.current?.focus();
          }}
        >
          <PlusIcon />
        </button>
      </div>
      <form
        className="browser-panel__toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          editingAddress.current = false;
          act({ kind: "navigate", url: addressInput.current?.value ?? address });
        }}
      >
        <button
          className="icon-button browser-panel__back"
          type="button"
          aria-label="Browser back"
          disabled={!tab?.canGoBack}
          onClick={() => act({ kind: "back" })}
        >
          <ChevronRightIcon />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Browser forward"
          disabled={!tab?.canGoForward}
          onClick={() => act({ kind: "forward" })}
        >
          <ChevronRightIcon />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={tab?.loading ? "Stop loading page" : "Reload page"}
          disabled={!tab}
          onClick={() => act({ kind: tab?.loading ? "stop" : "reload" })}
        >
          {tab?.loading ? <CloseIcon /> : <RefreshIcon />}
        </button>
        <input
          ref={addressInput}
          aria-label="Browser address"
          disabled={!state}
          placeholder="Search or enter address"
          autoComplete="off"
          spellCheck={false}
          value={address}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => {
            editingAddress.current = false;
            setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
          }}
          onChange={(event) => {
            editingAddress.current = true;
            setAddress(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              editingAddress.current = false;
              setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
              event.currentTarget.blur();
            }
          }}
        />
        <button className="icon-button" type="submit" aria-label="Open address" disabled={!state}>
          <ChevronRightIcon />
        </button>
      </form>
      {state?.warning ? (
        <div className="browser-panel__error" role="status">
          {state.warning}
        </div>
      ) : null}
      {error || tab?.error ? (
        <div className="browser-panel__error" role="alert">
          {error || tab?.error}
        </div>
      ) : null}
      <div className="browser-panel__viewport" ref={viewport} data-browser-tab-id={tab?.id}>
        {!state ? (
          <p role="status">Opening browser…</p>
        ) : tab?.url === "about:blank" ? (
          <div className="browser-panel__empty">
            <BrowserPreviewIcon />
            <h2>Browse alongside your chat</h2>
            <p>Enter a website or a localhost address above.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function renderBrowserPanel(
  api: PiDesktopApi | undefined,
  target: WorkspaceSessionTarget | null,
  key: string,
) {
  return api && target ? <BrowserPanel key={key} api={api} target={target} /> : null;
}
