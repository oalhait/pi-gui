import { remoteWorkspaceId, REMOTE_WORKSPACE_SCHEME } from "../../contracts/remote-hosts";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Desktop → host: replaces every string under `pi-remote://<hostId>/` with its server path.
 * Covers ids, paths and nested refs (fork targets, workspace refs) without per-method rules.
 */
export function toServerForm<T>(hostId: string, value: T): T {
  const prefix = `${REMOTE_WORKSPACE_SCHEME}${hostId}/`;
  const map = (current: unknown): unknown => {
    if (typeof current === "string") {
      return current.startsWith(prefix) ? current.slice(prefix.length - 1) : current;
    }
    if (Array.isArray(current)) {
      return current.map(map);
    }
    if (isPlainObject(current)) {
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, map(entry)]));
    }
    return current;
  };
  return map(value) as T;
}

/**
 * Host → desktop: prefixes every `workspaceId`, and the `path` of any object that has a
 * `workspaceId` (workspace refs and catalog entries). Drops `sessionFilePath`, a server path the
 * desktop must not read locally. Other strings, such as file paths in tool output, are left as the
 * server reported them.
 */
export function toDesktopForm<T>(hostId: string, value: T): T {
  const prefix = (path: unknown) =>
    typeof path === "string" && path.startsWith("/") ? remoteWorkspaceId(hostId, path) : path;
  const map = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      return current.map(map);
    }
    if (!isPlainObject(current)) {
      return current;
    }
    const hasWorkspaceId = typeof current.workspaceId === "string";
    const entries: [string, unknown][] = [];
    for (const [key, entry] of Object.entries(current)) {
      if (key === "sessionFilePath") {
        continue;
      }
      if (key === "workspaceId" || (key === "path" && hasWorkspaceId)) {
        entries.push([key, prefix(entry)]);
      } else {
        entries.push([key, map(entry)]);
      }
    }
    return Object.fromEntries(entries);
  };
  return map(value) as T;
}
