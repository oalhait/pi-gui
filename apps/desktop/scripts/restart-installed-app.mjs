#!/usr/bin/env node
/*
 * `pnpm app:restart`: build pi-gui from this checkout, sign it, install it over
 * /Applications/pi-gui.app, relaunch it, and let the new build continue the threads the
 * restart cut off (see electron/persistence/restart-resume-store.ts).
 *
 * The work runs in a detached worker so quitting the app cannot kill it, even when an agent
 * inside pi-gui runs the command. This process only follows the worker's log; it may itself
 * be stopped by the quit, and the thread that ran it is then continued with the others.
 *
 * Order matters. The build and a typecheck happen while the old app keeps running, so a
 * failure changes nothing. The new bundle is signed and verified before it replaces the old
 * one, so the app never launches unsigned (which is what made the old after-the-fact
 * re-sign unreliable). A build that quits right after launch is swapped back out.
 *
 * macOS only. Settings (environment):
 *   PI_GUI_APP_PATH           installed app (default /Applications/pi-gui.app)
 *   PI_GUI_SIGNING_IDENTITY   code-signing identity (default: the keychain's only one)
 *   PI_APP_USER_DATA_DIR      app data directory (default ~/Library/Application Support/pi)
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const appPath = process.env.PI_GUI_APP_PATH?.trim() || "/Applications/pi-gui.app";
const appExecutable = path.join(appPath, "Contents/MacOS/pi-gui");
const bundleId = "com.pi-gui.desktop";
const userDataDir =
  process.env.PI_APP_USER_DATA_DIR?.trim() ||
  path.join(homedir(), "Library/Application Support/pi");
// Keep in sync with RESTART_REQUEST_FILE in restart-resume-store.ts.
const restartRequestFile = path.join(userDataDir, "restart-request.json");
const logDir = path.join(homedir(), "Library/Logs/pi-gui-restart");
const lockFile = path.join(logDir, "restart.lock");
const backupApp = path.join(homedir(), "Library/Caches/pi-gui-restart/previous.app");
const builtApp = path.join(desktopDir, "release/mac-arm64/pi-gui.app");
const entitlements = path.join(desktopDir, "resources/entitlements.mac.plist");
const MIN_NODE = [22, 19];
const DONE = "RESULT ok";
const FAILED = "RESULT failed";

if (process.platform !== "darwin") {
  console.error("pnpm app:restart installs the macOS app; it only runs on macOS.");
  process.exit(1);
}

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3]);
} else {
  await launchWorker();
}

/* ── Launcher: start the worker, then follow its log ───────────────────── */

async function launchWorker() {
  mkdirSync(logDir, { recursive: true });
  const runningPid = lockedPid();
  if (runningPid) {
    console.error(`A restart is already running (pid ${runningPid}); see ${logDir}.`);
    process.exit(1);
  }
  const logFile = path.join(
    logDir,
    `restart-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  const log = openSync(logFile, "a");
  const worker = spawn(process.execPath, [scriptPath, "--worker", logFile], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  worker.unref();
  closeSync(log);
  writeFileSync(lockFile, String(worker.pid));
  console.log(`Restarting pi-gui from ${repoRoot}`);
  console.log(`Log: ${logFile}`);
  console.log("Building first; the app keeps running until the new build is signed.\n");
  process.exit(await followLog(logFile, worker.pid));
}

/** Prints the log as it grows; resolves to the exit code once the worker reports. */
async function followLog(logFile, workerPid) {
  let printed = 0;
  for (;;) {
    const text = readFileSync(logFile, "utf8");
    if (text.length > printed) {
      process.stdout.write(text.slice(printed));
      printed = text.length;
    }
    if (text.includes(`\n${DONE}`)) return 0;
    if (text.includes(`\n${FAILED}`)) return 1;
    if (workerPid && !isAlive(workerPid)) {
      console.error("\nThe restart worker exited without reporting a result.");
      return 1;
    }
    await sleep(500);
  }
}

/* ── Worker: build, sign, quit, install, relaunch ──────────────────────── */

async function runWorker(logFile) {
  let requestWritten = false;
  try {
    step(`Worker ${process.pid}; log ${logFile}`);
    const env = buildEnvironment();
    const identity = await signingIdentity();

    step("Building pi-gui (pnpm build + electron-builder --dir)");
    await run("pnpm", ["--filter", "@pi-gui/desktop", "run", "build"], { env });
    await run(
      "pnpm",
      [
        "exec",
        "electron-builder",
        "--mac",
        "--dir",
        "--publish",
        "never",
        "-c.mac.notarize=false",
        "-c.mac.identity=null",
      ],
      { env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }, cwd: desktopDir },
    );
    if (!existsSync(builtApp)) throw new Error(`The build did not produce ${builtApp}.`);
    // The working tree can hold another thread's half-finished edits; don't install those.
    step("Typechecking the desktop app");
    await run("pnpm", ["--filter", "@pi-gui/desktop", "run", "typecheck"], { env });

    step(`Signing the new build with "${identity}"`);
    await run("codesign", [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      "--sign",
      identity,
      builtApp,
    ]);
    await verifySignature(builtApp, identity);

    // Copy next to the installed app first, so the swap below is two renames.
    const incoming = path.join(path.dirname(appPath), ".pi-gui-incoming.app");
    await rm(incoming, { recursive: true, force: true });
    await run("ditto", [builtApp, incoming]);
    await verifySignature(incoming, identity);

    const pids = await appPids();
    if (pids.length > 0) {
      step("Quitting pi-gui; threads that are running will continue after the relaunch");
      writeFileSync(
        restartRequestFile,
        `${JSON.stringify({ version: 1, requestedAt: new Date().toISOString() })}\n`,
      );
      requestWritten = true;
      await quitApp(pids);
      requestWritten = false;
    } else {
      step("pi-gui is not running; installing and launching it");
    }

    step(`Installing to ${appPath}`);
    mkdirSync(path.dirname(backupApp), { recursive: true });
    await rm(backupApp, { recursive: true, force: true });
    if (existsSync(appPath)) await rename(appPath, backupApp);
    try {
      await rename(incoming, appPath);
    } catch (error) {
      if (existsSync(backupApp)) await rename(backupApp, appPath);
      throw error;
    }
    await verifySignature(appPath, identity);

    step("Launching the new build");
    if (!(await launchAndSettle())) {
      step("The new build did not stay running; putting the previous build back");
      if (existsSync(backupApp)) {
        await rm(appPath, { recursive: true, force: true });
        await rename(backupApp, appPath);
        await launchAndSettle();
      }
      throw new Error("The new build quit right after launch; the previous build is back.");
    }
    step(`Done. The previous build is kept at ${backupApp}.`);
    console.log(DONE);
  } catch (error) {
    // A restart that never quit the app must not make a later ordinary quit record threads.
    if (requestWritten) rmSync(restartRequestFile, { force: true });
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    console.log(FAILED);
    process.exitCode = 1;
  } finally {
    rmSync(lockFile, { force: true });
  }
}

/** pnpm and the build need Node >= 22.19; fall back to a Homebrew Node when PATH has an older one. */
function buildEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (nodeSatisfies(process.versions.node)) {
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
    return env;
  }
  for (const candidate of ["/opt/homebrew/opt/node@24/bin", "/opt/homebrew/opt/node@22/bin"]) {
    if (existsSync(path.join(candidate, "node"))) {
      env.PATH = `${candidate}${path.delimiter}${env.PATH ?? ""}`;
      step(`Node ${process.versions.node} is too old for the build; using ${candidate}`);
      return env;
    }
  }
  throw new Error(
    `The build needs Node >= ${MIN_NODE.join(".")}; this is ${process.versions.node}.`,
  );
}

function nodeSatisfies(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * The identity macOS privacy grants are tied to. A self-signed certificate reads as
 * "not trusted" to `find-identity -v`, so list every code-signing identity.
 */
async function signingIdentity() {
  const configured = process.env.PI_GUI_SIGNING_IDENTITY?.trim();
  const { stdout } = await execFile("security", ["find-identity", "-p", "codesigning"]);
  const names = [
    ...new Set([...stdout.matchAll(/^\s+\d+\) [0-9A-F]{40} "([^"]+)"/gm)].map((match) => match[1])),
  ];
  if (configured) {
    if (!names.includes(configured)) {
      throw new Error(`No code-signing identity named "${configured}" is in the keychain.`);
    }
    return configured;
  }
  if (names.length === 1) return names[0];
  throw new Error(
    names.length === 0
      ? "No code-signing identity is in the keychain. A dev build must be signed so macOS keeps its permissions."
      : `Several code-signing identities found (${names.join(", ")}); set PI_GUI_SIGNING_IDENTITY.`,
  );
}

async function verifySignature(bundle, identity) {
  await run("codesign", ["--verify", "--deep", "--strict", bundle]);
  const { stderr } = await execFile("codesign", ["-dvv", bundle]);
  if (!stderr.includes(`Authority=${identity}`)) {
    throw new Error(`${bundle} is not signed by "${identity}".`);
  }
  if (!stderr.includes(`Identifier=${bundleId}`)) {
    throw new Error(`${bundle} does not have the identifier ${bundleId}.`);
  }
}

/** Opens the installed app; true when it is still running a little after it started. */
async function launchAndSettle() {
  await run("open", [appPath]);
  try {
    await waitFor(async () => (await appPids()).length > 0, 30_000, "the app to start");
  } catch {
    return false;
  }
  await sleep(10_000);
  return (await appPids()).length > 0;
}

async function quitApp(pids) {
  // A normal quit, so pi-gui saves drafts and records the threads it is cutting off.
  try {
    await run("osascript", [
      "-e",
      `with timeout of 20 seconds\ntell application id "${bundleId}" to quit\nend timeout`,
    ]);
  } catch (error) {
    // Electron also quits normally (before-quit included) on SIGTERM.
    step(`Asking pi-gui to quit failed (${error.message}); sending SIGTERM instead`);
    for (const pid of pids) process.kill(pid, "SIGTERM");
  }
  await waitFor(
    async () => !pids.some(isAlive),
    60_000,
    "pi-gui to quit (it was left running; nothing was installed)",
  );
}

/**
 * The installed app's main process. Read from `ps`, because macOS `pgrep` skips its own
 * ancestors, and an agent inside pi-gui runs this command as one of the app's descendants.
 */
async function appPids() {
  const { stdout } = await execFile("ps", ["-axo", "pid=,command="], { maxBuffer: 16 << 20 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (!match) return [];
    const command = match[2];
    return command === appExecutable || command.startsWith(`${appExecutable} `)
      ? [Number(match[1])]
      : [];
  });
}

function lockedPid() {
  if (!existsSync(lockFile)) return undefined;
  const pid = Number(readFileSync(lockFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
  // Its worker is gone: left over from a crash.
  rmSync(lockFile, { force: true });
  return undefined;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

function step(message) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${message}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
