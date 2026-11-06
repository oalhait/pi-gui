import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
} from "@pi-gui/catalogs";
import {
  driverMethodName,
  ErrorCodes,
  isRemoteError,
  RemoteError,
  runtimeMethodName,
  SESSION_EVENT_NOTIFICATION,
  SUBSCRIBE_METHOD,
  UNSUBSCRIBE_METHOD,
  type RemoteDriverArgs,
  type RemoteDriverMethod,
  type RemoteDriverResult,
  type RemoteRuntimeArgs,
  type RemoteRuntimeMethod,
  type RemoteRuntimeResult,
  type RequestOptions,
  type RpcPeer,
  type SessionEventParams,
  type SubscribeParams,
  type UnsubscribeParams,
} from "@pi-gui/remote-protocol";
import { sessionKey } from "@pi-gui/session-driver";
import type {
  SessionDriverEvent,
  SessionEventListener,
  SessionMessageInput,
  SessionRef,
  Unsubscribe,
} from "@pi-gui/session-driver";
import type { RemoteCatalogCache, RemoteHostStore } from "./remote-host-store";
import { toDesktopForm, toServerForm } from "./remote-ids";

interface Subscription {
  readonly sessionRef: SessionRef;
  readonly listener: SessionEventListener;
  /** The id on the current connection, while subscribed there. */
  remoteId: string | undefined;
}

export interface RemoteSessionDriverOptions {
  readonly hostId: string;
  readonly label: string;
  readonly store: Pick<RemoteHostStore, "readCatalog" | "writeCatalog">;
  /** Called after a reconnect has resubscribed, so the app can reload what it may have missed. */
  readonly onResynced?: (hostId: string) => void;
  readonly log?: (message: string) => void;
}

/** A call that runs until the run it started ends, and whose outcome survives a disconnect. */
const RUN_METHODS = new Set<RemoteDriverMethod>(["sendUserMessage", "compactSession"]);

/**
 * The desktop's driver for one remote host. Calls go to pi-gui-host over the current connection
 * with ids translated (see remote-ids.ts). While the host is offline it serves the last known
 * folders and threads from a cache, fails other calls with `unavailable`, and keeps
 * subscriptions so they resume on reconnect.
 */
export class RemoteSessionDriver {
  private peer: RpcPeer | undefined;
  private readonly subscriptions = new Map<string, Subscription>();
  private nextLocalId = 1;
  private nextRemoteId = 1;
  private catalog: RemoteCatalogCache | undefined;
  private catalogLoad: Promise<void> | undefined;
  /** Latest event time per session, to tell a dropped connection after a run started. */
  private readonly lastEventAt = new Map<string, number>();

  constructor(private readonly options: RemoteSessionDriverOptions) {}

  get hostId(): string {
    return this.options.hostId;
  }

  get connected(): boolean {
    return this.peer !== undefined && !this.peer.closed;
  }

  /** Loads the cached catalog from disk; later calls reuse it. */
  loadCache(): Promise<void> {
    this.catalogLoad ??= this.options.store
      .readCatalog(this.options.hostId)
      .then((cache) => {
        this.catalog ??= cache;
      })
      .catch((error: unknown) => this.log(`could not read the catalog cache: ${String(error)}`));
    return this.catalogLoad;
  }

  /** Adopts a new connection: routes events, resubscribes, refreshes the catalog. */
  async attach(peer: RpcPeer): Promise<void> {
    this.peer = peer;
    const stopEvents = peer.onNotification(SESSION_EVENT_NOTIFICATION, (params) =>
      this.dispatch(params as SessionEventParams),
    );
    peer.onClose(() => {
      stopEvents();
      if (this.peer === peer) {
        this.peer = undefined;
      }
      for (const subscription of this.subscriptions.values()) {
        subscription.remoteId = undefined;
      }
    });
    await Promise.allSettled([
      this.refreshCatalog(),
      ...[...this.subscriptions.values()].map((subscription) => this.subscribeRemote(subscription)),
    ]);
    if (this.peer === peer) {
      this.options.onResynced?.(this.options.hostId);
    }
  }

  // ---- Catalog -------------------------------------------------------------------------------

  async listWorkspaces(): Promise<WorkspaceCatalogSnapshot> {
    await this.loadCache();
    if (this.connected) {
      await this.refreshCatalog().catch((error: unknown) =>
        this.log(`catalog refresh failed: ${String(error)}`),
      );
    }
    return { workspaces: [...(this.catalog?.workspaces ?? [])] };
  }

  async listSessions(workspaceId?: string): Promise<SessionCatalogSnapshot> {
    await this.loadCache();
    if (this.connected) {
      await this.refreshCatalog().catch((error: unknown) =>
        this.log(`catalog refresh failed: ${String(error)}`),
      );
    }
    const sessions = this.catalog?.sessions ?? [];
    return {
      sessions: sessions.filter((session) => !workspaceId || session.workspaceId === workspaceId),
    };
  }

  /** A known folder resyncs from the cache while offline instead of failing startup. */
  async syncWorkspace(
    path: string,
    displayName?: string,
  ): Promise<RemoteDriverResult<"syncWorkspace">> {
    await this.loadCache();
    if (!this.connected) {
      const workspace = this.catalog?.workspaces.find((entry) => entry.path === path);
      if (workspace) {
        return {
          workspace: {
            workspaceId: workspace.workspaceId,
            path: workspace.path,
            displayName: workspace.displayName,
          },
          sessions: this.catalog!.sessions.filter(
            (session) => session.workspaceId === workspace.workspaceId,
          ),
        };
      }
    }
    const result = await this.call(
      "syncWorkspace",
      ...([
        path,
        ...(displayName === undefined ? [] : [displayName]),
      ] as RemoteDriverArgs<"syncWorkspace">),
    );
    await this.refreshCatalog().catch(() => undefined);
    return result;
  }

  private refreshing: Promise<void> | undefined;

  /** Refetches every folder and thread from the host and saves them as the cache. */
  private refreshCatalog(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const [workspaces, sessions] = await Promise.all([
          this.call("listWorkspaces"),
          this.call("listSessions"),
        ]);
        const cache: RemoteCatalogCache = {
          version: 1,
          savedAt: new Date().toISOString(),
          workspaces: workspaces.workspaces as WorkspaceCatalogEntry[],
          sessions: sessions.sessions as SessionCatalogEntry[],
        };
        const changed =
          JSON.stringify([cache.workspaces, cache.sessions]) !==
          JSON.stringify([this.catalog?.workspaces, this.catalog?.sessions]);
        this.catalog = cache;
        if (changed) {
          await this.options.store
            .writeCatalog(this.options.hostId, cache)
            .catch((error: unknown) =>
              this.log(`could not save the catalog cache: ${String(error)}`),
            );
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  // ---- Calls ---------------------------------------------------------------------------------

  async call<M extends RemoteDriverMethod>(
    method: M,
    ...args: RemoteDriverArgs<M>
  ): Promise<RemoteDriverResult<M>> {
    if (method === "getSessionFilePath") {
      // A server path; the desktop must not stat or read it locally.
      return undefined as RemoteDriverResult<M>;
    }
    const peer = this.requirePeer();
    let requestArgs: unknown[] = [...args];
    const options: { signal?: AbortSignal } = {};
    if (method === "generateThreadTitle") {
      // The abort signal travels as the request's cancellation, not as an argument.
      const titleOptions = requestArgs[1] as { signal?: AbortSignal } | undefined;
      if (titleOptions?.signal) {
        options.signal = titleOptions.signal;
        const { signal: _signal, ...rest } = titleOptions;
        requestArgs = [requestArgs[0], rest];
      }
    }
    if (RUN_METHODS.has(method)) {
      return this.callRun(peer, method, requestArgs) as Promise<RemoteDriverResult<M>>;
    }
    const result = await peer.request(
      driverMethodName(method),
      toServerForm(this.options.hostId, requestArgs),
      options as RequestOptions,
    );
    return toDesktopForm(this.options.hostId, result) as RemoteDriverResult<M>;
  }

  async runtime<M extends RemoteRuntimeMethod>(
    method: M,
    ...args: RemoteRuntimeArgs<M>
  ): Promise<RemoteRuntimeResult<M>> {
    const peer = this.requirePeer();
    const result = await peer.request(
      runtimeMethodName(method),
      toServerForm(this.options.hostId, [...args]),
    );
    return toDesktopForm(this.options.hostId, result) as RemoteRuntimeResult<M>;
  }

  /**
   * `sendUserMessage` and `compactSession` resolve only when their run ends. If the connection
   * drops after the host started the run (an event for that session arrived after sending), the
   * run continues on the host and its outcome arrives on reconnect, so this resolves instead of
   * reporting a failed send.
   */
  private async callRun(
    peer: RpcPeer,
    method: RemoteDriverMethod,
    args: unknown[],
  ): Promise<unknown> {
    const sessionRef = args[0] as SessionRef;
    const key = sessionKey(sessionRef);
    const sentAt = Date.now();
    try {
      return await peer.request(driverMethodName(method), toServerForm(this.options.hostId, args));
    } catch (error) {
      if (
        isRemoteError(error, ErrorCodes.disconnected) &&
        (this.lastEventAt.get(key) ?? 0) >= sentAt
      ) {
        return undefined;
      }
      if (isRemoteError(error, ErrorCodes.disconnected)) {
        throw new RemoteError(
          `Lost the connection to ${this.options.label} before it received the message. Try again when it reconnects.`,
          ErrorCodes.disconnected,
        );
      }
      throw error;
    }
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    if (input.attachments?.some((attachment) => attachment.kind === "file")) {
      return Promise.reject(
        new RemoteError(
          "File attachments are not available in remote folders yet. Paste images, or copy the file to the server.",
          ErrorCodes.unavailable,
        ),
      );
    }
    return this.call("sendUserMessage", sessionRef, input);
  }

  // ---- Subscriptions -------------------------------------------------------------------------

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    const localId = `l${this.nextLocalId++}`;
    const subscription: Subscription = { sessionRef, listener, remoteId: undefined };
    this.subscriptions.set(localId, subscription);
    if (this.connected) {
      this.subscribeRemote(subscription).catch((error: unknown) =>
        this.log(`subscribe failed for ${sessionKey(sessionRef)}: ${String(error)}`),
      );
    }
    return () => {
      this.subscriptions.delete(localId);
      const remoteId = subscription.remoteId;
      subscription.remoteId = undefined;
      if (remoteId && this.connected) {
        this.peer!.request(UNSUBSCRIBE_METHOD, {
          subscriptionId: remoteId,
        } satisfies UnsubscribeParams).catch(() => undefined);
      }
    };
  }

  private async subscribeRemote(subscription: Subscription): Promise<void> {
    const peer = this.requirePeer();
    const serverRef = toServerForm(this.options.hostId, subscription.sessionRef);
    const subscriptionId = `r${this.nextRemoteId++}`;
    // The host only streams sessions it has loaded; after a host restart, load it again.
    await peer.request(driverMethodName("openSession"), [serverRef]);
    subscription.remoteId = subscriptionId;
    try {
      await peer.request(SUBSCRIBE_METHOD, {
        sessionRef: serverRef,
        subscriptionId,
      } satisfies SubscribeParams);
    } catch (error) {
      if (subscription.remoteId === subscriptionId) {
        subscription.remoteId = undefined;
      }
      throw error;
    }
  }

  private dispatch(params: SessionEventParams): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.remoteId !== params.subscriptionId) {
        continue;
      }
      const event = toDesktopForm(this.options.hostId, params.event) as SessionDriverEvent;
      this.lastEventAt.set(sessionKey(event.sessionRef), Date.now());
      Promise.resolve(subscription.listener(event)).catch((error: unknown) =>
        this.log(`session listener failed: ${String(error)}`),
      );
      return;
    }
  }

  private requirePeer(): RpcPeer {
    if (!this.peer || this.peer.closed) {
      throw new RemoteError(
        `${this.options.label} is not connected. pi-gui will reconnect when it can be reached.`,
        ErrorCodes.unavailable,
      );
    }
    return this.peer;
  }

  private log(message: string): void {
    (this.options.log ?? ((text: string) => console.warn(text)))(
      `[remote:${this.options.hostId}] ${message}`,
    );
  }
}
