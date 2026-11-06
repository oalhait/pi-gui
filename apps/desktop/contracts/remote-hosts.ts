/** Remote hosts: servers pi-gui reaches over SSH to run chats there. Browser-safe. */

export const REMOTE_HOSTS_FILE_VERSION = 1;

export interface RemoteHostConfig {
  /** Stable id used in remote workspace ids; lowercase letters, digits and dashes. */
  readonly id: string;
  readonly label: string;
  /** Passed to the system `ssh`: an `~/.ssh/config` alias or `user@host`. */
  readonly destination: string;
  readonly port?: number;
  readonly identityFile?: string;
  /** Node.js on the server; defaults to `node` on the login shell's PATH. */
  readonly nodePath?: string;
  /** pi-gui-host state directory on the server; defaults to `~/.pi-gui-host`. */
  readonly hostHome?: string;
}

export type RemoteHostConnectionStatus =
  "disconnected" | "connecting" | "installing" | "connected" | "error";

export interface RemoteHostState {
  readonly config: RemoteHostConfig;
  readonly status: RemoteHostConnectionStatus;
  /** Why the host is in `error` or `disconnected`, or what `installing` is doing. */
  readonly message?: string;
  readonly hostVersion?: string;
  readonly hostname?: string;
  readonly lastConnectedAt?: string;
}

/**
 * Remote workspaces appear in the desktop with an id and path of `pi-remote://<hostId><path>`,
 * e.g. `pi-remote://devbox/home/omar/project`. The host knows only the plain server path.
 *
 * The prefix keeps remote ids from colliding with local ones (a local workspace id is its path),
 * and a local file operation given such a path fails instead of touching a same-named local
 * folder. Only the remote driver translates between the two forms.
 */

export const REMOTE_WORKSPACE_SCHEME = "pi-remote://";

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidRemoteHostId(hostId: string): boolean {
  return HOST_ID_PATTERN.test(hostId);
}

export function isRemoteWorkspaceId(workspaceId: string | undefined): boolean {
  return typeof workspaceId === "string" && workspaceId.startsWith(REMOTE_WORKSPACE_SCHEME);
}

export function remoteWorkspaceId(hostId: string, serverPath: string): string {
  if (!isValidRemoteHostId(hostId)) {
    throw new Error(`Invalid remote host id: ${hostId}`);
  }
  if (!serverPath.startsWith("/")) {
    throw new Error(`Remote folder paths must be absolute: ${serverPath}`);
  }
  return `${REMOTE_WORKSPACE_SCHEME}${hostId}${serverPath}`;
}

export function parseRemoteWorkspaceId(
  workspaceId: string,
): { readonly hostId: string; readonly serverPath: string } | undefined {
  if (!isRemoteWorkspaceId(workspaceId)) {
    return undefined;
  }
  const rest = workspaceId.slice(REMOTE_WORKSPACE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const hostId = rest.slice(0, slash);
  return isValidRemoteHostId(hostId) ? { hostId, serverPath: rest.slice(slash) } : undefined;
}

export function remoteHostIdOf(workspaceId: string | undefined): string | undefined {
  return workspaceId === undefined ? undefined : parseRemoteWorkspaceId(workspaceId)?.hostId;
}

/** What "Test connection" found, without installing or starting anything. */
export type RemoteHostTestResult =
  | {
      readonly ok: true;
      readonly home: string;
      readonly nodeVersion: string;
      /** pi-gui-host is already installed (pi-gui installs or updates it when connecting). */
      readonly installed: boolean;
    }
  | { readonly ok: false; readonly message: string };
