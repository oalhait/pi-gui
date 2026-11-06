import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  HELLO_METHOD,
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type RpcPeer,
} from "@pi-gui/remote-protocol";
import { createStreamPeer } from "@pi-gui/remote-protocol/node";
import type { RemoteHostConfig, RemoteHostState } from "../../contracts/remote-hosts";
import {
  installBundle,
  isSupportedNodeVersion,
  probeHost,
  spawnProxy,
  stderrSummary,
  stopHostServer,
  type RemoteCommandRunner,
} from "./remote-commands";

export interface HostBundle {
  readonly archivePath: string;
  readonly bundleId: string;
}

export interface RemoteHostConnectionOptions {
  readonly config: RemoteHostConfig;
  readonly runner: RemoteCommandRunner;
  /** The pi-gui-host bundle this app ships, when it has one. */
  readonly bundle: HostBundle | undefined;
  readonly client: HelloParams["client"];
  readonly onState: (state: RemoteHostState) => void;
  readonly onConnected: (peer: RpcPeer) => void;
  /** Delays before each reconnect attempt; the last repeats. */
  readonly retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const HELLO_TIMEOUT_MS = 30_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Keeps one host connected: checks the server, installs or updates pi-gui-host when this app's
 * bundle differs, starts the server through `proxy --start`, says hello, and reconnects with
 * backoff whenever the connection drops. The server keeps running while disconnected.
 */
export class RemoteHostConnection {
  private state: RemoteHostState;
  private currentPeer: RpcPeer | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private attempt: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private disposed = false;

  constructor(private readonly options: RemoteHostConnectionOptions) {
    this.state = { config: options.config, status: "disconnected" };
  }

  get snapshot(): RemoteHostState {
    return this.state;
  }

  get peer(): RpcPeer | undefined {
    return this.currentPeer;
  }

  /** Connects now unless already connected or connecting. */
  connect(): void {
    if (this.disposed || this.attempt || this.currentPeer) {
      return;
    }
    this.clearRetry();
    const attempt = new AbortController();
    this.attempt = attempt;
    this.run(attempt.signal)
      .then(
        () => undefined,
        (error: unknown) => {
          if (attempt.signal.aborted || this.disposed) {
            return;
          }
          this.fail(message(error));
        },
      )
      .finally(() => {
        if (this.attempt === attempt) {
          this.attempt = undefined;
        }
      });
  }

  /** Drops the current connection (if any) and connects again immediately. */
  reconnect(): void {
    this.closeCurrent();
    this.failures = 0;
    this.connect();
  }

  /** Stops the server (interrupting running chats), then reconnects, which starts it again. */
  async restartServer(): Promise<void> {
    this.closeCurrent();
    this.setState({ status: "connecting", message: "Restarting the host server…" });
    try {
      await stopHostServer(this.options.runner, this.options.config);
    } finally {
      this.failures = 0;
      this.connect();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeCurrent();
    this.setState({ status: "disconnected" });
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { config, runner, bundle } = this.options;
    this.setState({ status: "connecting", message: `Connecting to ${config.destination}…` });
    const probe = await probeHost(runner, config, signal);
    if (!probe.nodePath) {
      throw new Error(
        "Node.js was not found on the server. Install Node.js 22.19 or newer, or set its path for this host.",
      );
    }
    if (!isSupportedNodeVersion(probe.nodeVersion)) {
      throw new Error(
        `The server has Node.js ${probe.nodeVersion ?? "(unknown version)"}; pi needs 22.19 or newer.`,
      );
    }
    if (bundle && (!probe.installed || probe.bundleId !== bundle.bundleId)) {
      this.setState({
        status: "installing",
        message: probe.bundleId
          ? "Updating pi-gui-host on the server…"
          : "Installing pi-gui-host on the server…",
      });
      await installBundle(runner, config, bundle, signal);
    } else if (!bundle && !probe.installed) {
      throw new Error(
        "pi-gui-host is not installed on the server and this build of pi-gui has no bundle to install. Run `pnpm --filter @pi-gui/pi-gui-host bundle`.",
      );
    }
    signal.throwIfAborted();

    this.setState({ status: "connecting", message: "Starting the host server…" });
    const child = spawnProxy(runner, config);
    this.child = child;
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });
    child.once("error", (error) => {
      stderr += `\n${error.message}`;
    });
    const peer = createStreamPeer(child.stdout, child.stdin);
    const exited = new Promise<never>((_, reject) => {
      child.once("close", (code) =>
        reject(
          new Error(
            `The connection to ${config.destination} closed${code ? ` (exit ${code})` : ""}${
              stderrSummary(stderr) ? `: ${stderrSummary(stderr)}` : ""
            }`,
          ),
        ),
      );
    });
    exited.catch(() => undefined);
    let hello: HelloResult;
    try {
      hello = await Promise.race([
        peer.request<HelloResult>(
          HELLO_METHOD,
          { protocolVersion: PROTOCOL_VERSION, client: this.options.client } satisfies HelloParams,
          { timeoutMs: HELLO_TIMEOUT_MS, signal },
        ),
        exited,
      ]);
    } catch (error) {
      peer.close();
      child.kill();
      throw error;
    }

    this.currentPeer = peer;
    this.failures = 0;
    const updatePending =
      bundle !== undefined &&
      hello.host.bundleId !== undefined &&
      hello.host.bundleId !== bundle.bundleId;
    this.setState({
      status: "connected",
      hostVersion: hello.host.version,
      hostname: hello.host.hostname,
      lastConnectedAt: new Date().toISOString(),
      ...(updatePending
        ? { message: "An update is installed. Restart the host server when no chats are running." }
        : {}),
    });
    peer.onClose(() => {
      if (this.currentPeer !== peer) {
        return;
      }
      this.currentPeer = undefined;
      this.child = undefined;
      child.kill();
      if (!this.disposed) {
        this.fail(
          `Lost the connection to ${config.destination}${stderrSummary(stderr) ? `: ${stderrSummary(stderr)}` : ""}`,
        );
      }
    });
    this.options.onConnected(peer);
  }

  private fail(reason: string): void {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 60_000;
    this.failures += 1;
    this.setState({
      status: this.state.lastConnectedAt && this.failures === 1 ? "disconnected" : "error",
      message: reason,
    });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private closeCurrent(): void {
    this.clearRetry();
    this.attempt?.abort();
    this.attempt = undefined;
    const peer = this.currentPeer;
    this.currentPeer = undefined;
    peer?.close();
    this.child?.kill();
    this.child = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private setState(next: Omit<RemoteHostState, "config">): void {
    const { lastConnectedAt, hostVersion, hostname } = this.state;
    this.state = {
      config: this.options.config,
      ...(lastConnectedAt ? { lastConnectedAt } : {}),
      ...(hostVersion ? { hostVersion } : {}),
      ...(hostname ? { hostname } : {}),
      ...next,
    };
    this.options.onState(this.state);
  }
}
