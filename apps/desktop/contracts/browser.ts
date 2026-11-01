import type { WorkspaceSessionTarget } from "./desktop-state";

export interface BrowserTabState {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error?: string;
}
export interface BrowserPanelState {
  readonly revision: number;
  readonly warning?: string;
  readonly tabs: readonly BrowserTabState[];
  readonly activeTabId: string;
}
export interface BrowserMount {
  readonly target: WorkspaceSessionTarget;
  readonly mountId: string;
}
export interface BrowserLayout {
  readonly mountId: string;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}
export interface BrowserAction {
  readonly mountId: string;
  readonly kind:
    "navigate" | "back" | "forward" | "reload" | "stop" | "new-tab" | "select-tab" | "close-tab";
  readonly tabId?: string;
  readonly url?: string;
}
export interface BrowserPanelEvent {
  readonly mountId: string;
  readonly state: BrowserPanelState;
  readonly focusAddress?: boolean;
  readonly releaseAddress?: boolean;
}

export function browserUrl(input: string): string {
  const value = input.trim();
  if (!value || value === "about:blank") return "about:blank";
  if (value.length > 8192) throw new Error("Address is too long.");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value);
  const hostPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(value);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !local && !hostPort;
  const address = explicitScheme
    ? value
    : local
      ? `http://${value}`
      : /^\S+\.\S+(\/|$)/.test(value)
        ? `https://${value}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS pages can be opened.");
  if (url.username || url.password)
    throw new Error("Enter an address without embedded credentials.");
  return url.href;
}

export function isBrowserNavigationAllowed(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function browserShortcut(input: {
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly platform: string;
}): BrowserAction["kind"] | "focus-address" | undefined {
  if (!(input.platform === "darwin" ? input.meta : input.control) || input.alt || input.shift)
    return undefined;
  const actions = {
    "[": "back",
    "]": "forward",
    r: "reload",
    t: "new-tab",
    w: "close-tab",
    l: "focus-address",
  } as const;
  return actions[input.key.toLowerCase() as keyof typeof actions];
}
