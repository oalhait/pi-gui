import type { PiSdkDriver, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import { isExtensionUiDialogRequest } from "@pi-gui/pi-sdk-driver";
import {
  driverMethodName,
  ErrorCodes,
  HELLO_METHOD,
  PROTOCOL_VERSION,
  REMOTE_DRIVER_METHODS,
  REMOTE_RUNTIME_METHODS,
  RemoteError,
  runtimeMethodName,
  SESSION_EVENT_NOTIFICATION,
  SUBSCRIBE_METHOD,
  UNSUBSCRIBE_METHOD,
  type HelloParams,
  type HelloResult,
  type RemoteDriverMethod,
  type RemoteHostInfo,
  type RemoteRuntimeMethod,
  type RequestHandler,
  type RpcPeer,
  type SessionEventParams,
  type SubscribeParams,
  type UnsubscribeParams,
} from "@pi-gui/remote-protocol";
import type {
  HostUiRequestEvent,
  HostUiResponse,
  SessionDriverEvent,
  SessionRef,
  Unsubscribe,
} from "@pi-gui/session-driver";

/** The part of `PiSdkDriver` the host serves. */
export type HostDriver = Pick<PiSdkDriver, RemoteDriverMethod | "subscribe"> & {
  readonly runtimeSupervisor: Pick<RuntimeSupervisor, RemoteRuntimeMethod>;
};

export interface HostServerOptions {
  readonly driver: HostDriver;
  readonly hostInfo: Omit<RemoteHostInfo, "protocolVersion">;
  readonly log?: (message: string) => void;
}

export interface HostConnectionInfo {
  readonly clientId: string | undefined;
  readonly clientName: string | undefined;
}

const sessionKey = (ref: SessionRef) => `${ref.workspaceId}\0${ref.sessionId}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSessionRef(value: unknown): SessionRef {
  if (
    !isObject(value) ||
    typeof value.workspaceId !== "string" ||
    typeof value.sessionId !== "string"
  ) {
    throw new RemoteError("Expected a sessionRef", ErrorCodes.invalidRequest);
  }
  return { workspaceId: value.workspaceId, sessionId: value.sessionId };
}

/**
 * Keeps each session's open extension dialogs while any client may be away, so a client that
 * (re)subscribes still sees a confirm/select/input/editor raised while it was disconnected.
 * Pi's own subscribe replays statuses and widgets, but not dialogs.
 */
class DialogTracker {
  private readonly sessions = new Map<
    string,
    { readonly unsubscribe: Unsubscribe; readonly open: Map<string, HostUiRequestEvent> }
  >();

  constructor(private readonly driver: HostDriver) {}

  track(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (this.sessions.has(key)) {
      return;
    }
    const open = new Map<string, HostUiRequestEvent>();
    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      if (event.type === "sessionClosed") {
        this.forget(key);
        return;
      }
      if (event.type !== "hostUiRequest") {
        return;
      }
      const { request } = event;
      if (isExtensionUiDialogRequest(request)) {
        open.set(request.requestId, event);
      } else if (request.kind === "dismiss") {
        open.delete(request.requestId);
      } else if (request.kind === "reset") {
        open.clear();
      }
    });
    this.sessions.set(key, { unsubscribe, open });
  }

  openDialogs(sessionRef: SessionRef): HostUiRequestEvent[] {
    return [...(this.sessions.get(sessionKey(sessionRef))?.open.values() ?? [])];
  }

  answered(sessionRef: SessionRef, response: HostUiResponse): void {
    this.sessions.get(sessionKey(sessionRef))?.open.delete(response.requestId);
  }

  forget(key: string): void {
    const entry = this.sessions.get(key);
    if (entry) {
      this.sessions.delete(key);
      entry.unsubscribe();
    }
  }

  dispose(): void {
    for (const key of [...this.sessions.keys()]) {
      this.forget(key);
    }
  }
}

/**
 * Serves one shared driver to any number of connections. Each connection must say `hello`
 * first, then calls driver and runtime methods and subscribes to session events. Closing a
 * connection drops only its subscriptions; runs continue.
 */
export class HostServer {
  private readonly dialogs: DialogTracker;
  private readonly connections = new Set<RpcPeer>();

  constructor(private readonly options: HostServerOptions) {
    this.dialogs = new DialogTracker(options.driver);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Registers this server's handlers on a new connection. */
  attach(peer: RpcPeer): void {
    const { driver } = this.options;
    const log = this.options.log ?? (() => undefined);
    const subscriptions = new Map<string, Unsubscribe>();
    let client: HelloParams["client"] | undefined;
    this.connections.add(peer);

    const ready =
      (handler: RequestHandler): RequestHandler =>
      (params, context) => {
        if (!client) {
          throw new RemoteError("Send hello first", ErrorCodes.invalidRequest);
        }
        return handler(params, context);
      };

    peer.handle(HELLO_METHOD, (params): HelloResult => {
      const hello = params as Partial<HelloParams> | undefined;
      if (hello?.protocolVersion !== PROTOCOL_VERSION) {
        throw new RemoteError(
          `This pi-gui speaks protocol ${String(hello?.protocolVersion)}; the host speaks ${PROTOCOL_VERSION}. Update pi-gui-host.`,
          ErrorCodes.incompatible,
        );
      }
      if (!isObject(hello.client) || typeof hello.client.id !== "string") {
        throw new RemoteError("hello needs a client id", ErrorCodes.invalidRequest);
      }
      client = hello.client;
      log(`client connected: ${client.name} ${client.version} (${client.id})`);
      return { host: { ...this.options.hostInfo, protocolVersion: PROTOCOL_VERSION } };
    });

    for (const method of REMOTE_DRIVER_METHODS) {
      peer.handle(
        driverMethodName(method),
        ready((params, { signal }) => {
          const args = Array.isArray(params) ? [...(params as unknown[])] : [];
          if (method === "generateThreadTitle" && isObject(args[1])) {
            args[1] = { ...args[1], signal };
          }
          if (method === "respondToHostUiRequest" && args.length >= 2) {
            this.dialogs.answered(parseSessionRef(args[0]), args[1] as HostUiResponse);
          }
          const fn = driver[method] as (...callArgs: unknown[]) => unknown;
          return fn.apply(driver, args);
        }),
      );
    }

    for (const method of REMOTE_RUNTIME_METHODS) {
      peer.handle(
        runtimeMethodName(method),
        ready((params) => {
          const args = Array.isArray(params) ? (params as unknown[]) : [];
          const runtime = driver.runtimeSupervisor;
          const fn = runtime[method] as (...callArgs: unknown[]) => unknown;
          return fn.apply(runtime, args);
        }),
      );
    }

    peer.handle(
      SUBSCRIBE_METHOD,
      ready((params) => {
        const subscribe = params as Partial<SubscribeParams> | undefined;
        const sessionRef = parseSessionRef(subscribe?.sessionRef);
        const subscriptionId = subscribe?.subscriptionId;
        if (typeof subscriptionId !== "string" || subscriptions.has(subscriptionId)) {
          throw new RemoteError("Expected a new subscriptionId", ErrorCodes.invalidRequest);
        }
        const send = (event: SessionDriverEvent): void => {
          try {
            peer.notify(SESSION_EVENT_NOTIFICATION, {
              subscriptionId,
              event,
            } satisfies SessionEventParams);
          } catch (error) {
            log(
              `dropped a ${event.type} event that could not be encoded: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        // Track first so a dialog raised from now on is kept, then replay the dialogs that were
        // opened while this client was away.
        this.dialogs.track(sessionRef);
        subscriptions.set(subscriptionId, driver.subscribe(sessionRef, send));
        for (const event of this.dialogs.openDialogs(sessionRef)) {
          send(event);
        }
      }),
    );

    peer.handle(
      UNSUBSCRIBE_METHOD,
      ready((params) => {
        const id = (params as Partial<UnsubscribeParams> | undefined)?.subscriptionId;
        if (typeof id === "string") {
          subscriptions.get(id)?.();
          subscriptions.delete(id);
        }
      }),
    );

    peer.onClose((reason) => {
      this.connections.delete(peer);
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
      if (client) {
        log(`client disconnected: ${client.name} (${client.id}): ${reason.message}`);
      }
    });
  }

  dispose(): void {
    for (const peer of [...this.connections]) {
      peer.close();
    }
    this.dialogs.dispose();
  }
}
