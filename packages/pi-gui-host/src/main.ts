#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import { PROTOCOL_VERSION } from "@pi-gui/remote-protocol";
import { daemonStatus, proxyStdio, startDaemon, stopDaemon } from "./daemon.js";
import { hostPaths } from "./paths.js";
import { serveHost } from "./serve.js";
import { HOST_VERSION } from "./version.js";

const USAGE = `pi-gui-host ${HOST_VERSION}

Runs pi-gui chats on this machine. pi-gui connects to it over SSH.

Commands (each daemon command prints one JSON object):
  daemon start     Start the server in the background if it is not running
  daemon stop      Stop the background server
  daemon status    Report whether the server is running
  version          Print this command's version and protocol version
  proxy [--start]  Connect stdin/stdout to the server (--start starts it first)
  serve            Run the server in the foreground

--home <dir> or PI_GUI_HOST_HOME sets the state directory (default ~/.pi-gui-host).`;

const entryScript = fileURLToPath(import.meta.url);

/** `--home <dir>` (from pi-gui) wins over PI_GUI_HOST_HOME; it is removed from the arguments. */
function takeHomeOption(argv: string[]): string | undefined {
  const index = argv.indexOf("--home");
  if (index === -1) {
    return undefined;
  }
  const [, value] = argv.splice(index, 2);
  if (!value) {
    throw new Error("--home needs a directory");
  }
  return value;
}

const args = process.argv.slice(2);
const homeOption = takeHomeOption(args);
if (homeOption) {
  // The detached server inherits it through the environment.
  process.env.PI_GUI_HOST_HOME = homeOption;
}
const paths = hostPaths();

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function serve(): Promise<void> {
  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  const driver = new PiSdkDriver({ catalogFilePath: paths.catalogPath });
  const running = await serveHost(paths, driver, log);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`received ${signal}, stopping`);
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`stop failed: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => undefined); // Detached: a closing SSH session must not stop us.
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error.stack ?? error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(
      `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, subcommand] = argv;
  switch (command) {
    case "serve":
      await serve();
      return -1; // Keep running.
    case "version":
      printJson({ version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION });
      return 0;
    case "proxy":
      if (argv.includes("--start")) {
        await startDaemon(paths, entryScript);
      }
      await proxyStdio(paths);
      process.exit(0); // stdin can keep the event loop alive after the socket closed.
      break;
    case "daemon":
      try {
        switch (subcommand) {
          case "start":
            printJson({ ok: true, ...(await startDaemon(paths, entryScript)) });
            return 0;
          case "stop":
            printJson({ ok: true, ...(await stopDaemon(paths)) });
            return 0;
          case "status":
            printJson({ ok: true, ...(await daemonStatus(paths)) });
            return 0;
          default:
            break;
        }
      } catch (error) {
        printJson({ ok: false, error: errorMessage(error) });
        return 1;
      }
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      break;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

main(args).then(
  (code) => {
    if (code >= 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    process.stderr.write(`pi-gui-host: ${errorMessage(error)}\n`);
    process.exit(1);
  },
);
