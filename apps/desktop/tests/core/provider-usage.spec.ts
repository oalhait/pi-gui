import { expect, test } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("shows provider quotas, reset times and refreshed values in Settings", async ({}, testInfo) => {
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("provider-usage")],
    testMode: "background",
  });
  try {
    const page = await app.firstWindow();
    await createNamedThread(page, "Usage settings");
    await app.electronApp.evaluate(({ ipcMain }, channel) => {
      let calls = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => [
        {
          providerId: "openai",
          status: "available",
          plan: "pro",
          checkedAt: "2026-10-31T22:00:00Z",
          windows: [
            {
              label: "5-hour",
              usedPercent: ++calls === 1 ? 76 : 25,
              resetsAt: "2026-11-01T01:00:00Z",
            },
            { label: "Weekly", usedPercent: 0 },
          ],
        },
      ]);
    }, desktopIpc.providerUsage);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    const usage = page.getByTestId("provider-usage");
    await expect(usage).toContainText("76% used · 24% remaining");
    await expect(usage).toContainText("0% used · 100% remaining");
    await expect(usage).toContainText("Resets");
    await expect(usage).toContainText("Last checked");
    await expect(usage.getByRole("progressbar").first()).toHaveAttribute("value", "76");
    await page.getByRole("button", { name: "Refresh usage", exact: true }).click();
    await expect(usage).toContainText("25% used · 75% remaining");
    await usage.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("provider-usage.png") });
  } finally {
    await app.close();
  }
});

test("distinguishes unavailable account limits from zero usage", async () => {
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("provider-usage-unavailable")],
    testMode: "background",
  });
  try {
    const page = await app.firstWindow();
    await createNamedThread(page, "Unavailable usage");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    const usage = page.getByTestId("provider-usage");
    await expect(usage).toContainText("This connection does not report account usage limits");
    await expect(usage.getByRole("progressbar")).toHaveCount(0);
    await expect(usage).not.toContainText("0% used");
  } finally {
    await app.close();
  }
});
