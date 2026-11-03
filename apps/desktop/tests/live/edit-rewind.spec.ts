import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeWorkspace,
  selectSession,
  waitForTimelineLayout,
} from "../helpers/electron-app";

const provider = process.env.PI_GUI_PROVIDER ?? "anthropic";
const model = process.env.PI_GUI_MODEL ?? "claude-haiku-5-5";

async function sendAndWait(page: Page, text: string, marker: string) {
  const composer = page.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator(".timeline-item--assistant .message__content").last()).toContainText(
    marker,
    { timeout: 150_000 },
  );
  await expect
    .poll(
      async () => {
        const state = await getDesktopState(page);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.status;
      },
      { timeout: 150_000 },
    )
    .toBe("idle");
}

async function editMessage(page: Page, text: string) {
  await waitForTimelineLayout(page);
  const message = page.getByTestId("transcript").locator(".timeline-item--user", { hasText: text });
  await message.hover();
  await message.getByRole("button", { name: "Edit message", exact: true }).click();
}

test("edits an earlier message against a real provider and keeps the branch across restart", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);
  const auth = JSON.parse(await readFile(join(realAuth.sourceDir!, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (!auth[provider]) throw new Error(`No saved credentials for ${provider}`);
  // Copy only the chosen provider's credentials into a private profile outside test output.
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-gui-edit-rewind-private-"));
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
  const workspace = await makeWorkspace("live-edit-rewind");
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
    });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const userTexts = (page: Page) =>
    page.locator(".timeline-item--user .timeline-item__bubble").allInnerTexts();

  let harness = await launch();
  let title = "";
  try {
    const page = await harness.firstWindow();
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
    await sendAndWait(page, "Reply with exactly BRAVO-TWO.", "BRAVO-TWO");
    await sendAndWait(page, "Reply with exactly CHARLIE-THREE.", "CHARLIE-THREE");
    await shot(page, "1-before-edit");

    await editMessage(page, "BRAVO-TWO");
    await expect(page.getByTestId("composer")).toHaveValue("Reply with exactly BRAVO-TWO.");
    await expect(page.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect.poll(() => userTexts(page)).toEqual(["Reply with exactly ALPHA-ONE."]);
    await shot(page, "2-after-edit-click");

    await sendAndWait(page, "Reply with exactly BRAVO-EDITED.", "BRAVO-EDITED");
    await expect(page.getByTestId("composer-error-banner")).toHaveCount(0);
    expect(await userTexts(page)).toEqual([
      "Reply with exactly ALPHA-ONE.",
      "Reply with exactly BRAVO-EDITED.",
    ]);
    await expect(page.getByTestId("transcript")).not.toContainText("CHARLIE-THREE");
    await shot(page, "3-after-rerun");

    const state = await getDesktopState(page);
    title =
      state.workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === state.selectedSessionId)?.title ?? "";
  } finally {
    await harness.close();
  }

  harness = await launch();
  try {
    const page = await harness.firstWindow();
    await selectSession(page, title);
    await expect
      .poll(() => userTexts(page))
      .toEqual(["Reply with exactly ALPHA-ONE.", "Reply with exactly BRAVO-EDITED."]);
    await expect(page.getByTestId("transcript")).toContainText("BRAVO-EDITED");
    await expect(page.getByTestId("transcript")).not.toContainText("CHARLIE-THREE");
    await shot(page, "4-after-restart");
  } finally {
    await harness.close();
  }
});
