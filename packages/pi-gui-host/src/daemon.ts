import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, truncateSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { preparePrivateDir, socketAcceptsConnections, type PidRecord } from "./serve.js";
import type { HostPaths } from "./paths.js";
import { HOST_VERSION } from "./version.js";

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  /** Version of the running server, which can differ from this command's version. */
  readonly version?: string;
  readonly startedAt?: string;
  readonly socketPath: string;
  /** This command's (installed) version. */
  readonly installedVersion: string;
}

const START_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPidRecord(paths: HostPaths): Promise<PidRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.pidPath, "utf8")) as Partial<PidRecord>;
    return typeof value.pid === "number" && typeof value.version === "string"
      ? (value as PidRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function daemonStatus(paths: HostPaths): Promise<DaemonStatus> {
  const record = await readPidRecord(paths);
  const running =
    record !== undefined &&
    isAlive(record.pid) &&
    (await socketAcceptsConnections(paths.socketPath));
  return {
    running,
    ...(running && record
      ? { pid: record.pid, version: record.version, startedAt: record.startedAt }
      : {}),
    socketPath: paths.socketPath,
    installedVersion: HOST_VERSION,
  };
}

/** Serializes start/stop across concurrent invocations (two pi-gui windows connecting at once). */
async function withStartLock<T>(paths: HostPaths, fn: () => Promise<T>): Promise<T> {
  await preparePrivateDir(paths.runDir);
  const deadline = Date.now() + START_TIMEOUT_MS + STALE_LOCK_MS;
  for (;;) {
    try {
      const handle = await open(paths.lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number.parseInt(await readFile(paths.lockPath, "utf8").catch(() => ""), 10);
      const age = Date.now() - (statSync(paths.lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (!Number.isInteger(owner) || !isAlive(owner) || age > STALE_LOCK_MS) {
        await rm(paths.lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${paths.lockPath}`);
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(paths.lockPath, { force: true });
  }
}

async function logTail(paths: HostPaths): Promise<string> {
  const text = await readFile(paths.logPath, "utf8").catch(() => "");
  return text.split("\n").slice(-20).join("\n").trim();
}

/**
 * Starts the server detached from this process (it survives the SSH session that started it).
 * Idempotent: an already running server is left alone, even when its version differs.
 */
export async function startDaemon(
  paths: HostPaths,
  entryScript: string,
): Promise<DaemonStatus & { readonly started: boolean }> {
  return withStartLock(paths, async () => {
    const current = await daemonStatus(paths);
    if (current.running) {
      return { ...current, started: false };
    }
    await mkdir(dirname(paths.logPath), { recursive: true });
    if ((statSync(paths.logPath, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
      truncateSync(paths.logPath, 0);
    }
    const logFd = openSync(paths.logPath, "a", 0o600);
    let exited: string | undefined;
    try {
      const child = spawn(process.execPath, [entryScript, "serve"], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, PI_GUI_HOST_HOME: paths.home },
      });
      child.once("exit", (code, signal) => {
        exited = signal ? `signal ${signal}` : `code ${String(code)}`;
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await daemonStatus(paths);
      if (status.running) {
        return { ...status, started: true };
      }
      if (exited) {
        break;
      }
      await sleep(100);
    }
    const tail = await logTail(paths);
    throw new Error(
      `pi-gui-host did not start${exited ? ` (exited with ${exited})` : ""}.${tail ? `\n${tail}` : ""}`,
    );
  });
}

/** Asks the server to exit, then kills it after `graceMs`. */
export async function stopDaemon(
  paths: HostPaths,
  graceMs = 10_000,
): Promise<DaemonStatus & { readonly stopped: boolean }> {
  return withStartLock(paths, async () => {
    const record = await readPidRecord(paths);
    if (!record || !isAlive(record.pid)) {
      await rm(paths.pidPath, { force: true });
      return { ...(await daemonStatus(paths)), stopped: false };
    }
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (isAlive(record.pid) && Date.now() < deadline) {
      await sleep(100);
    }
    if (isAlive(record.pid)) {
      process.kill(record.pid, "SIGKILL");
      await rm(paths.socketPath, { force: true });
      await rm(paths.pidPath, { force: true });
    }
    return { ...(await daemonStatus(paths)), stopped: true };
  });
}

/**
 * Copies bytes between this process's stdio and the server socket. pi-gui runs this over SSH,
 * so stdout carries only protocol bytes. Resolves when either side closes.
 */
export function proxyStdio(paths: HostPaths): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      const finish = () => {
        process.stdin.unpipe(socket);
        socket.destroy();
        resolve();
      };
      socket.once("close", finish);
      socket.once("error", finish);
      process.stdin.once("end", () => socket.end());
    });
  });
}
