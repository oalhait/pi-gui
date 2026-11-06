import type { SessionCatalogEntry, WorkspaceCatalogEntry } from "@pi-gui/catalogs";
import { join } from "node:path";
import {
  isValidRemoteHostId,
  REMOTE_HOSTS_FILE_VERSION,
  type RemoteHostConfig,
} from "../../contracts/remote-hosts";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

/**
 * Owns `remote-hosts.json` (the configured hosts) and `remote-hosts/<id>.catalog.json` (the last
 * folders and threads seen on each host, so they still show while it is offline).
 */

interface RemoteHostsFile {
  readonly version: typeof REMOTE_HOSTS_FILE_VERSION;
  readonly hosts: readonly RemoteHostConfig[];
}

export interface RemoteCatalogCache {
  readonly version: 1;
  readonly savedAt: string;
  /** In desktop form (`pi-remote://` ids). */
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly sessions: readonly SessionCatalogEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(field: string): never {
  throw new Error(`Invalid remote host ${field}; the saved file was retained.`);
}

const HOST_KEYS = ["id", "label", "destination", "port", "identityFile", "nodePath", "hostHome"];

/** Validates one host. Also used for hosts the renderer submits. */
export function decodeRemoteHostConfig(value: unknown, path = "host"): RemoteHostConfig {
  if (!isRecord(value)) {
    fail(path);
  }
  for (const key of Object.keys(value)) {
    if (!HOST_KEYS.includes(key)) {
      fail(`${path}.${key} (unsupported field)`);
    }
  }
  const text = (key: string, required: boolean): string | undefined => {
    const field = value[key];
    if (field === undefined && !required) {
      return undefined;
    }
    // These reach a remote shell inside single quotes; see remote-commands.ts.
    if (typeof field !== "string" || !field.trim() || /['\\\n\r]/.test(field)) {
      fail(`${path}.${key}`);
    }
    return field.trim();
  };
  const id = text("id", true)!;
  if (!isValidRemoteHostId(id)) {
    fail(`${path}.id (use lowercase letters, digits and dashes)`);
  }
  const destination = text("destination", true)!;
  // ssh would read a leading dash as an option.
  if (destination.startsWith("-") || /\s/.test(destination)) {
    fail(`${path}.destination`);
  }
  const port = value.port;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
  ) {
    fail(`${path}.port`);
  }
  const identityFile = text("identityFile", false);
  const nodePath = text("nodePath", false);
  const hostHome = text("hostHome", false);
  return {
    id,
    label: text("label", true)!,
    destination,
    ...(port === undefined ? {} : { port: port as number }),
    ...(identityFile ? { identityFile } : {}),
    ...(nodePath ? { nodePath } : {}),
    ...(hostHome ? { hostHome } : {}),
  };
}

function decodeHostsFile(value: unknown): RemoteHostsFile {
  if (
    !isRecord(value) ||
    value.version !== REMOTE_HOSTS_FILE_VERSION ||
    !Array.isArray(value.hosts)
  ) {
    fail("file");
  }
  const hosts = value.hosts.map((host, index) => decodeRemoteHostConfig(host, `hosts[${index}]`));
  if (new Set(hosts.map((host) => host.id)).size !== hosts.length) {
    fail("file (duplicate ids)");
  }
  return { version: REMOTE_HOSTS_FILE_VERSION, hosts };
}

function decodeCatalogCache(value: unknown): RemoteCatalogCache | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.savedAt !== "string" ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.sessions)
  ) {
    return undefined;
  }
  return value as unknown as RemoteCatalogCache;
}

export class RemoteHostStore {
  private readonly hostsPath: string;
  private readonly cacheDir: string;

  constructor(userDataDir: string) {
    this.hostsPath = join(userDataDir, "remote-hosts.json");
    this.cacheDir = join(userDataDir, "remote-hosts");
  }

  /** Throws when the file is corrupt and has no valid backup, so it is never overwritten. */
  async readHosts(): Promise<readonly RemoteHostConfig[]> {
    const read = await readJsonWithBackup(this.hostsPath);
    if (read.value === undefined) {
      if (read.corrupted) {
        throw new Error(`${this.hostsPath} is corrupt; repair or remove it to use remote hosts.`);
      }
      return [];
    }
    return decodeHostsFile(read.value).hosts;
  }

  async writeHosts(hosts: readonly RemoteHostConfig[]): Promise<void> {
    const file = decodeHostsFile({ version: REMOTE_HOSTS_FILE_VERSION, hosts });
    await writeFileAtomicQueued(
      this.hostsPath,
      `${JSON.stringify(file, null, 2)}\n`,
      decodeHostsFile,
    );
  }

  async readCatalog(hostId: string): Promise<RemoteCatalogCache | undefined> {
    const read = await readJsonWithBackup(this.catalogPath(hostId));
    return decodeCatalogCache(read.value);
  }

  async writeCatalog(hostId: string, cache: RemoteCatalogCache): Promise<void> {
    // A damaged cache is only a cache: replace it rather than refuse.
    await writeFileAtomicQueued(
      this.catalogPath(hostId),
      `${JSON.stringify(cache)}\n`,
      (value) => value,
    );
  }

  private catalogPath(hostId: string): string {
    if (!isValidRemoteHostId(hostId)) {
      throw new Error(`Invalid remote host id: ${hostId}`);
    }
    return join(this.cacheDir, `${hostId}.catalog.json`);
  }
}
