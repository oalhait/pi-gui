import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import type { RemoteHostConfig } from "../../contracts/remote-hosts";

/**
 * Commands pi-gui runs on a remote host. Each is a fixed `sh` script plus single-quoted arguments,
 * so it behaves the same whatever the user's login shell is (sh, bash, zsh or fish). Scripts and
 * arguments never contain `'`, `\` or newlines, which keeps that quoting safe in every shell.
 */

const DEFAULT_HOST_HOME = "~/.pi-gui-host";

/** Expands `~` in the host home and finds Node (configured, on PATH, or on the login PATH). */
const PRELUDE = [
  "H=$1",
  'case $H in "~") H=$HOME ;; "~/"*) H="$HOME/${H#??}" ;; esac',
  "N=$2",
  'if [ -z "$N" ]; then N=$(command -v node 2>/dev/null); fi',
  'if [ -z "$N" ]; then N=$("${SHELL:-/bin/sh}" -lc "command -v node" 2>/dev/null | tail -n 1); fi',
].join("\n");

const PROBE_SCRIPT = [
  PRELUDE,
  'V=""',
  'if [ -n "$N" ]; then V=$("$N" --version 2>/dev/null); fi',
  'B=$(cat "$H/current/bundle-id" 2>/dev/null)',
  "I=no",
  'if [ -f "$H/current/dist/main.js" ]; then I=yes; fi',
  'echo "pigui:home=$H"',
  'echo "pigui:installed=$I"',
  'echo "pigui:node=$N"',
  'echo "pigui:nodeVersion=$V"',
  'echo "pigui:bundleId=$B"',
].join("\n");

/** Reads the bundle archive from stdin and makes it current. */
const INSTALL_SCRIPT = [
  PRELUDE,
  "B=$3",
  'D="$H/versions/$B"',
  'mkdir -p "$H/versions" || exit 1',
  'rm -rf "$D.partial" && mkdir -p "$D.partial" && tar -xzf - -C "$D.partial" || exit 1',
  'rm -rf "$D" && mv "$D.partial" "$D" && ln -sfn "versions/$B" "$H/current" || exit 1',
  'echo "pigui:installed=$B"',
].join("\n");

const NODE_REQUIRED = [
  'if [ -z "$N" ]; then echo "Node.js was not found on the server. Install Node.js 22.19 or newer, or set its path for this host." >&2; exit 127; fi',
].join("\n");

const PROXY_SCRIPT = [
  PRELUDE,
  NODE_REQUIRED,
  'exec "$N" "$H/current/dist/main.js" proxy --start --home "$H"',
].join("\n");

const STOP_SCRIPT = [
  PRELUDE,
  NODE_REQUIRED,
  'exec "$N" "$H/current/dist/main.js" daemon stop --home "$H"',
].join("\n");

const UNSAFE_SHELL_TEXT = /['\\\n\r]/;

function quote(value: string): string {
  if (UNSAFE_SHELL_TEXT.test(value)) {
    throw new Error(
      `Remote host settings cannot contain quotes, backslashes or newlines: ${value}`,
    );
  }
  return `'${value}'`;
}

/** Spawns `sh -c <script> sh <args...>` on the host: over SSH, or locally for tests. */
export interface RemoteCommandRunner {
  spawn(
    config: RemoteHostConfig,
    script: string,
    args: readonly string[],
  ): ChildProcessWithoutNullStreams;
}

export const sshCommandRunner: RemoteCommandRunner = {
  spawn(config, script, args) {
    const remoteCommand = ["sh", "-c", quote(script), "sh", ...args.map(quote)].join(" ");
    const sshArgs = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...(config.port ? ["-p", String(config.port)] : []),
      ...(config.identityFile ? ["-i", config.identityFile] : []),
      "--",
      config.destination,
      remoteCommand,
    ];
    return spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
  },
};

/** Runs the scripts on this machine; stands in for SSH in tests and local verification. */
export const localCommandRunner: RemoteCommandRunner = {
  spawn(_config, script, args) {
    return spawn("sh", ["-c", script, "sh", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  },
};

const scriptArgs = (config: RemoteHostConfig, ...extra: string[]) => [
  config.hostHome ?? DEFAULT_HOST_HOME,
  config.nodePath ?? "",
  ...extra,
];

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function collect(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const kill = (reason: string) => {
      child.kill("SIGKILL");
      reject(new Error(reason));
    };
    const timer = setTimeout(
      () => kill(`Timed out after ${Math.round(timeoutMs / 1000)} s`),
      timeoutMs,
    );
    const onAbort = () => kill("Cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The last few lines of stderr, for error messages. */
export function stderrSummary(stderr: string): string {
  return stderr.trim().split("\n").slice(-6).join("\n");
}

function failure(action: string, result: CommandResult): Error {
  const detail = stderrSummary(result.stderr);
  return new Error(
    `${action} failed${result.code === null ? "" : ` (exit ${result.code})`}${detail ? `: ${detail}` : ""}`,
  );
}

function parseTagged(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^pigui:([a-zA-Z]+)=(.*)$/.exec(line.trim());
    if (match) {
      values.set(match[1]!, match[2]!);
    }
  }
  return values;
}

export interface HostProbe {
  readonly home: string;
  readonly nodePath: string | undefined;
  readonly nodeVersion: string | undefined;
  /** Any pi-gui-host is installed as `current`, from a bundle or a linked checkout. */
  readonly installed: boolean;
  readonly bundleId: string | undefined;
}

export async function probeHost(
  runner: RemoteCommandRunner,
  config: RemoteHostConfig,
  signal?: AbortSignal,
): Promise<HostProbe> {
  const result = await collect(
    runner.spawn(config, PROBE_SCRIPT, scriptArgs(config)),
    30_000,
    signal,
  );
  const values = parseTagged(result.stdout);
  if (result.code !== 0 || !values.has("home")) {
    throw failure(`Connecting to ${config.destination}`, result);
  }
  const optional = (key: string) => values.get(key) || undefined;
  return {
    home: values.get("home")!,
    nodePath: optional("node"),
    nodeVersion: optional("nodeVersion"),
    installed: values.get("installed") === "yes",
    bundleId: optional("bundleId"),
  };
}

export async function installBundle(
  runner: RemoteCommandRunner,
  config: RemoteHostConfig,
  bundle: { readonly archivePath: string; readonly bundleId: string },
  signal?: AbortSignal,
): Promise<void> {
  const child = runner.spawn(config, INSTALL_SCRIPT, scriptArgs(config, bundle.bundleId));
  const done = collect(child, 10 * 60_000, signal);
  const archive = createReadStream(bundle.archivePath);
  archive.once("error", (error) => child.stdin.destroy(error));
  child.stdin.on("error", () => undefined); // The exit status reports the failure.
  archive.pipe(child.stdin);
  const result = await done;
  if (result.code !== 0 || parseTagged(result.stdout).get("installed") !== bundle.bundleId) {
    throw failure(`Installing pi-gui-host on ${config.destination}`, result);
  }
}

/** Starts the host server if needed and connects this process's pipes to it. */
export function spawnProxy(
  runner: RemoteCommandRunner,
  config: RemoteHostConfig,
): ChildProcessWithoutNullStreams {
  return runner.spawn(config, PROXY_SCRIPT, scriptArgs(config));
}

export async function stopHostServer(
  runner: RemoteCommandRunner,
  config: RemoteHostConfig,
): Promise<void> {
  const result = await collect(runner.spawn(config, STOP_SCRIPT, scriptArgs(config)), 30_000);
  if (result.code !== 0) {
    throw failure(`Stopping pi-gui-host on ${config.destination}`, result);
  }
}

/** True when `version` (`v22.19.0`) is at least Node 22.19, pi's minimum. */
export function isSupportedNodeVersion(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}
