import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("a moved project thread remembers its history and runs tools in its new folder", async () => {
  test.setTimeout(300_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir();
  const fromPath = await makeWorkspace("live-move-from");
  const toPath = await makeWorkspace("live-move-to");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [fromPath, toPath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });
  try {
    const window = await harness.firstWindow();
    const from = await waitForWorkspaceByPath(window, fromPath);
    const to = await waitForWorkspaceByPath(window, toPath);
    await startThreadFromSurface(window, {
      workspaceName: from.name,
      prompt: "Remember the code word TANGERINE-42. Reply only with OK.",
    });
    const sessionId = (await getDesktopState(window)).selectedSessionId;
    const status = async () =>
      (await getDesktopState(window)).workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === sessionId)?.status;
    await expect.poll(status, { timeout: 120_000 }).toBe("idle");

    const row = window.locator(`.session-row[data-session-id="${sessionId}"]`);
    await row.click({ button: "right" });
    await row.getByRole("button", { name: "Move to…", exact: true }).click();
    const dialog = window.getByTestId("move-thread-dialog");
    await dialog.getByLabel(to.name, { exact: true }).check();
    await dialog.getByTestId("move-thread-confirm").click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await getDesktopState(window)).selectedWorkspaceId).toBe(to.id);

    await window
      .getByTestId("composer")
      .fill("Use your bash tool to run `pwd`, then reply with the code word and the directory.");
    await window.getByTestId("composer").press("Enter");
    await expect.poll(status, { timeout: 150_000 }).toBe("running");
    await expect.poll(status, { timeout: 150_000 }).toBe("idle");
    const transcript = (await getSelectedTranscript(window))?.transcript ?? [];
    const reply = transcript
      .filter((item) => item.kind === "message" && item.role === "assistant")
      .map((item) => (item.kind === "message" ? item.text : ""))
      .join("\n");
    expect(reply).toContain("TANGERINE-42");
    expect(reply).toContain("live-move-to");
    await window.screenshot({ path: test.info().outputPath("moved-thread.png") });
  } finally {
    await harness.close();
  }
});
