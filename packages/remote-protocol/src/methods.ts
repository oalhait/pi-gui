import type { PiSdkDriver, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";

// ---- Handshake -------------------------------------------------------------------------------

/** The first request a client sends. Nothing else is answered before it succeeds. */
export const HELLO_METHOD = "hello";

export interface HelloParams {
  readonly protocolVersion: number;
  readonly client: {
    /** Stable per installation; lets the host tell reconnects from new clients. */
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
}

export interface RemoteHostInfo {
  readonly protocolVersion: number;
  /** pi-gui-host package version. */
  readonly version: string;
  /** Id of the installed bundle the server runs from, when it was installed by pi-gui. */
  readonly bundleId?: string;
  readonly hostname: string;
  readonly platform: string;
  readonly arch: string;
  readonly homeDir: string;
  readonly nodeVersion: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface HelloResult {
  readonly host: RemoteHostInfo;
}

// ---- Driver calls ----------------------------------------------------------------------------

/**
 * `PiSdkDriver` methods a client may call as `driver/<name>`, with the method's arguments as an
 * array. `subscribe` is separate (it takes a listener). `generateThreadTitle` carries its abort
 * signal as the request's cancellation instead of in its options.
 */
export const REMOTE_DRIVER_METHODS = [
  "createSession",
  "validateForkSession",
  "forkSession",
  "openSession",
  "archiveSession",
  "archiveSessionIfIdle",
  "unarchiveSession",
  "sendUserMessage",
  "replaceQueuedMessages",
  "cancelCurrentRun",
  "setSessionModel",
  "setSessionThinkingLevel",
  "renameSession",
  "compactSession",
  "reloadSession",
  "reloadSessionWhenIdle",
  "getSessionTree",
  "navigateSessionTree",
  "rewindToUserMessage",
  "getSessionCommands",
  "respondToHostUiRequest",
  "closeSession",
  "listWorkspaces",
  "listSessions",
  "syncWorkspace",
  "reconcileWorkspace",
  "getSessionFilePath",
  "renameWorkspace",
  "removeWorkspace",
  "getTranscript",
  "getSessionSchemaInfo",
  "generateThreadTitle",
] as const satisfies readonly (keyof PiSdkDriver)[];

export type RemoteDriverMethod = (typeof REMOTE_DRIVER_METHODS)[number];

/**
 * Workspace-scoped `RuntimeSupervisor` methods a client may call as `runtime/<name>`.
 * Synchronous methods and `login` (which takes callbacks) are not available remotely yet.
 */
export const REMOTE_RUNTIME_METHODS = [
  "getRuntimeSnapshot",
  "refreshRuntime",
  "getProviderUsage",
  "logout",
  "setProviderApiKey",
  "setDefaultModel",
  "setProjectDefaultModel",
  "setDefaultThinkingLevel",
  "setProjectDefaultThinkingLevel",
  "setEnableSkillCommands",
  "getCodemodeAlwaysOn",
  "setCodemodeAlwaysOn",
  "setScopedModelPatterns",
  "setProjectScopedModelPatterns",
  "scopeModels",
  "getGlobalModelSettings",
  "getCurrentModelSettings",
  "setSkillEnabled",
  "setExtensionEnabled",
] as const satisfies readonly (keyof RuntimeSupervisor)[];

export type RemoteRuntimeMethod = (typeof REMOTE_RUNTIME_METHODS)[number];

export const driverMethodName = (method: RemoteDriverMethod) => `driver/${method}` as const;
export const runtimeMethodName = (method: RemoteRuntimeMethod) => `runtime/${method}` as const;

type AsyncResult<T> = T extends (...args: never[]) => infer R ? Awaited<R> : never;
type Args<T> = T extends (...args: infer A) => unknown ? A : never;

export type RemoteDriverArgs<M extends RemoteDriverMethod> = Args<PiSdkDriver[M]>;
export type RemoteDriverResult<M extends RemoteDriverMethod> = AsyncResult<PiSdkDriver[M]>;
export type RemoteRuntimeArgs<M extends RemoteRuntimeMethod> = Args<RuntimeSupervisor[M]>;
export type RemoteRuntimeResult<M extends RemoteRuntimeMethod> = AsyncResult<RuntimeSupervisor[M]>;

// ---- Session events --------------------------------------------------------------------------

export const SUBSCRIBE_METHOD = "session/subscribe";
export const UNSUBSCRIBE_METHOD = "session/unsubscribe";
export const SESSION_EVENT_NOTIFICATION = "session/event";

/**
 * The client chooses `subscriptionId` (unique on its connection) and listens for it before
 * sending, because the host starts sending that subscription's events immediately, before the
 * subscribe response.
 */
export interface SubscribeParams {
  readonly sessionRef: SessionRef;
  readonly subscriptionId: string;
}

export interface UnsubscribeParams {
  readonly subscriptionId: string;
}

export interface SessionEventParams {
  readonly subscriptionId: string;
  readonly event: SessionDriverEvent;
}
