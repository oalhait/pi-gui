import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostBundle } from "./remote-host-connection";

/**
 * Finds the pi-gui-host bundle this app installs on servers: the first of `directories` with
 * `pi-gui-host.json` (naming the bundle id) beside `pi-gui-host.tgz`. Packaged apps carry it in
 * their resources; a checkout builds it with `pnpm --filter @pi-gui/pi-gui-host bundle`.
 */
export async function findHostBundle(
  directories: readonly string[],
): Promise<HostBundle | undefined> {
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "pi-gui-host.json"), "utf8")) as {
        bundleId?: unknown;
      };
      const archivePath = join(directory, "pi-gui-host.tgz");
      await access(archivePath);
      if (typeof manifest.bundleId === "string" && manifest.bundleId) {
        return { archivePath, bundleId: manifest.bundleId };
      }
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}
