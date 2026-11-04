import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

async function findLeaseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl.lease")).map((entry) => join(dir, entry));
}

async function leaseHolderPid(leasePath: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

/**
 * macOS derives the hostname from the network when none is set, so the app
 * that wrote a lease may have recorded `mac` while this launch sees `mac.lan`.
 * A lease left by a process that is gone must still open straight away instead
 * of waiting out the cross-host TTL.
 */
test("a dead holder's lease recorded under a network-variant hostname does not block", async () => {
  test.setTimeout(120_000);
  const agentDir = await makeUserDataDir("pi-gui-shared-agent-");
  const workspacePath = await makeWorkspace("lease-host-variant-workspace");
  const title = "Hostname variant lease thread";

  const first = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    agentDir,
    testMode: "background",
  });
  try {
    await createSessionViaIpc(await first.firstWindow(), workspacePath, title);
    await expect.poll(() => findLeaseFiles(agentDir)).toHaveLength(1);
  } finally {
    await first.close();
  }

  const [leasePath] = await findLeaseFiles(agentDir);
  const shortHost = hostname().split(".")[0];
  const variantHost = hostname().includes(".") ? shortHost : `${shortHost}.lan`;
  const stalePid = await deadPid();
  await writeFile(
    leasePath,
    `${JSON.stringify({
      pid: stalePid,
      hostname: variantHost,
      startedAt: new Date().toISOString(),
      surface: "pi-gui",
      token: "previous-launch",
    })}\n`,
  );

  const second = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    agentDir,
    testMode: "background",
  });
  try {
    const window = await second.firstWindow();
    await selectSession(window, title);
    await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect.poll(() => leaseHolderPid(leasePath)).toBe(second.electronApp.process().pid);
  } finally {
    await second.close();
  }
});

/**
 * Two pi-gui processes (separate user-data dirs, so the single-instance lock
 * does not stop the second) share one pi agent dir. The first holds a thread
 * open; the second must refuse to open it until the first quits.
 */
test("a second pi-gui process cannot open a thread the first one holds", async () => {
  test.setTimeout(120_000);
  const agentDir = await makeUserDataDir("pi-gui-shared-agent-");
  const workspacePath = await makeWorkspace("lease-workspace");
  const title = "Shared lease thread";

  const first = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    agentDir,
    testMode: "background",
  });
  let second: DesktopHarness | undefined;
  try {
    const firstWindow = await first.firstWindow();
    await createSessionViaIpc(firstWindow, workspacePath, title);
    await expect.poll(() => findLeaseFiles(agentDir)).toHaveLength(1);

    second = await launchDesktop(await makeUserDataDir(), {
      initialWorkspaces: [workspacePath],
      agentDir,
      testMode: "background",
    });
    const secondWindow = await second.firstWindow();
    const secondRow = secondWindow.locator(".session-row__select", { hasText: title });
    await expect(secondRow).toBeVisible({ timeout: 20_000 });
    await secondRow.click();
    await expect(secondWindow.getByTestId("composer-error-banner")).toContainText(
      "This session is currently open in another pi instance",
    );

    const [leasePath] = await findLeaseFiles(agentDir);
    const firstPid = first.electronApp.process().pid;
    expect(await leaseHolderPid(leasePath)).toBe(firstPid);

    // Once the holder quits its lease is dead, so the thread opens here and
    // this process takes the lease over.
    await first.close();
    await selectSession(secondWindow, title);
    await expect(secondWindow.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect.poll(() => leaseHolderPid(leasePath)).toBe(second.electronApp.process().pid);
  } finally {
    await second?.close();
    await first.close().catch(() => {});
  }
});
