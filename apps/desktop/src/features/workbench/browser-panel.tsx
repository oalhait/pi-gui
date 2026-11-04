import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import {
  browserShortcut,
  type BrowserAction,
  type BrowserPanelState,
  type BrowserPanelEvent,
} from "../../../contracts/browser";
import { BrowserPreviewIcon, ChevronRightIcon, CloseIcon, RefreshIcon } from "../../ui/icons";

export function BrowserPanel({
  api,
  mountId,
  state,
  event,
  error,
  act,
}: {
  readonly api: PiDesktopApi;
  readonly mountId: string;
  readonly state: BrowserPanelState | null;
  readonly event?: BrowserPanelEvent;
  readonly error: string;
  readonly act: (action: Omit<BrowserAction, "mountId">) => void;
}) {
  const [address, setAddress] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const editingAddress = useRef(false);
  const shownTabId = useRef<string | undefined>(undefined);
  const tab = state?.tabs.find((entry) => entry.id === state.activeTabId);
  useLayoutEffect(() => {
    if (event?.releaseAddress) {
      editingAddress.current = false;
      setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""));
    }
    if (event?.focusAddress) {
      addressInput.current?.focus();
      addressInput.current?.select();
    }
  }, [event]);

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
  }, [tab?.id, tab?.url]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !state) return;
    let frame = 0;
    let previous = "";
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      // The native page view paints above the DOM, so keep it clear of the workbench resize
      // handle; otherwise the handle only receives the pointer above the page.
      const handle = element
        .closest(".workbench")
        ?.querySelector(".workbench__resize-handle")
        ?.getBoundingClientRect();
      const left = handle ? Math.min(rect.right, Math.max(rect.left, handle.right)) : rect.left;
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
          rect.right - left > 0 &&
          rect.height > 0,
        bounds: { x: left, y: rect.y, width: rect.right - left, height: rect.height },
      };
      const serialized = JSON.stringify(layout);
      if (serialized === previous) return;
      previous = serialized;
      api.layoutBrowser(layout).catch((reason: unknown) => {
        console.error(reason);
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
      api
        .layoutBrowser({
          mountId,
          visible: false,
          focused: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        })
        .catch(console.error);
    };
  }, [api, error, mountId, state !== null, tab?.id, tab?.url, tab?.error]);

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
      {tab?.passkeyHint ? (
        <div className="browser-panel__notice" role="status" aria-label="Passkey sign-in">
          <p>
            Passkeys aren&rsquo;t available in pi-gui&rsquo;s browser. Use another sign-in option,
            like an email code, a password or a security key. On Google, choose &ldquo;Try another
            way&rdquo;. You can also sign in from your default browser, but that sign-in won&rsquo;t
            carry over here.
          </p>
          <div className="browser-panel__notice-actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => act({ kind: "open-external" })}
            >
              Open in default browser
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss passkey hint"
              onClick={() => act({ kind: "dismiss-passkey-hint" })}
            >
              <CloseIcon />
            </button>
          </div>
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
