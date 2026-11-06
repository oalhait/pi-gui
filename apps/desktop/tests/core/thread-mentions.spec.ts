import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
  type ScriptedReply,
} from "../helpers/scripted-openai-server";

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

/** Reads the thread the message mentions, using only the id the message carries. */
function readMentionedThread(request: ScriptedChatRequest): ScriptedReply {
  if (!request.toolNames.includes("read_thread")) return { text: "Asking thread" };
  const last = request.messages[request.messages.length - 1];
  if (last?.role === "tool") {
    return { text: /Unknown thread/.test(last.content) ? "Read failed." : "Read it." };
  }
  const threadId = /thread_id "([^"]+)"/.exec(last?.content ?? "")?.[1];
  return threadId ? { tool: "read_thread", args: { thread_id: threadId } } : { text: "No id." };
}

test("an @-mentioned thread reaches the model as an id its thread tools resolve", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("thread-mentions");
  const server = await startScriptedOpenAiServer(readMentionedThread);
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
    await createNamedThread(window, "Using GitButler for commits");
    const mentioned = await selectedSessionRef(window);
    await createNamedThread(window, "Asking thread");

    const composer = window.getByTestId("composer");
    const mentionMenu = window.getByTestId("mention-menu");
    await test.step("@ lists other threads, not the current one", async () => {
      await composer.pressSequentially("@");
      // Threads come first: on a bare @ they would otherwise sit below every extension.
      await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText(
        "Threads",
      );
      const threads = mentionMenu.getByTestId("mention-menu-thread");
      await expect(threads).toHaveText(["Using GitButler for commits"]);

      await composer.pressSequentially("gitbutler-com");
      await expect(mentionMenu.locator(".mention-menu__item")).toHaveCount(1);
      await composer.press("Tab");
      await expect(mentionMenu).toHaveCount(0);
      await expect(composer).toHaveValue("@Using-GitButler-for-commits ");
    });

    await test.step("sending carries the thread id, which read_thread resolves", async () => {
      await composer.pressSequentially("what did we decide?");
      await composer.press("Enter");
      const transcript = window.getByTestId("transcript");
      await expect(transcript).toContainText("Read it.");

      const sent = server.requests
        .flatMap((request) => request.messages)
        .find((message) => message.role === "user" && message.content.includes("@Using"));
      expect(sent?.content).toContain(
        `thread_id "${mentioned.workspaceId}:${mentioned.sessionId}", workspace, idle, updated just now`,
      );

      // The transcript shows what the user typed, not the reference block.
      const bubble = window.locator(".timeline-item--user .timeline-item__bubble");
      await expect(bubble).toHaveText("@Using-GitButler-for-commits what did we decide?");
      await expect(transcript).not.toContainText("thread-references");
    });

    await test.step("editing the message brings back only the typed text", async () => {
      await expect
        .poll(async () => {
          const state = await getDesktopState(window);
          return state.workspaces
            .flatMap((workspace) => workspace.sessions)
            .find((session) => session.id === state.selectedSessionId)?.status;
        })
        .toBe("idle");
      await waitForTimelineLayout(window);
      const message = window.locator(".timeline-item--user");
      await message.hover();
      await message.getByRole("button", { name: "Edit message", exact: true }).click();
      await expect(composer).toHaveValue("@Using-GitButler-for-commits what did we decide?");
    });
  } finally {
    await harness.close();
    await server.close();
  }
});
