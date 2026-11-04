import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
} from "../helpers/scripted-openai-server";

function answer(request: ScriptedChatRequest) {
  if (request.toolNames.length === 0) return { text: "Thread title" };
  return { text: "Got it." };
}

function sentPrompts(requests: readonly ScriptedChatRequest[]): string[] {
  return requests
    .filter((request) => request.toolNames.length > 0)
    .map((request) => request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
}

async function waitForIdle(window: Page) {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === state.selectedSessionId)?.status;
    })
    .toBe("idle");
}

async function clear(composer: Locator) {
  await composer.fill("");
  await expect(composer).toHaveValue("");
}

test("the composer continues, nests and exits Markdown lists without sending early", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("composer-lists");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
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
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Lists thread");
    const composer = window.getByTestId("composer");
    const userRows = window.locator(".timeline-item--user");
    // The reply lands after the request is recorded, unlike a status that starts idle.
    const replies = window.locator(".timeline-item--assistant", { hasText: "Got it." });
    await composer.click();

    await test.step("Tab outside a list keeps moving focus", async () => {
      await composer.pressSequentially("plain text");
      await composer.press("Tab");
      await expect(composer).not.toBeFocused();
      await expect(composer).toHaveValue("plain text");
      await composer.click();
      await clear(composer);
    });

    await test.step("a mixed nested list is typed without sending", async () => {
      await composer.pressSequentially("1. First");
      await composer.press("Enter");
      await expect(composer).toHaveValue("1. First\n2. ");
      await composer.press("Tab");
      await expect(composer).toHaveValue("1. First\n   1. ");
      await expect(composer).toBeFocused();
      await composer.press("Backspace");
      await expect(composer).toHaveValue("1. First\n   ");
      await composer.pressSequentially("- [ ] sub task");
      await composer.press("Enter");
      await composer.pressSequentially("second sub");
      await composer.press("Enter");
      await expect(composer).toHaveValue(
        "1. First\n   - [ ] sub task\n   - [ ] second sub\n   - [ ] ",
      );
      // The empty nested item outdents into the parent list...
      await composer.press("Enter");
      await expect(composer).toHaveValue("1. First\n   - [ ] sub task\n   - [ ] second sub\n2. ");
      await composer.pressSequentially("Second 👍🏽");
      await composer.press("Enter");
      // ...and the empty top-level item leaves the list, after a blank separator line.
      await composer.press("Enter");
      await composer.pressSequentially("Thanks");
      await expect(composer).toHaveValue(
        "1. First\n   - [ ] sub task\n   - [ ] second sub\n2. Second 👍🏽\n\nThanks",
      );
      expect(sentPrompts(server.requests)).toEqual([]);
      await expect(userRows).toHaveCount(0);
    });

    await test.step("Enter outside the list sends the exact text", async () => {
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
      await expect(userRows).toHaveCount(1);
      await expect(replies).toHaveCount(1);
      await waitForIdle(window);
      expect(sentPrompts(server.requests)).toEqual([
        "1. First\n   - [ ] sub task\n   - [ ] second sub\n2. Second 👍🏽\n\nThanks",
      ]);
    });

    await test.step("one undo reverts one list action", async () => {
      await composer.pressSequentially("- a");
      await composer.press("Enter");
      await expect(composer).toHaveValue("- a\n- ");
      await composer.press(desktopShortcut("Z"));
      await expect(composer).toHaveValue("- a");
      await clear(composer);
    });

    await test.step("Cmd/Ctrl+Enter sends from inside a list", async () => {
      await composer.pressSequentially("- one");
      await composer.press("Enter");
      await composer.pressSequentially("two");
      await composer.press(desktopShortcut("Enter"));
      await expect(composer).toHaveValue("");
      await expect(userRows).toHaveCount(2);
      await expect(replies).toHaveCount(2);
      await waitForIdle(window);
      expect(sentPrompts(server.requests).at(-1)).toBe("- one\n- two");
    });

    await test.step("the mention menu owns Enter inside a list item", async () => {
      await composer.pressSequentially("- see @README");
      const mentionMenu = window.getByTestId("mention-menu");
      await expect(mentionMenu.locator(".mention-menu__item")).toHaveCount(1);
      await expect(mentionMenu.locator(".mention-menu__filename")).toContainText("README.md");
      await composer.press("Enter");
      await expect(mentionMenu).toHaveCount(0);
      await expect(composer).toHaveValue("- see @README.md ");
      await composer.press("Enter");
      await expect(composer).toHaveValue("- see @README.md\n- ");
      await clear(composer);
    });

    await test.step("the slash menu still completes commands", async () => {
      await composer.pressSequentially("/stat");
      const slashMenu = window.getByTestId("slash-menu");
      await expect(slashMenu).toBeVisible();
      await composer.press("Tab");
      await expect(slashMenu).toHaveCount(0);
      await expect(composer).toHaveValue("/status");
      await clear(composer);
    });

    await test.step("the new-thread composer continues lists too", async () => {
      await openNewThread(window);
      const newThreadComposer = window.getByTestId("new-thread-composer");
      await newThreadComposer.pressSequentially("- draft");
      await newThreadComposer.press("Enter");
      await expect(newThreadComposer).toHaveValue("- draft\n- ");
      await expect(newThreadComposer).toBeVisible();
    });

    expect(sentPrompts(server.requests)).toHaveLength(2);
  } finally {
    await harness.close();
    await server.close();
  }
});
