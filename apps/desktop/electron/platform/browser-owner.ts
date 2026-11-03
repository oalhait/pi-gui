import {
  app,
  session,
  WebContentsView,
  type BrowserWindow,
  type NativeImage,
  type Session,
  type WebContents,
  type Input,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  browserUrl,
  browserShortcut,
  isBrowserNavigationAllowed,
  type BrowserAction,
  type BrowserLayout,
  type BrowserMount,
  type BrowserPanelState,
  type BrowserTabState,
} from "../../contracts/browser";
import {
  desktopIpc,
  getDesktopCommandFromShortcut,
  getSidePanelTabCommand,
  platformShortcutModifier,
} from "../../contracts/ipc";
import type { WindowOwner } from "../windows/window-owner";

const chromeShortcuts = new WeakMap<
  WebContents,
  (event: Electron.Event, input: Input) => boolean
>();
export function routeBrowserChromeShortcut(
  contents: WebContents,
  event: Electron.Event,
  input: Input,
): boolean {
  return chromeShortcuts.get(contents)?.(event, input) ?? false;
}

interface Tab {
  readonly id: string;
  readonly view: WebContentsView;
  url: string;
  error?: string;
}
interface Root {
  revision: number;
  readonly key: string;
  readonly tabs: Tab[];
  activeTabId: string;
  warning?: string;
}
interface Host {
  readonly id: number;
  readonly window: BrowserWindow;
  readonly roots: Map<string, Root>;
  mount?: BrowserMount;
  root?: Root;
  layout?: BrowserLayout;
  visibleTab?: Tab;
}
export interface BrowserPageCapture {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The page's native view is currently presented in the side pane. */
  readonly shown: boolean;
  readonly image?: NativeImage;
  readonly unavailable?: string;
}
interface SavedRoot {
  readonly urls: readonly string[];
  readonly active: number;
}

const owners = new WeakMap<WindowOwner, BrowserOwner>();
/** The one lazily created browser owner for these windows, shared by IPC and agent capture. */
export function browserOwnerFor(windows: WindowOwner): BrowserOwner {
  let owner = owners.get(windows);
  if (!owner) {
    owner = new BrowserOwner(windows);
    owners.set(windows, owner);
  }
  return owner;
}

export class BrowserOwner {
  private readonly hosts = new Map<number, Host>();
  private readonly storagePath = path.join(app.getPath("userData"), "browser-tabs.json");
  private readonly saved: Record<string, SavedRoot>;
  private readonly browserSession: Session;
  private writeQueue = Promise.resolve();

  constructor(private readonly windows: WindowOwner) {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.storagePath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid browser tabs file");
      this.saved = {};
      for (const [key, value] of Object.entries(raw)) {
        const entry = value as Partial<SavedRoot> | null;
        if (
          !entry ||
          !Array.isArray(entry.urls) ||
          entry.urls.length > 32 ||
          !entry.urls.every(
            (url: unknown) => typeof url === "string" && isBrowserNavigationAllowed(url),
          ) ||
          !Number.isInteger(entry.active)
        )
          throw new Error("Invalid browser tabs file");
        this.saved[key] = { urls: entry.urls as string[], active: entry.active ?? 0 };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.saved = {};
    }
    this.browserSession = session.fromPartition("persist:pi-browser");
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    this.browserSession.setPermissionCheckHandler(() => false);
    app.once("will-quit", (event) => {
      event.preventDefault();
      this.writeQueue
        .then(() => this.browserSession.cookies.flushStore())
        .catch(console.error)
        .finally(() => app.quit())
        .catch(console.error);
    });
  }

  attach(window: BrowserWindow, mount: BrowserMount): BrowserPanelState {
    this.assertTarget(window, mount);
    let host = this.hosts.get(window.webContents.id);
    if (!host) {
      host = { id: window.webContents.id, window, roots: new Map() };
      this.hosts.set(window.webContents.id, host);
      const owned = host;
      window.once("closed", () => this.dispose(owned));
      window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) this.detach(window, owned.mount?.mountId ?? "");
      });
      window.webContents.on("render-process-gone", () =>
        this.detach(window, owned.mount?.mountId ?? ""),
      );
    }
    this.hide(host);
    const key = JSON.stringify([mount.target.workspaceId, mount.target.sessionId]);
    let root = host.roots.get(key);
    if (!root) {
      root = { key, tabs: [], activeTabId: "", revision: 0 };
      host.roots.set(key, root);
      const saved = this.saved[key];
      for (const url of saved?.urls.length ? saved.urls : ["about:blank"])
        this.createTab(host, root, url);
      root.activeTabId = root.tabs[saved?.active ?? 0]?.id ?? root.tabs[0]?.id ?? "";
    }
    if (!root.tabs.length) root.activeTabId = this.createTab(host, root, "about:blank").id;
    const activeHost = host;
    chromeShortcuts.set(window.webContents, (event, input) =>
      activeHost.layout?.focused ? this.shortcut(activeHost, event, input) : false,
    );
    host.mount = mount;
    host.root = root;
    host.layout = undefined;
    return this.nextSnapshot(root);
  }

  layout(window: BrowserWindow, layout: BrowserLayout): void {
    const host = this.hosts.get(window.webContents.id);
    if (!host?.mount || host.mount.mountId !== layout.mountId) return;
    this.assertTarget(window, host.mount);
    host.layout = layout;
    this.present(host);
  }

  detach(window: BrowserWindow, mountId: string): void {
    const host = this.hosts.get(window.webContents.id);
    if (host?.mount?.mountId !== mountId) return;
    this.hide(host);
    chromeShortcuts.delete(window.webContents);
    host.mount = undefined;
    host.layout = undefined;
  }

  action(window: BrowserWindow, action: BrowserAction): BrowserPanelState {
    const host = this.hosts.get(window.webContents.id);
    if (!host?.mount || host.mount.mountId !== action.mountId || !host.root)
      throw new Error("Browser panel is no longer active.");
    this.assertTarget(window, host.mount);
    const root = host.root;
    root.warning = undefined;
    const tab = root.tabs.find((entry) => entry.id === (action.tabId ?? root.activeTabId));
    if (action.kind === "new-tab") {
      if (root.tabs.length >= 32) throw new Error("Close a browser tab before opening another.");
      root.activeTabId = this.createTab(host, root, "about:blank").id;
    } else {
      if (!tab) throw new Error("Unknown browser tab.");
      const contents = tab.view.webContents;
      switch (action.kind) {
        case "navigate":
          this.navigate(host, root, tab, browserUrl(action.url ?? ""));
          break;
        case "back":
          if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
          break;
        case "forward":
          if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
          break;
        case "reload":
          if (tab.error) this.navigate(host, root, tab, tab.url);
          else contents.reload();
          break;
        case "stop":
          contents.stop();
          break;
        case "select-tab":
          root.activeTabId = tab.id;
          break;
        case "close-tab": {
          const index = root.tabs.indexOf(tab);
          root.tabs.splice(index, 1);
          host.window.contentView.removeChildView(tab.view);
          contents.close();
          if (root.activeTabId === tab.id)
            root.activeTabId = root.tabs[Math.min(index, root.tabs.length - 1)]?.id ?? "";

          break;
        }
      }
    }
    this.present(host);
    this.save(host, root);
    this.publish(host, root);
    return this.nextSnapshot(root);
  }

  /**
   * Read-only snapshot of one of a chat's pages, captured from the page's own contents so the
   * window can be in the background or covered. Never changes tabs, selection or visibility.
   */
  async capturePage(
    window: BrowserWindow,
    target: BrowserMount["target"],
    pageId: string,
  ): Promise<BrowserPageCapture> {
    const host = this.hosts.get(window.webContents.id);
    const root = host?.roots.get(JSON.stringify([target.workspaceId, target.sessionId]));
    const tab = root?.tabs.find((entry) => entry.id === pageId);
    if (!host || !root || !tab || tab.view.webContents.isDestroyed())
      throw new Error("This browser page is not loaded in this chat's side pane.");
    const contents = tab.view.webContents;
    const bounds = tab.view.getBounds();
    const page = {
      url: tab.url,
      title: tab.url === "about:blank" ? "New tab" : contents.getTitle() || "New tab",
      loading: contents.isLoading(),
      ...(tab.error ? { error: tab.error } : {}),
      viewport: { width: bounds.width, height: bounds.height },
      shown: host.root === root && host.visibleTab === tab && Boolean(host.layout?.visible),
    };
    if (tab.error) return { ...page, unavailable: `The page failed to load: ${tab.error}` };
    if (tab.url === "about:blank")
      return { ...page, unavailable: "The browser tab is blank (about:blank)." };
    if (contents.isCrashed())
      return { ...page, unavailable: "The page stopped responding. Reload it first." };
    if (bounds.width <= 0 || bounds.height <= 0)
      return {
        ...page,
        unavailable:
          "This page has not been shown in the side pane yet, so it has no rendered viewport. Select its tab first.",
      };
    const image = await contents.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty())
      return { ...page, unavailable: "The page has not rendered any content yet." };
    return { ...page, image };
  }

  private assertTarget(window: BrowserWindow, mount: BrowserMount): void {
    const view = this.windows.viewForWindow(window);
    if (
      view.activeView !== "threads" ||
      view.selectedWorkspaceId !== mount.target.workspaceId ||
      view.selectedSessionId !== mount.target.sessionId
    )
      throw new Error("Browser belongs to a different chat.");
  }

  private createTab(
    host: Host,
    root: Root,
    url = "about:blank",
    adoptedContents?: WebContents,
  ): Tab {
    const view = new WebContentsView(
      adoptedContents
        ? { webContents: adoptedContents }
        : {
            webPreferences: {
              session: this.browserSession,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
              navigateOnDragDrop: false,
            },
          },
    );
    const tab: Tab = { id: randomUUID(), view, url };
    view.setVisible(false);
    host.window.contentView.addChildView(view);
    root.tabs.push(tab);
    const contents = view.webContents;
    const publish = () => this.publish(host, root);
    contents.on("did-start-loading", publish);
    contents.on("did-stop-loading", publish);
    contents.on("page-title-updated", publish);
    contents.on("did-navigate", () => {
      tab.url = contents.getURL();
      tab.error = undefined;
      this.save(host, root);
      publish();
    });
    contents.on("did-navigate-in-page", (_event, _url, mainFrame) => {
      if (mainFrame) {
        tab.url = contents.getURL();
        this.save(host, root);
        publish();
      }
    });
    const guard = (event: Electron.Event, destination: string) => {
      if (isBrowserNavigationAllowed(destination)) return;
      event.preventDefault();
      tab.error = "Only HTTP and HTTPS pages can be opened.";
      publish();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-frame-navigate", (event) => {
      if (!isBrowserNavigationAllowed(event.url)) event.preventDefault();
    });
    contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        tab.error = `Couldn't load page: ${description}`;
        publish();
      }
    });
    contents.on("render-process-gone", () => {
      tab.error = "This page stopped responding. Reload to try again.";
      publish();
    });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.once("destroyed", () => {
      if (host.window.isDestroyed() || !root.tabs.includes(tab)) return;
      const index = root.tabs.indexOf(tab);
      root.tabs.splice(index, 1);
      host.window.contentView.removeChildView(view);
      if (root.activeTabId === tab.id)
        root.activeTabId = root.tabs[Math.min(index, root.tabs.length - 1)]?.id ?? "";

      this.present(host);
      this.save(host, root);
      publish();
    });
    contents.setWindowOpenHandler(({ url: destination }) => {
      if (!isBrowserNavigationAllowed(destination) || root.tabs.length >= 32)
        return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          webPreferences: {
            session: this.browserSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            webviewTag: false,
          },
        },
        createWindow: (options) => {
          // Popup navigation and opener state require Electron's pre-created WebContents.
          const guest = (options as { readonly webContents?: WebContents }).webContents;
          if (!guest) throw new Error("Electron did not supply popup contents.");
          const popup = this.createTab(host, root, destination, guest);
          root.activeTabId = popup.id;
          this.present(host);
          this.save(host, root);
          publish();
          return popup.view.webContents;
        },
      };
    });
    contents.on("before-mouse-event", (_event, input) => {
      if (input.type === "mouseDown" && host.root === root) this.publish(host, root, false, true);
    });
    contents.on("before-input-event", (event, input) => {
      if (
        host.root !== root ||
        !host.mount ||
        input.type !== "keyDown" ||
        this.shortcut(host, event, input)
      )
        return;
      const command =
        getSidePanelTabCommand(process.platform, input) ??
        getDesktopCommandFromShortcut({
          modifier: platformShortcutModifier(process.platform, input),
          alt: input.alt,
          shift: input.shift,
          key: input.key,
          code: input.code,
        });
      if (!command) return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      host.window.webContents.focus();
      host.window.webContents.send(desktopIpc.appCommand, command);
    });
    if (!adoptedContents) this.navigate(host, root, tab, url);
    return tab;
  }

  private shortcut(host: Host, event: Electron.Event, input: Input): boolean {
    if (input.type !== "keyDown" || !host.mount || !host.root) return false;
    const kind = browserShortcut({ ...input, platform: process.platform });
    if (!kind) return false;
    event.preventDefault();
    if (input.isAutoRepeat) return true;
    try {
      this.assertTarget(host.window, host.mount);
      if (kind === "focus-address") {
        host.window.webContents.focus();
        this.publish(host, host.root, true);
      } else {
        this.action(host.window, { mountId: host.mount.mountId, kind });
        if (kind === "new-tab") {
          host.window.webContents.focus();
          this.publish(host, host.root, true);
        }
      }
    } catch (error) {
      host.root.warning = error instanceof Error ? error.message : String(error);
      this.publish(host, host.root);
    }
    return true;
  }

  private navigate(host: Host, root: Root, tab: Tab, url: string): void {
    tab.error = undefined;
    tab.url = url;
    tab.view.webContents.loadURL(url).catch((error: unknown) => {
      if (tab.view.webContents.isDestroyed() || !root.tabs.includes(tab)) return;
      if ((error as { code?: string }).code === "ERR_ABORTED") return;
      tab.error = error instanceof Error ? error.message : "Couldn't load page.";
      this.publish(host, root);
    });
  }

  private nextSnapshot(root: Root): BrowserPanelState {
    return {
      revision: ++root.revision,
      warning: root.warning,
      activeTabId: root.activeTabId,
      tabs: root.tabs.map((tab): BrowserTabState => {
        const contents = tab.view.webContents;
        return {
          id: tab.id,
          url: tab.url,
          title: tab.url === "about:blank" ? "New tab" : contents.getTitle() || "New tab",
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
          error: tab.error,
        };
      }),
    };
  }

  private publish(host: Host, root: Root, focusAddress = false, releaseAddress = false): void {
    if (
      host.window.isDestroyed() ||
      host.window.webContents.isDestroyed() ||
      host.root !== root ||
      !host.mount
    )
      return;
    host.window.webContents.send(desktopIpc.browserChanged, {
      mountId: host.mount.mountId,
      state: this.nextSnapshot(root),
      focusAddress,
      releaseAddress,
    });
  }

  private hide(host: Host): void {
    if (host.visibleTab && !host.visibleTab.view.webContents.isDestroyed()) {
      const focused = host.visibleTab.view.webContents.isFocused();
      host.visibleTab.view.setVisible(false);
      if (focused && !host.window.isDestroyed()) host.window.webContents.focus();
    }
    host.visibleTab = undefined;
  }

  private present(host: Host): void {
    if (!host.layout?.visible || !host.root || !host.mount) {
      this.hide(host);
      return;
    }
    const tab = host.root.tabs.find((entry) => entry.id === host.root?.activeTabId);
    if (!tab) {
      this.hide(host);
      return;
    }
    if (host.visibleTab !== tab) {
      this.hide(host);
      host.visibleTab = tab;
    }
    const zoom = host.window.webContents.getZoomFactor();
    const rect = host.layout.bounds;
    const content = host.window.getContentBounds();
    const x = Math.max(0, Math.round(rect.x * zoom)),
      y = Math.max(0, Math.round(rect.y * zoom));
    tab.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(Math.round(rect.width * zoom), content.width - x)),
      height: Math.max(0, Math.min(Math.round(rect.height * zoom), content.height - y)),
    });
    tab.view.setVisible(true);
  }

  private save(host: Host, root: Root): void {
    this.saved[root.key] = {
      urls: root.tabs.map((tab) => tab.url),
      active: root.tabs.findIndex((tab) => tab.id === root.activeTabId),
    };
    const value = JSON.stringify(this.saved);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await writeFile(`${this.storagePath}.tmp`, value, { mode: 0o600 });
        await rename(`${this.storagePath}.tmp`, this.storagePath);
        if (root.warning === "Couldn't save browser tabs. Keep this window open to retain them.") {
          root.warning = undefined;
          this.publish(host, root);
        }
      })
      .catch(() => {
        root.warning = "Couldn't save browser tabs. Keep this window open to retain them.";
        this.publish(host, root);
      });
  }

  private dispose(host: Host): void {
    this.hosts.delete(host.id);
    host.mount = undefined;
    for (const root of host.roots.values())
      for (const tab of root.tabs)
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.browserSession.flushStorageData();
  }
}
