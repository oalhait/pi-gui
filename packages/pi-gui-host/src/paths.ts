import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HostPaths {
  readonly home: string;
  /** Owner-only (0700) directory holding the socket, pid and lock files. */
  readonly runDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly lockPath: string;
  readonly logPath: string;
  readonly catalogPath: string;
}

/** `PI_GUI_HOST_HOME` overrides the default `~/.pi-gui-host`. */
export function hostPaths(home = process.env.PI_GUI_HOST_HOME): HostPaths {
  const root = resolve(home?.trim() ? expandHome(home.trim()) : join(homedir(), ".pi-gui-host"));
  const runDir = join(root, "run");
  return {
    home: root,
    runDir,
    socketPath: join(runDir, "host.sock"),
    pidPath: join(runDir, "host.pid"),
    lockPath: join(runDir, "start.lock"),
    logPath: join(root, "logs", "host.log"),
    catalogPath: join(root, "state", "catalogs.json"),
  };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
