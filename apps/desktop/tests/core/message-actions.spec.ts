import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedForkSessionFixture,
  selectSession,
  waitForTimelineLayout,
  writeTinyPng,
} from "../helpers/electron-app";

for (const question of ["First fork question", "Second fork question"]) {
  test(`edits ${question} from its original context while preserving the source chat`, async ({}, testInfo) => {
    const userDataDir = await makeUserDataDir();
    const agentDir = join(userDataDir, "agent");
    const workspacePath = await makeWorkspace("message-actions");
    await seedAgentDir(agentDir);
    const imagePath = join(userDataDir, "prompt.png");
    await writeTinyPng(imagePath);
    const userImage =
      question === "Second fork question"
        ? { data: (await readFile(imagePath)).toString("base64"), mimeType: "image/png" }
        : undefined;
    await seedForkSessionFixture(agentDir, workspacePath, userImage);
    const harness = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    try {
      const window = await harness.firstWindow();
      await selectSession(window, "Fork fixture session");
      await waitForTimelineLayout(window);
      const original = (await getDesktopState(window)).selectedSessionId;
      const transcript = window.getByTestId("transcript");
      const message = transcript.locator(".timeline-item--user", { hasText: question });
      const actions = message.locator(".timeline-item__actions--user");
      await expect(actions).toHaveCSS("opacity", "0");
      await message.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await expect(message.locator("time")).toHaveAttribute("datetime", /.+/);
      await expect(message.locator("time")).toHaveAttribute("title", /.+/);
      await message.getByRole("button", { name: "Copy message", exact: true }).click();
      await expect(message.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
      expect(await harness.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        question,
      );
      await window.screenshot({ path: testInfo.outputPath("message-hover.png") });
      if (!userImage) {
        await window.evaluate(() => {
          navigator.clipboard.writeText = () => Promise.reject(new Error("Clipboard unavailable"));
        });
        await message.getByRole("button", { name: "Copied", exact: true }).click();
        await expect(message.getByRole("status")).toHaveText("Copy failed. Try again");
      }
      await message.getByRole("button", { name: "Edit message", exact: true }).focus();
      await window.mouse.move(0, 0);
      await expect(actions).toHaveCSS("opacity", "1");
      await message.getByRole("button", { name: "Edit message", exact: true }).press("Enter");
      await expect
        .poll(async () => (await getDesktopState(window)).selectedSessionId)
        .not.toBe(original);
      await expect(window.getByTestId("composer")).toHaveValue(question);
      await expect(window.getByTestId("composer")).toBeFocused();
      if (userImage) {
        await expect
          .poll(async () =>
            (await getDesktopState(window)).composerAttachments.map(({ kind }) => kind),
          )
          .toEqual(["image"]);
      }
      const branch = (await getDesktopState(window)).selectedSessionId;
      await expect(transcript).not.toContainText(question);
      await expect(transcript).not.toContainText("Second fork answer");
      await expect(transcript).not.toContainText("Third fork question");
      if (question === "Second fork question") {
        await expect(transcript).toContainText("First fork answer");
      } else {
        await expect(transcript.locator(".timeline-item--user")).toHaveCount(0);
      }
      await window.getByTestId("composer").fill("Edited question");
      await window.locator(`[data-session-id="${original}"] .session-row__select`).click();
      await expect(transcript).toContainText("Third fork answer");
      await expect(transcript).toContainText(question);
      await window.locator(`[data-session-id="${branch}"] .session-row__select`).click();
      await expect(window.getByTestId("composer")).toHaveValue("Edited question");
    } finally {
      await harness.close();
    }
  });
}
