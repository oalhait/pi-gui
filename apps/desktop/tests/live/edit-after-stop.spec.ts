import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeWorkspace,
  waitForTimelineLayout,
} from "../helpers/electron-app";

const provider = process.env.PI_GUI_PROVIDER ?? "anthropic";
const model = process.env.PI_GUI_MODEL ?? "claude-haiku-5-5";

async function status(page: Page) {
  const state = await getDesktopState(page);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

async function editMessage(page: Page, text: string) {
  await waitForTimelineLayout(page);
  const message = page
    .getByTestId("transcript")
    .locator(".timeline-item--user", { hasText: text })
    .last();
  await message.hover();
  await message.getByRole("button", { name: "Edit message", exact: true }).click();
}

test("a question stopped while waiting for a real model can be edited straight away", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);
  const auth = JSON.parse(await readFile(join(realAuth.sourceDir!, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (!auth[provider]) throw new Error(`No saved credentials for ${provider}`);
  // Copy only the chosen provider's credentials into a private profile outside test output.
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-gui-edit-after-stop-private-"));
  await chmod(privateRoot, 0o700);
  const profile = join(privateRoot, "profile");
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
      defaultThinkingLevel: "off",
      enabledModels: [`${provider}/${model}`],
    }),
  );
  const workspace = await makeWorkspace("live-edit-after-stop");
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const userTexts = (page: Page) =>
    page.locator(".timeline-item--user .timeline-item__bubble").allInnerTexts();

  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
  });
  try {
    const page = await harness.firstWindow();
    const composer = page.getByTestId("composer");
    const errorBanner = page.getByTestId("composer-error-banner");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await page.getByTestId("new-thread-composer").fill("Reply with exactly ALPHA-ONE.");
    await page.getByRole("button", { name: "Start thread" }).click();
    await expect(page.locator(".timeline-item--assistant .message__content").last()).toContainText(
      "ALPHA-ONE",
      { timeout: 150_000 },
    );
    await expect.poll(() => status(page), { timeout: 150_000 }).toBe("idle");

    // Stop the next question while the line still says it waits for the model.
    await composer.fill("Write a 600-word essay about lighthouses, then say BRAVO-TWO.");
    await composer.press("Enter");
    await expect(page.getByTestId("timeline-model-wait")).toContainText("Waiting for the model");
    await shot(page, "1-waiting-for-model");
    await page.getByTestId("send").click();
    await expect.poll(() => status(page)).toBe("idle");
    // Straight away, as someone frustrated by a stuck run would.
    await editMessage(page, "lighthouses");
    await expect(composer).toHaveValue(
      "Write a 600-word essay about lighthouses, then say BRAVO-TWO.",
    );
    await expect(errorBanner).toHaveCount(0);
    await expect.poll(() => userTexts(page)).toEqual(["Reply with exactly ALPHA-ONE."]);
    await shot(page, "2-edited-stopped-question");

    await composer.fill("Reply with exactly BRAVO-EDITED.");
    await composer.press("Enter");
    await expect(page.locator(".timeline-item--assistant .message__content").last()).toContainText(
      "BRAVO-EDITED",
      { timeout: 150_000 },
    );
    await expect.poll(() => status(page), { timeout: 150_000 }).toBe("idle");
    await expect(page.getByTestId("timeline-model-wait")).toHaveCount(0);
    expect(await userTexts(page)).toEqual([
      "Reply with exactly ALPHA-ONE.",
      "Reply with exactly BRAVO-EDITED.",
    ]);
    await shot(page, "3-after-rerun");
  } finally {
    await harness.close();
  }
});
