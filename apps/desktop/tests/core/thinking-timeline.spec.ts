import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
  type ScriptedReply,
} from "../helpers/scripted-openai-server";

const screenshotDir = process.env.PI_APP_THINKING_SCREENSHOTS;

async function capture(window: Page, name: string) {
  if (!screenshotDir) return;
  // Evidence only: let the chevron's rotation finish before the shot.
  await window.waitForTimeout(400);
  await window.screenshot({ path: join(screenshotDir, `${name}.png`) });
}

async function setShowThinking(window: Page, choice: "Expanded" | "Collapsed" | "Hidden") {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "General", exact: true }).click();
  const group = window.getByRole("group", { name: "Show thinking" });
  await group.getByRole("button", { name: choice, exact: true }).click();
  await expect(group.getByRole("button", { name: choice, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await window.getByRole("button", { name: "Back to app" }).click();
  await expect(window.getByTestId("settings-surface")).toHaveCount(0);
}

test("reasoning streams as a Thinking row, collapses to Thought for, expands, survives restart and can be hidden", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("thinking-timeline");
  let release!: () => void;
  const thinkingHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = await startScriptedOpenAiServer((request: ScriptedChatRequest): ScriptedReply => {
    if (request.toolNames.length === 0) return { text: "Thread title" };
    return {
      thinking: ["Let me work ", "this out.\n\n", "Step two: check the edge case."],
      holdAfterThinking: thinkingHeld,
      text: "The final answer.",
    };
  });
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
          models: [{ id: "scripted", reasoning: true }],
        },
      },
    }),
  );
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  let harness = await launch();
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Other thread");
    await createNamedThread(window, "Thinking thread");
    const transcript = window.getByTestId("transcript");
    const thinking = transcript.getByTestId("timeline-thinking");
    const answer = transcript.locator(".timeline-item--assistant", {
      hasText: "The final answer.",
    });

    const composer = window.getByTestId("composer");
    await composer.fill("Question");
    await composer.press("Enter");

    await test.step("streams live while the model thinks", async () => {
      await expect(thinking).toHaveAttribute("data-state", "streaming");
      await expect(thinking).toContainText("Thinking…");
      await expect(thinking).toContainText("Step two: check the edge case.");
      await expect(answer).toHaveCount(0);
      // Following the newest output: the streaming row never pushes the view off the bottom.
      await expect(window.getByTestId("timeline-jump")).toHaveCount(0);
      await capture(window, "1-thinking-streaming");
    });

    await test.step("collapses to one Thought for line once the answer starts", async () => {
      release();
      await expect(answer).toHaveCount(1);
      await expect(thinking).toHaveAttribute("data-state", "done");
      const header = thinking.getByRole("button", { name: /^Thought for \d+s$/ });
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(thinking).not.toContainText("Step two");
      // The answer row carries none of the reasoning.
      await expect(answer).not.toContainText("Let me work");
      await capture(window, "2-thought-collapsed");
    });

    await test.step("expands by click and by keyboard, and copies the reasoning", async () => {
      await waitForTimelineLayout(window);
      const header = thinking.getByRole("button", { name: /^Thought for \d+s$/ });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await expect(thinking).toContainText("Step two: check the edge case.");
      await capture(window, "3-thought-expanded");
      await thinking.getByRole("button", { name: "Copy thinking" }).click();
      await expect
        .poll(() => harness.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe("Let me work this out.\n\nStep two: check the edge case.");
      await header.focus();
      await window.keyboard.press("Enter");
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await window.keyboard.press("Space");
      await expect(header).toHaveAttribute("aria-expanded", "true");
    });

    await test.step("survives a thread switch", async () => {
      await selectSession(window, "Other thread");
      await selectSession(window, "Thinking thread");
      await expect(thinking).toHaveCount(1);
      await expect(thinking).toHaveAttribute("data-state", "done");
    });

    await test.step("Hidden leaves reasoning out of the timeline", async () => {
      await setShowThinking(window, "Hidden");
      await expect(answer).toHaveCount(1);
      await expect(thinking).toHaveCount(0);
      await capture(window, "4-hidden");
    });

    await setShowThinking(window, "Expanded");
    await expect(thinking).toContainText("Step two: check the edge case.");

    const session = (await getDesktopState(window)).selectedSessionId;
    expect(session).toBeTruthy();
  } finally {
    release();
    await harness.close();
  }

  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Thinking thread");
    const thinking = window.getByTestId("transcript").getByTestId("timeline-thinking");
    await test.step("the reloaded reasoning keeps the saved Expanded setting", async () => {
      await expect(thinking).toHaveCount(1);
      await expect(thinking).toHaveAttribute("data-state", "done");
      await expect(thinking).toContainText("Step two: check the edge case.");
      // The duration measured while it streamed was saved with the session.
      await expect(thinking.getByRole("button", { name: /^Thought for \d+s$/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await capture(window, "5-reloaded-expanded");
    });
    await setShowThinking(window, "Collapsed");
    await expect(thinking.getByRole("button", { name: /^Thought/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(thinking).not.toContainText("Step two");
  } finally {
    await harness.close();
    await server.close();
  }
});
