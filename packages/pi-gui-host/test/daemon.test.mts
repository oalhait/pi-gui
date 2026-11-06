import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@pi-gui/remote-protocol";
import { createStreamPeer } from "@pi-gui/remote-protocol/node";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const run = promisify(execFile);

async function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, [main, ...args], { env });
  return JSON.parse(stdout) as Record<string, unknown>;
}

await test("daemon start is idempotent, serves through proxy, survives the client and stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "pgh-"));
  const env = {
    ...process.env,
    PI_GUI_HOST_HOME: join(root, "host"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
  };
  try {
    const first = await cli(env, "daemon", "start");
    assert.equal(first.running, true);
    assert.equal(first.started, true);
    const second = await cli(env, "daemon", "start");
    assert.equal(second.started, false);
    assert.equal(second.pid, first.pid);
    assert.equal((await stat(join(root, "host", "run"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "host", "run", "host.sock"))).mode & 0o777, 0o600);

    const proxy = spawn(process.execPath, [main, "proxy", "--start"], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const peer = createStreamPeer(proxy.stdout, proxy.stdin);
    const hello = (await peer.request("hello", {
      protocolVersion: PROTOCOL_VERSION,
      client: { id: "test", name: "test", version: "0" },
    })) as { host: { pid: number } };
    assert.equal(hello.host.pid, first.pid);
    const workspace = join(root, "project");
    await run("mkdir", ["-p", workspace]);
    await peer.request("driver/syncWorkspace", [workspace]);
    const listed = (await peer.request("driver/listWorkspaces", [])) as {
      workspaces: { path: string }[];
    };
    assert.equal(listed.workspaces.length, 1);
    proxy.kill("SIGKILL");

    const status = await cli(env, "daemon", "status");
    assert.equal(status.running, true, "the server outlives its client");

    const stopped = await cli(env, "daemon", "stop");
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.running, false);
  } finally {
    await cli(env, "daemon", "stop").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
