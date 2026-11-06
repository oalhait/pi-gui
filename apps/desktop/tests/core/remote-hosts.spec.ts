import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
} from "../helpers/scripted-openai-server";

/**
 * Remote hosts through the real UI. The "server" is this computer: PI_GUI_REMOTE_TRANSPORT=local
 * runs the same server-side scripts pi-gui sends over ssh, and the host runs this checkout's
 * pi-gui-host. The scripted model answers both the app and the host.
 */

const run = promisify(execFile);
const hostPackage = resolve(__dirname, "../../../../packages/pi-gui-host");

function answer(request: ScriptedChatRequest) {
  if (request.toolNames.length === 0) return { text: "Remote title" };
  const last = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  return { text: `Remote reply to: ${last}` };
}

async function openRemoteHostsSettings(window: Page): Promise<void> {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Remote hosts", exact: true }).click();
  await expect(window.locator(".view-header__title")).toContainText("Remote hosts");
}

async function selectedSessionStatus(window: Page) {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

test("a remote host connects, runs a thread on the server and survives a dropped connection", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const remoteProject = await makeWorkspace("remote-project");
  const hostHome = join(await mkdtemp(join(tmpdir(), "pi-gui-host-")), "host");
  await mkdir(hostHome, { recursive: true });
  // A linked checkout counts as installed; an empty bundle directory means nothing to upload.
  await symlink(hostPackage, join(hostHome, "current"));
  const noBundle = await mkdtemp(join(tmpdir(), "pi-gui-no-bundle-"));

  const server = await startScriptedOpenAiServer(answer);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["scripted-test/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "scripted-test",
      defaultModel: "scripted",
      enabledModels: ["scripted-test/scripted"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "scripted-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "scripted" }],
        },
      },
    }),
  );

  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      scrubProviderEnv: true,
      testMode: "background",
      envOverrides: { PI_GUI_REMOTE_TRANSPORT: "local", PI_GUI_HOST_BUNDLE_DIR: noBundle },
    });
  let harness = await launch();
  try {
    let window = await harness.firstWindow();

    await test.step("add the host from Settings and test the connection", async () => {
      await openRemoteHostsSettings(window);
      await window.getByRole("button", { name: "Add host", exact: true }).last().click();
      const dialog = window.getByTestId("remote-host-dialog");
      await dialog.getByLabel("Name").fill("Box");
      await dialog.getByLabel("SSH destination").fill("localhost");
      await dialog.getByLabel("pi-gui-host folder (optional)").fill(hostHome);
      await dialog.getByRole("button", { name: "Test connection" }).click();
      await expect(dialog.getByTestId("remote-host-test-result")).toContainText(
        "Connected. Node.js v",
      );
      await expect(dialog.getByTestId("remote-host-test-result")).toContainText("installed");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(window.locator('[data-remote-host="box"]')).toHaveAttribute(
        "data-remote-status",
        "connected",
        { timeout: 60_000 },
      );
    });

    await test.step("add a folder on the host", async () => {
      await window
        .locator('[data-remote-host="box"]')
        .getByRole("button", { name: "Add folder" })
        .click();
      const dialog = window.getByTestId("remote-folder-dialog");
      await dialog.getByLabel("Folder path").fill(remoteProject);
      await dialog.getByRole("button", { name: "Add folder" }).click();
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await getDesktopState(window)).workspaces.find(
              (workspace) => workspace.id === `pi-remote://box${remoteProject}`,
            )?.name,
        )
        .toBe("remote-project (Box)");
    });

    await test.step("a thread in the remote folder runs on the host", async () => {
      await window.keyboard.press("Escape");
      await createNamedThread(window, "Remote thread", { workspaceName: "remote-project (Box)" });
      const composer = window.getByTestId("composer");
      await composer.fill("hello from the laptop");
      await composer.press("Enter");
      await expect(
        window.locator(".timeline-item--assistant", {
          hasText: "Remote reply to: hello from the laptop",
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => selectedSessionStatus(window)).toBe("idle");
      // The thread lives in the host's catalog, not the app's.
      expect(await readFile(join(hostHome, "state", "catalogs.json"), "utf8")).toContain(
        "Remote thread",
      );
      // No local folder may mean no local catalog at all.
      const localCatalog = await readFile(join(userDataDir, "catalogs.json"), "utf8").catch(
        () => "",
      );
      expect(localCatalog).not.toContain("Remote thread");
    });

    await test.step("a dropped connection reconnects and the thread keeps working", async () => {
      await run("pkill", ["-f", `proxy --start --home ${hostHome}`]).catch(() => undefined);
      await expect
        .poll(async () =>
          window.evaluate(async () =>
            (await globalThis.window.piApp!.listRemoteHosts()).map((host) => host.status),
          ),
        )
        .not.toEqual(["connected"]);
      await expect
        .poll(
          async () =>
            window.evaluate(async () =>
              (await globalThis.window.piApp!.listRemoteHosts()).map((host) => host.status),
            ),
          { timeout: 30_000 },
        )
        .toEqual(["connected"]);
      const composer = window.getByTestId("composer");
      await composer.fill("after reconnecting");
      await composer.press("Enter");
      await expect(
        window.locator(".timeline-item--assistant", {
          hasText: "Remote reply to: after reconnecting",
        }),
      ).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => selectedSessionStatus(window)).toBe("idle");
    });

    await test.step("after a restart the remote folder and thread come back", async () => {
      await harness.close();
      harness = await launch();
      window = await harness.firstWindow();
      await expect
        .poll(async () =>
          (await getDesktopState(window)).workspaces
            .find((workspace) => workspace.id === `pi-remote://box${remoteProject}`)
            ?.sessions.map((session) => session.title),
        )
        .toContain("Remote thread");
      await window.getByText("Remote thread", { exact: true }).first().click();
      await expect(
        window.locator(".timeline-item--assistant", {
          hasText: "Remote reply to: after reconnecting",
        }),
      ).toBeVisible({ timeout: 60_000 });
    });
  } finally {
    await harness.close();
    await run(process.execPath, [
      join(hostPackage, "dist", "main.js"),
      "daemon",
      "stop",
      "--home",
      hostHome,
    ]).catch(() => undefined);
    await server.close();
  }
});
