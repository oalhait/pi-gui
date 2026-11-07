import type {
  SessionCatalogSnapshot,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
} from "@pi-gui/catalogs";
import type { PiSdkDriver, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import {
  ErrorCodes,
  REMOTE_RUNTIME_METHODS,
  RemoteError,
  type RemoteDriverArgs,
  type RemoteDriverMethod,
  type RemoteDriverResult,
  type RemoteRuntimeMethod,
} from "@pi-gui/remote-protocol";
import type {
  SessionEventListener,
  SessionMessageInput,
  SessionRef,
  Unsubscribe,
} from "@pi-gui/session-driver";
import { remoteHostIdOf } from "../../contracts/remote-hosts";
import type { RemoteSessionDriver } from "./remote-session-driver";

type PublicShape<T> = { [K in keyof T]: T[K] };

/** `RuntimeSupervisor`'s public methods, without its private state. */
export type DesktopRuntime = PublicShape<RuntimeSupervisor>;

/** The driver surface the desktop uses: `PiSdkDriver`'s, with a routable runtime. */
export type DesktopDriver = Omit<PublicShape<PiSdkDriver>, "runtimeSupervisor"> & {
  readonly runtimeSupervisor: DesktopRuntime;
};

export interface RemoteDriverLookup {
  /** The driver for a configured host, or undefined when the host was removed. */
  driverFor(hostId: string): RemoteSessionDriver | undefined;
  /** Every configured host's driver. */
  drivers(): readonly RemoteSessionDriver[];
}

const REMOTE_RUNTIME_METHOD_SET = new Set<string>(REMOTE_RUNTIME_METHODS);

/** The remote host a call targets, from its first argument (a ref, workspace id or path). */
function targetHostId(first: unknown): string | undefined {
  if (typeof first === "string") {
    return remoteHostIdOf(first);
  }
  if (typeof first === "object" && first !== null && "workspaceId" in first) {
    const { workspaceId } = first as { workspaceId: unknown };
    return typeof workspaceId === "string" ? remoteHostIdOf(workspaceId) : undefined;
  }
  return undefined;
}

export function unavailableRemotely(feature: string): RemoteError {
  return new RemoteError(
    `${feature} is not available in remote folders yet.`,
    ErrorCodes.unavailable,
  );
}

/**
 * Sends each call to the local `PiSdkDriver` or, for `pi-remote://` workspaces, to that host's
 * remote driver. Lists merge local and remote entries. Local behavior is unchanged.
 */
export class RoutingDriver implements DesktopDriver {
  readonly runtimeSupervisor: DesktopRuntime;

  constructor(
    private readonly local: PiSdkDriver,
    private readonly remotes: RemoteDriverLookup,
  ) {
    this.runtimeSupervisor = routeRuntime(local.runtimeSupervisor, remotes);
  }

  private remoteFor(first: unknown): RemoteSessionDriver | undefined {
    const hostId = targetHostId(first);
    if (hostId === undefined) {
      return undefined;
    }
    const remote = this.remotes.driverFor(hostId);
    if (!remote) {
      throw new RemoteError(
        `The remote host "${hostId}" is no longer configured. Add it again in Settings → Remote hosts.`,
        ErrorCodes.unavailable,
      );
    }
    return remote;
  }

  /** Runs `method` remotely when its first argument is a remote workspace, else locally. */
  private route<M extends RemoteDriverMethod>(
    method: M,
    ...args: RemoteDriverArgs<M>
  ): Promise<RemoteDriverResult<M>> {
    const remote = this.remoteFor(args[0]);
    if (remote) {
      return remote.call(method, ...args);
    }
    const fn = this.local[method] as (
      ...callArgs: RemoteDriverArgs<M>
    ) => Promise<RemoteDriverResult<M>>;
    return fn.apply(this.local, args);
  }

  createSession(...args: RemoteDriverArgs<"createSession">) {
    return this.route("createSession", ...args);
  }

  validateForkSession(...args: RemoteDriverArgs<"validateForkSession">) {
    this.assertSameHost(args[0], args[1].targetWorkspace);
    return this.route("validateForkSession", ...args);
  }

  forkSession(...args: RemoteDriverArgs<"forkSession">) {
    this.assertSameHost(args[0], args[1].targetWorkspace);
    return this.route("forkSession", ...args);
  }

  /** Moves stay on this computer: the remote protocol has no move yet. */
  moveSession(...args: Parameters<PiSdkDriver["moveSession"]>) {
    if (
      targetHostId(args[0]) !== undefined ||
      targetHostId(args[1].targetWorkspace) !== undefined
    ) {
      return Promise.reject(
        new RemoteError("Threads on a remote host can't move yet.", ErrorCodes.unavailable),
      );
    }
    return this.local.moveSession(...args);
  }

  openSession(...args: RemoteDriverArgs<"openSession">) {
    return this.route("openSession", ...args);
  }

  archiveSession(...args: RemoteDriverArgs<"archiveSession">) {
    return this.route("archiveSession", ...args);
  }

  archiveSessionIfIdle(...args: RemoteDriverArgs<"archiveSessionIfIdle">) {
    return this.route("archiveSessionIfIdle", ...args);
  }

  unarchiveSession(...args: RemoteDriverArgs<"unarchiveSession">) {
    return this.route("unarchiveSession", ...args);
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    const remote = this.remoteFor(sessionRef);
    return remote
      ? remote.sendUserMessage(sessionRef, input)
      : this.local.sendUserMessage(sessionRef, input);
  }

  replaceQueuedMessages(...args: RemoteDriverArgs<"replaceQueuedMessages">) {
    return this.route("replaceQueuedMessages", ...args);
  }

  cancelCurrentRun(...args: RemoteDriverArgs<"cancelCurrentRun">) {
    return this.route("cancelCurrentRun", ...args);
  }

  setSessionModel(...args: RemoteDriverArgs<"setSessionModel">) {
    return this.route("setSessionModel", ...args);
  }

  setSessionThinkingLevel(...args: RemoteDriverArgs<"setSessionThinkingLevel">) {
    return this.route("setSessionThinkingLevel", ...args);
  }

  renameSession(...args: RemoteDriverArgs<"renameSession">) {
    return this.route("renameSession", ...args);
  }

  compactSession(...args: RemoteDriverArgs<"compactSession">) {
    return this.route("compactSession", ...args);
  }

  reloadSession(...args: RemoteDriverArgs<"reloadSession">) {
    return this.route("reloadSession", ...args);
  }

  reloadSessionWhenIdle(...args: RemoteDriverArgs<"reloadSessionWhenIdle">) {
    return this.route("reloadSessionWhenIdle", ...args);
  }

  getSessionTree(...args: RemoteDriverArgs<"getSessionTree">) {
    return this.route("getSessionTree", ...args);
  }

  navigateSessionTree(...args: RemoteDriverArgs<"navigateSessionTree">) {
    return this.route("navigateSessionTree", ...args);
  }

  rewindToUserMessage(...args: RemoteDriverArgs<"rewindToUserMessage">) {
    return this.route("rewindToUserMessage", ...args);
  }

  getSessionCommands(...args: RemoteDriverArgs<"getSessionCommands">) {
    return this.route("getSessionCommands", ...args);
  }

  respondToHostUiRequest(...args: RemoteDriverArgs<"respondToHostUiRequest">) {
    return this.route("respondToHostUiRequest", ...args);
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    const remote = this.remoteFor(sessionRef);
    return remote
      ? remote.subscribe(sessionRef, listener)
      : this.local.subscribe(sessionRef, listener);
  }

  closeSession(...args: RemoteDriverArgs<"closeSession">) {
    return this.route("closeSession", ...args);
  }

  async listWorkspaces(): Promise<WorkspaceCatalogSnapshot> {
    const [local, ...remote] = await Promise.all([
      this.local.listWorkspaces(),
      ...this.remotes.drivers().map((driver) => driver.listWorkspaces()),
    ]);
    return { workspaces: [...local!.workspaces, ...remote.flatMap((entry) => entry.workspaces)] };
  }

  async listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> {
    if (workspaceId !== undefined) {
      const remote = this.remoteFor(workspaceId);
      return remote ? remote.listSessions(workspaceId) : this.local.listSessions(workspaceId);
    }
    const [local, ...remote] = await Promise.all([
      this.local.listSessions(),
      ...this.remotes.drivers().map((driver) => driver.listSessions()),
    ]);
    return { sessions: [...local!.sessions, ...remote.flatMap((entry) => entry.sessions)] };
  }

  syncWorkspace(path: string, displayName?: string) {
    const remote = this.remoteFor(path);
    return remote
      ? remote.syncWorkspace(path, displayName)
      : this.local.syncWorkspace(path, displayName);
  }

  reconcileWorkspace(...args: RemoteDriverArgs<"reconcileWorkspace">) {
    return this.route("reconcileWorkspace", ...args);
  }

  getSessionFilePath(...args: RemoteDriverArgs<"getSessionFilePath">) {
    return this.route("getSessionFilePath", ...args);
  }

  renameWorkspace(...args: RemoteDriverArgs<"renameWorkspace">) {
    return this.route("renameWorkspace", ...args);
  }

  removeWorkspace(...args: RemoteDriverArgs<"removeWorkspace">) {
    return this.route("removeWorkspace", ...args);
  }

  getTranscript(...args: RemoteDriverArgs<"getTranscript">) {
    return this.route("getTranscript", ...args);
  }

  getSessionSchemaInfo(...args: RemoteDriverArgs<"getSessionSchemaInfo">) {
    return this.route("getSessionSchemaInfo", ...args);
  }

  generateThreadTitle(...args: RemoteDriverArgs<"generateThreadTitle">) {
    return this.route("generateThreadTitle", ...args);
  }

  private assertSameHost(source: SessionRef, target: { workspaceId: string }): void {
    if (targetHostId(source) !== targetHostId(target)) {
      throw new RemoteError(
        "A thread can only be forked into a folder on the same machine.",
        ErrorCodes.unavailable,
      );
    }
  }
}

/**
 * Wraps the local runtime supervisor: a call whose first argument is a remote workspace goes to
 * that host when the protocol allows it, and fails as unavailable otherwise. Other calls,
 * including app-wide ones, stay local.
 */
function routeRuntime(local: RuntimeSupervisor, remotes: RemoteDriverLookup): DesktopRuntime {
  return new Proxy(local, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const hostId = targetHostId(args[0]);
        if (hostId === undefined) {
          return method.apply(target, args);
        }
        if (!REMOTE_RUNTIME_METHOD_SET.has(property)) {
          throw unavailableRemotely(`This setting (${property})`);
        }
        const remote = remotes.driverFor(hostId);
        if (!remote) {
          return Promise.reject(
            new RemoteError(
              `The remote host "${hostId}" is no longer configured.`,
              ErrorCodes.unavailable,
            ),
          );
        }
        const call = remote.runtime.bind(remote) as (
          method: RemoteRuntimeMethod,
          ...callArgs: unknown[]
        ) => Promise<unknown>;
        return call(property as RemoteRuntimeMethod, ...args);
      };
    },
  }) as DesktopRuntime;
}
