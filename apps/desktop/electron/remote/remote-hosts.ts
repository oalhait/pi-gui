import type { HelloParams } from "@pi-gui/remote-protocol";
import type { RemoteHostConfig, RemoteHostState } from "../../contracts/remote-hosts";
import { probeHost, type HostProbe, type RemoteCommandRunner } from "./remote-commands";
import { RemoteHostConnection, type HostBundle } from "./remote-host-connection";
import { decodeRemoteHostConfig, type RemoteHostStore } from "./remote-host-store";
import { RemoteSessionDriver } from "./remote-session-driver";
import type { RemoteDriverLookup } from "./routing-driver";

export interface RemoteHostsOptions {
  readonly store: RemoteHostStore;
  readonly runner: RemoteCommandRunner;
  readonly bundle: HostBundle | undefined;
  readonly client: HelloParams["client"];
  /** Any host's connection state changed. */
  readonly onStateChanged: (states: readonly RemoteHostState[]) => void;
  /** A host reconnected and its subscriptions resumed; reload what may have been missed. */
  readonly onResynced: (hostId: string) => void;
  /** A host's folders or threads may have changed (connect, add, remove). */
  readonly onCatalogChanged: () => void;
  readonly retryDelaysMs?: readonly number[];
}

interface HostEntry {
  readonly config: RemoteHostConfig;
  readonly driver: RemoteSessionDriver;
  readonly connection: RemoteHostConnection;
}

/** The configured remote hosts: their settings, connections and drivers. Lives in main. */
export class RemoteHosts implements RemoteDriverLookup {
  private readonly entries = new Map<string, HostEntry>();
  private hostsLoadError: string | undefined;

  constructor(private readonly options: RemoteHostsOptions) {}

  /** Reads the hosts and their cached catalogs, then starts connecting in the background. */
  async initialize(): Promise<void> {
    let hosts: readonly RemoteHostConfig[] = [];
    try {
      hosts = await this.options.store.readHosts();
    } catch (error) {
      // Keep the app usable; remote hosts stay off and the file is not overwritten.
      this.hostsLoadError = error instanceof Error ? error.message : String(error);
      console.error(`[remote] ${this.hostsLoadError}`);
    }
    for (const config of hosts) {
      this.add(config);
    }
    await Promise.all([...this.entries.values()].map((entry) => entry.driver.loadCache()));
    for (const entry of this.entries.values()) {
      entry.connection.connect();
    }
  }

  get loadError(): string | undefined {
    return this.hostsLoadError;
  }

  driverFor(hostId: string): RemoteSessionDriver | undefined {
    return this.entries.get(hostId)?.driver;
  }

  drivers(): readonly RemoteSessionDriver[] {
    return [...this.entries.values()].map((entry) => entry.driver);
  }

  states(): readonly RemoteHostState[] {
    return [...this.entries.values()].map((entry) => entry.connection.snapshot);
  }

  /** Adds a host or replaces one with the same id, saves the list, and connects. */
  async saveHost(input: unknown): Promise<void> {
    this.assertWritable();
    const config = decodeRemoteHostConfig(input);
    const hosts = [...this.entries.values()].map((entry) => entry.config);
    const next = hosts.some((host) => host.id === config.id)
      ? hosts.map((host) => (host.id === config.id ? config : host))
      : [...hosts, config];
    await this.options.store.writeHosts(next);
    this.dispose(config.id);
    const entry = this.add(config);
    await entry.driver.loadCache();
    entry.connection.connect();
    this.changed();
    this.options.onCatalogChanged();
  }

  /**
   * Forgets a host. Its server, chats and files stay on the server; adding the host again with
   * the same id brings its folders back.
   */
  async removeHost(hostId: string): Promise<void> {
    this.assertWritable();
    const hosts = [...this.entries.values()]
      .map((entry) => entry.config)
      .filter((host) => host.id !== hostId);
    await this.options.store.writeHosts(hosts);
    this.dispose(hostId);
    this.changed();
    this.options.onCatalogChanged();
  }

  reconnect(hostId: string): void {
    this.entries.get(hostId)?.connection.reconnect();
  }

  restartServer(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId);
    return entry ? entry.connection.restartServer() : Promise.resolve();
  }

  /** Checks SSH access and Node.js without installing or starting anything. */
  testHost(input: unknown): Promise<HostProbe> {
    return probeHost(this.options.runner, decodeRemoteHostConfig(input));
  }

  disposeAll(): void {
    for (const hostId of [...this.entries.keys()]) {
      this.dispose(hostId);
    }
  }

  private add(config: RemoteHostConfig): HostEntry {
    const driver = new RemoteSessionDriver({
      hostId: config.id,
      label: config.label,
      store: this.options.store,
      onResynced: (hostId) => this.options.onResynced(hostId),
    });
    const connection = new RemoteHostConnection({
      config,
      runner: this.options.runner,
      bundle: this.options.bundle,
      client: this.options.client,
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      onState: () => this.changed(),
      onConnected: (peer) => {
        driver.attach(peer).then(
          () => this.options.onCatalogChanged(),
          (error: unknown) => console.warn(`[remote:${config.id}] resync failed`, error),
        );
      },
    });
    const entry = { config, driver, connection };
    this.entries.set(config.id, entry);
    return entry;
  }

  private dispose(hostId: string): void {
    const entry = this.entries.get(hostId);
    if (entry) {
      this.entries.delete(hostId);
      entry.connection.dispose();
    }
  }

  private changed(): void {
    this.options.onStateChanged(this.states());
  }

  private assertWritable(): void {
    if (this.hostsLoadError) {
      throw new Error(this.hostsLoadError);
    }
  }
}
