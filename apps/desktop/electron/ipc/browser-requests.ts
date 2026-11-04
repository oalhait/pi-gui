import type { BrowserAction, BrowserLayout, BrowserMount } from "../../contracts/browser";
import { desktopIpc } from "../../contracts/ipc";
import { browserOwnerFor } from "../platform/browser-owner";
import type { WindowOwner } from "../windows/window-owner";
import type { MainFrameHandler } from "./main-frame-ipc";
import { expectSessionTarget } from "./request-validation";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid browser request.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8192 || value.includes("\0"))
    throw new Error("Invalid browser request.");
  return value;
}
function mount(value: unknown): BrowserMount {
  const input = record(value);
  return { target: expectSessionTarget(input.target), mountId: text(input.mountId) };
}
function layout(value: unknown): BrowserLayout {
  const input = record(value),
    rect = record(input.bounds);
  for (const field of ["x", "y", "width", "height"])
    if (
      typeof rect[field] !== "number" ||
      !Number.isFinite(rect[field]) ||
      Math.abs(rect[field]) > 100_000
    )
      throw new Error("Invalid browser bounds.");
  if (typeof input.visible !== "boolean" || typeof input.focused !== "boolean")
    throw new Error("Invalid browser visibility.");
  return {
    mountId: text(input.mountId),
    visible: input.visible,
    focused: input.focused,
    bounds: {
      x: rect.x as number,
      y: rect.y as number,
      width: Math.max(0, rect.width as number),
      height: Math.max(0, rect.height as number),
    },
  };
}
function action(value: unknown): BrowserAction {
  const input = record(value);
  if (
    ![
      "navigate",
      "back",
      "forward",
      "reload",
      "stop",
      "new-tab",
      "select-tab",
      "close-tab",
    ].includes(text(input.kind))
  )
    throw new Error("Invalid browser action.");
  return {
    mountId: text(input.mountId),
    kind: input.kind as BrowserAction["kind"],
    tabId: input.tabId === undefined ? undefined : text(input.tabId),
    url:
      input.url === undefined
        ? undefined
        : typeof input.url === "string" && input.url === ""
          ? ""
          : text(input.url),
  };
}
export function registerBrowserRequests(handle: MainFrameHandler, windows: WindowOwner): void {
  const browser = () => browserOwnerFor(windows);
  handle(desktopIpc.browserAttach, mount, (input, request) =>
    browser().attach(request.window, input),
  );
  handle(desktopIpc.browserLayout, layout, (input, request) =>
    browser().layout(request.window, input),
  );
  handle(desktopIpc.browserDetach, text, (id, request) => browser().detach(request.window, id));
  handle(desktopIpc.browserAction, action, (input, request) =>
    browser().action(request.window, input),
  );
}
