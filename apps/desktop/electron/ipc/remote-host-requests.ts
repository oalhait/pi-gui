import { desktopIpc } from "../../contracts/ipc";
import type { RemoteHostTestResult } from "../../contracts/remote-hosts";
import type { RemoteHosts } from "../remote/remote-hosts";
import type { MainFrameHandler } from "./main-frame-ipc";

export type RemoteHostRequestsOwner = Pick<
  RemoteHosts,
  "states" | "saveHost" | "removeHost" | "testHost" | "reconnect" | "restartServer"
>;

const anyValue = (raw: unknown) => raw;

function hostId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Expected a remote host id.");
  }
  return raw;
}

/** Host settings are validated by `RemoteHosts` (decodeRemoteHostConfig) before any use. */
export function registerRemoteHostRequests(
  handle: MainFrameHandler,
  owner: () => RemoteHostRequestsOwner,
): void {
  handle(desktopIpc.listRemoteHosts, anyValue, () => owner().states());
  handle(desktopIpc.saveRemoteHost, anyValue, async (config) => {
    await owner().saveHost(config);
    return owner().states();
  });
  handle(desktopIpc.removeRemoteHost, hostId, async (id) => {
    await owner().removeHost(id);
    return owner().states();
  });
  handle(desktopIpc.testRemoteHost, anyValue, async (config): Promise<RemoteHostTestResult> => {
    try {
      const probe = await owner().testHost(config);
      if (!probe.nodeVersion) {
        return {
          ok: false,
          message:
            "Connected, but Node.js was not found. Install Node.js 22.19 or newer on the server, or set its path.",
        };
      }
      return {
        ok: true,
        home: probe.home,
        nodeVersion: probe.nodeVersion,
        installed: probe.installed,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  handle(desktopIpc.reconnectRemoteHost, hostId, (id) => owner().reconnect(id));
  handle(desktopIpc.restartRemoteHost, hostId, (id) => owner().restartServer(id));
}
