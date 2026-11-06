import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { RemoteHostConfig, RemoteHostState } from "../../contracts/remote-hosts";
import { isRemoteWorkspaceId, parseRemoteWorkspaceId } from "../../contracts/remote-hosts";
import {
  installBundle,
  isSupportedNodeVersion,
  localCommandRunner,
  probeHost,
} from "../../electron/remote/remote-commands";
import { decodeRemoteHostConfig, RemoteHostStore } from "../../electron/remote/remote-host-store";
import { RemoteHosts } from "../../electron/remote/remote-hosts";
import { toDesktopForm, toServerForm } from "../../electron/remote/remote-ids";
import { RoutingDriver } from "../../electron/remote/routing-driver";

const run = promisify(execFile);
const hostPackage = resolve(__dirname, "../../../../packages/pi-gui-host");

test("remote ids round-trip between desktop and server form", () => {
  const desktopRef = { workspaceId: "pi-remote://devbox/home/me/app", sessionId: "s1" };
  expect(parseRemoteWorkspaceId(desktopRef.workspaceId)).toEqual({
    hostId: "devbox",
    serverPath: "/home/me/app",
  });
  expect(isRemoteWorkspaceId("/Users/me/app")).toBe(false);

  const args = [
    desktopRef,
    { targetWorkspace: { workspaceId: desktopRef.workspaceId, path: desktopRef.workspaceId } },
  ];
  expect(toServerForm("devbox", args)).toEqual([
    { workspaceId: "/home/me/app", sessionId: "s1" },
    { targetWorkspace: { workspaceId: "/home/me/app", path: "/home/me/app" } },
  ]);
  // Another host's ids are not touched.
  expect(toServerForm("other", desktopRef)).toEqual(desktopRef);

  const snapshot = {
    ref: { workspaceId: "/home/me/app", sessionId: "s1" },
    workspace: { workspaceId: "/home/me/app", path: "/home/me/app", displayName: "app" },
    sessionFilePath: "/home/me/.pi/agent/sessions/x.jsonl",
    preview: "edited /home/me/app/src/index.ts",
  };
  expect(toDesktopForm("devbox", snapshot)).toEqual({
    ref: desktopRef,
    workspace: {
      workspaceId: desktopRef.workspaceId,
      path: desktopRef.workspaceId,
      displayName: "app",
    },
    preview: "edited /home/me/app/src/index.ts",
  });
});

test("host settings reject values that are unsafe for ssh or a remote shell", () => {
  const valid = { id: "devbox", label: "Devbox", destination: "omar@devbox" };
  expect(decodeRemoteHostConfig({ ...valid, port: 2222 })).toEqual({ ...valid, port: 2222 });
  for (const invalid of [
    { ...valid, id: "Dev Box" },
    { ...valid, destination: "-oProxyCommand=evil" },
    { ...valid, destination: "a b" },
    { ...valid, hostHome: "~/it's" },
    { ...valid, nodePath: "C:\\node" },
    { ...valid, port: 70000 },
    { ...valid, extra: true },
  ]) {
    expect(() => decodeRemoteHostConfig(invalid)).toThrow();
  }
  expect(isSupportedNodeVersion("v22.19.0")).toBe(true);
  expect(isSupportedNodeVersion("v24.1.0")).toBe(true);
  expect(isSupportedNodeVersion("v22.18.1")).toBe(false);
  expect(isSupportedNodeVersion(undefined)).toBe(false);
});

test("the install script unpacks a bundle and makes it current", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-install-"));
  try {
    const source = join(root, "bundle");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(join(source, "dist", "main.js"), "// stub\n");
    await writeFile(join(source, "bundle-id"), "0.0.0-test\n");
    await run("tar", ["-czf", join(root, "bundle.tgz"), "-C", source, "."]);
    const config: RemoteHostConfig = {
      id: "local",
      label: "Local",
      destination: "localhost",
      hostHome: join(root, "host"),
    };

    const before = await probeHost(localCommandRunner, config);
    expect(before.installed).toBe(false);
    expect(before.nodeVersion).toMatch(/^v\d+/);

    await installBundle(localCommandRunner, config, {
      archivePath: join(root, "bundle.tgz"),
      bundleId: "0.0.0-test",
    });
    const after = await probeHost(localCommandRunner, config);
    expect(after).toMatchObject({ installed: true, bundleId: "0.0.0-test" });
    expect(await readFile(join(root, "host", "current", "dist", "main.js"), "utf8")).toBe(
      "// stub\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A routing driver whose only remote host runs this checkout's pi-gui-host locally. */
async function localRemote(root: string) {
  const hostHome = join(root, "host");
  await mkdir(hostHome, { recursive: true });
  await symlink(hostPackage, join(hostHome, "current"));
  const store = new RemoteHostStore(join(root, "userData"));
  await store.writeHosts([{ id: "box", label: "Box", destination: "localhost", hostHome }]);
  const states: RemoteHostState[] = [];
  const resynced: string[] = [];
  const hosts = new RemoteHosts({
    store,
    runner: localCommandRunner,
    bundle: undefined,
    client: { id: "test-client", name: "test", version: "0" },
    retryDelaysMs: [200],
    onStateChanged: (next) => states.push(...next),
    onResynced: (hostId) => resynced.push(hostId),
    onCatalogChanged: () => undefined,
  });
  const local = {
    listWorkspaces: () => Promise.resolve({ workspaces: [] }),
    listSessions: () => Promise.resolve({ sessions: [] }),
    runtimeSupervisor: {},
  } as unknown as PiSdkDriver;
  const driver = new RoutingDriver(local, hosts);
  return { hosts, driver, states, resynced, store, hostHome };
}

async function until<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting");
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

test("a remote host serves folders and threads, and keeps them through a reconnect", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "pi-remote-e2e-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // the server inherits it
  const project = join(root, "project");
  await mkdir(project);
  const setup = await localRemote(root);
  try {
    await setup.hosts.initialize();
    await until(() => setup.states.find((state) => state.status === "connected"));

    const folderId = `pi-remote://box${project}`;
    const synced = await setup.driver.syncWorkspace(folderId);
    expect(synced.workspace.workspaceId).toMatch(/^pi-remote:\/\/box\//);
    const workspaces = await setup.driver.listWorkspaces();
    expect(workspaces.workspaces.map((entry) => entry.workspaceId)).toEqual([
      synced.workspace.workspaceId,
    ]);

    const snapshot = await setup.driver.createSession(synced.workspace, { title: "remote chat" });
    expect(snapshot.ref.workspaceId).toBe(synced.workspace.workspaceId);
    expect(snapshot).not.toHaveProperty("sessionFilePath");
    expect(await setup.driver.getSessionFilePath(snapshot.ref)).toBeUndefined();

    const events: SessionDriverEvent[] = [];
    setup.driver.subscribe(snapshot.ref, (event) => {
      events.push(event);
    });
    await until(() => events.find((event) => event.type === "sessionUpdated"));
    await setup.driver.renameSession(snapshot.ref, "renamed remotely");

    // Drop the connection; the server keeps running and the client reconnects and resubscribes.
    setup.hosts.reconnect("box");
    await until(() => setup.resynced.length >= 2 || undefined);
    const eventsBefore = events.length;
    await setup.driver.renameSession(snapshot.ref, "after reconnect");
    await until(() => events.length > eventsBefore || undefined);
    const sessions = await setup.driver.listSessions();
    expect(
      sessions.sessions.find((entry) => entry.sessionRef.sessionId === snapshot.ref.sessionId)
        ?.title,
    ).toBe("after reconnect");

    // Offline: folders and threads come from the cache, other calls fail as unavailable.
    setup.hosts.disposeAll();
    const offline = new RemoteHosts({
      store: setup.store,
      runner: {
        spawn: () => {
          throw new Error("offline");
        },
      },
      bundle: undefined,
      client: { id: "test-client", name: "test", version: "0" },
      retryDelaysMs: [60_000],
      onStateChanged: () => undefined,
      onResynced: () => undefined,
      onCatalogChanged: () => undefined,
    });
    await offline.initialize();
    const offlineDriver = new RoutingDriver(
      {
        listWorkspaces: () => Promise.resolve({ workspaces: [] }),
        listSessions: () => Promise.resolve({ sessions: [] }),
        runtimeSupervisor: {},
      } as unknown as PiSdkDriver,
      offline,
    );
    expect((await offlineDriver.listWorkspaces()).workspaces).toHaveLength(1);
    expect((await offlineDriver.listSessions()).sessions.map((entry) => entry.title)).toContain(
      "after reconnect",
    );
    expect((await offlineDriver.syncWorkspace(synced.workspace.path)).workspace.workspaceId).toBe(
      synced.workspace.workspaceId,
    );
    await expect(offlineDriver.openSession(snapshot.ref)).rejects.toThrow(/not connected/);
    offline.disposeAll();
  } finally {
    setup.hosts.disposeAll();
    await run(process.execPath, [
      join(hostPackage, "dist", "main.js"),
      "daemon",
      "stop",
      "--home",
      setup.hostHome,
    ]).catch(() => undefined);
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});
