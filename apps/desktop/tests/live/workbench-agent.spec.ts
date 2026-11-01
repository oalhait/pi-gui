import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("a real agent uses workbench to open a local preview in the native browser", async () => {
  test.setTimeout(180_000);
  const authConfig = getRealAuthConfig();
  test.skip(!authConfig.enabled, authConfig.skipReason);
  const provider = process.env.PI_GUI_PROVIDER ?? "openai-codex";
  const model = process.env.PI_GUI_MODEL ?? "gpt-6.1-sol";
  const auth = JSON.parse(
    await readFile(join(authConfig.sourceDir!, "auth.json"), "utf8"),
  ) as Record<string, unknown>;
  if (!auth[provider]) throw new Error(`Missing saved authentication for ${provider}`);
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-workbench-private-"));
  await chmod(privateRoot, 0o700);
  const agentDir = join(privateRoot, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${model}`],
    }),
  );
  const server = createServer((_request, response) =>
    response.end("<title>Agent opened preview</title><h1>Workbench tool proof</h1>"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing preview port");
  const url = `http://127.0.0.1:${port.port}/`;
  const launch =
    process.env.PI_GUI_WORKBENCH_PACKAGED === "1" ? launchPackagedDesktop : launchDesktop;
  const harness = await launch(await makeUserDataDir(), {
    agentDir,
    initialWorkspaces: [await makeWorkspace("live-workbench")],
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const window = await harness.firstWindow();
    expect(
      await harness.electronApp.evaluate(() =>
        Boolean((globalThis as Record<string, unknown>).__PI_APP_TEST_HOOKS),
      ),
    ).toBe(false);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window
      .getByLabel("New thread prompt", { exact: true })
      .fill(
        `Use the workbench tool now to open ${url} in pi-gui's side pane browser. Do not use bash, external browsers, or desktop automation. After the tool succeeds, reply only WORKBENCH_READY.`,
      );
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(url, {
      timeout: 150_000,
    });
    await expect(
      window.getByRole("tab", { name: "Agent opened preview", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(async ({ webContents, BrowserWindow }, url) => {
          const page = webContents.getAllWebContents().find((page) => page.getURL() === url);
          if (!page) return false;
          const text: unknown = await page.executeJavaScript("document.body.innerText");
          return (
            typeof text === "string" &&
            text.includes("Workbench tool proof") &&
            BrowserWindow.getAllWindows().some((window) =>
              window.contentView.children.some(
                (view) => "webContents" in view && view.webContents === page && view.getVisible(),
              ),
            )
          );
        }, url),
      )
      .toBe(true);

    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("WORKBENCH_READY", { timeout: 150_000 });
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.status;
      })
      .toBe("idle");
    await window.screenshot({ path: test.info().outputPath("real-agent-browser.png") });
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
