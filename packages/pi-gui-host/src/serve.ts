import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname } from "node:path";
import { createStreamPeer } from "@pi-gui/remote-protocol/node";
import type { HostPaths } from "./paths.js";
import { HostServer, type HostDriver } from "./server.js";
import { HOST_BUNDLE_ID, HOST_VERSION } from "./version.js";

export interface PidRecord {
  readonly pid: number;
  readonly version: string;
  readonly socketPath: string;
  readonly startedAt: string;
}

export interface RunningHost {
  readonly server: HostServer;
  close(): Promise<void>;
}

/** Creates the run directory as owner-only, or fails if someone else could replace its entries. */
export async function preparePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory()) {
    throw new Error(`${path} is not a directory`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${path} is owned by another user`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
  }
}

export function socketAcceptsConnections(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Serves `driver` on the host's private Unix socket until closed. Refuses to start when another
 * server already answers on the socket; removes a stale socket file otherwise.
 */
export async function serveHost(
  paths: HostPaths,
  driver: HostDriver,
  log: (message: string) => void,
): Promise<RunningHost> {
  await preparePrivateDir(paths.runDir);
  if (await socketAcceptsConnections(paths.socketPath)) {
    throw new Error(`Another pi-gui-host is already serving ${paths.socketPath}`);
  }
  await rm(paths.socketPath, { force: true });

  const startedAt = new Date().toISOString();
  const hostServer = new HostServer({
    driver,
    log,
    hostInfo: {
      version: HOST_VERSION,
      ...(HOST_BUNDLE_ID ? { bundleId: HOST_BUNDLE_ID } : {}),
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      homeDir: homedir(),
      nodeVersion: process.versions.node,
      pid: process.pid,
      startedAt,
    },
  });
  const sockets = new Set<Socket>();
  const listener: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined); // The peer reports it; avoid an unhandled error.
    hostServer.attach(createStreamPeer(socket, socket));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(paths.socketPath, () => {
      listener.off("error", reject);
      resolve();
    });
  });
  await chmod(paths.socketPath, 0o600);
  await mkdir(dirname(paths.pidPath), { recursive: true });
  const pidRecord: PidRecord = {
    pid: process.pid,
    version: HOST_VERSION,
    socketPath: paths.socketPath,
    startedAt,
  };
  await writeFile(paths.pidPath, `${JSON.stringify(pidRecord)}\n`, { mode: 0o600 });
  log(`pi-gui-host ${HOST_VERSION} listening on ${paths.socketPath} (pid ${process.pid})`);

  let closing: Promise<void> | undefined;
  return {
    server: hostServer,
    close: () => {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => listener.close(() => resolve()));
        hostServer.dispose();
        for (const socket of sockets) {
          socket.destroy();
        }
        await closed;
        await rm(paths.pidPath, { force: true });
        await rm(paths.socketPath, { force: true });
      })();
      return closing;
    },
  };
}
