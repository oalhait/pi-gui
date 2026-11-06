import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
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
} from "../helpers/scripted-openai-server";

/** Title requests carry no tools; every agent turn answers the latest user message. */
function answer(request: ScriptedChatRequest) {
  if (request.toolNames.length === 0) return { text: "Thread title" };
  const ask = [...request.messages].reverse().find((message) => message.role === "user");
  return { text: `Answer to ${ask?.content ?? "nothing"}` };
}

async function selectedSessionRef(window: Page) {
  const state = await getDesktopState(window);
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

async function sessionStatus(window: Page) {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(
    window.locator(".timeline-item--assistant", { hasText: `Answer to ${text}` }),
  ).toHaveCount(1);
  await expect.poll(() => sessionStatus(window)).toBe("idle");
}

async function editMessage(window: Page, text: string) {
  await waitForTimelineLayout(window);
  const message = window
    .getByTestId("transcript")
    .locator(".timeline-item--user", { hasText: text });
  await message.hover();
  await message.getByRole("button", { name: "Edit message", exact: true }).click();
}

async function userTexts(window: Page) {
  return window.locator(".timeline-item--user .timeline-item__bubble").allInnerTexts();
}

async function supersededUserTexts(window: Page) {
  return window
    .locator(".timeline__virtual-row--superseded .timeline-item--user .timeline-item__bubble")
    .allInnerTexts();
}

/** The live session's leaf, as pi's tree reports it. */
async function leafId(window: Page) {
  const target = await selectedSessionRef(window);
  return window.evaluate(
    async (sessionTarget) => (await globalThis.window.piApp!.getSessionTree(sessionTarget)).leafId,
    target,
  );
}

async function findSessionFile(agentDir: string, sessionId: string): Promise<string> {
  const root = join(agentDir, "sessions");
  for (const folder of await readdir(root)) {
    for (const file of await readdir(join(root, folder))) {
      if (file.endsWith(`_${sessionId}.jsonl`)) return join(root, folder, file);
    }
  }
  throw new Error(`No session file for ${sessionId}`);
}

test("cancelling a message edit leaves the thread and the earlier draft as they were", async () => {
  test.setTimeout(240_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("message-edit-cancel");
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
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  const allTexts = ["First question", "Second question", "Third question"];
  const draft = "A draft I have not sent";
  let harness = await launch();
  let sessionFile = "";
  let leafBefore: string | null = null;
  let fileBefore = "";
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Other thread");
    await createNamedThread(window, "Edit thread");
    const composer = window.getByTestId("composer");
    const editBar = window.getByTestId("composer-message-edit");
    const errorBanner = window.getByTestId("composer-error-banner");
    for (const text of allTexts) await send(window, text);
    sessionFile = await findSessionFile(agentDir, (await selectedSessionRef(window)).sessionId);

    const unchanged = async () => {
      await expect(editBar).toHaveCount(0);
      await expect(composer).toHaveValue(draft);
      await expect.poll(() => supersededUserTexts(window)).toEqual([]);
      expect(await userTexts(window)).toEqual(allTexts);
      expect(await leafId(window)).toBe(leafBefore);
      expect(await readFile(sessionFile, "utf8")).toBe(fileBefore);
    };

    await composer.fill(draft);
    leafBefore = await leafId(window);
    fileBefore = await readFile(sessionFile, "utf8");
    expect(leafBefore).toBeTruthy();

    await test.step("Edit marks the turns it would replace and changes nothing", async () => {
      await editMessage(window, "Second question");
      await expect(editBar).toContainText("Editing an earlier message");
      await expect(composer).toHaveValue("Second question");
      await expect(composer).toBeFocused();
      await expect
        .poll(() => supersededUserTexts(window))
        .toEqual(["Second question", "Third question"]);
      expect(await userTexts(window)).toEqual(allTexts);
      expect(await leafId(window)).toBe(leafBefore);
    });

    await test.step("Cancel puts the draft back", async () => {
      await composer.fill("Second question, half edited");
      await editBar.getByRole("button", { name: "Cancel", exact: true }).click();
      await unchanged();
    });

    await test.step("Esc does the same", async () => {
      await editMessage(window, "First question");
      await expect(composer).toHaveValue("First question");
      await expect.poll(() => supersededUserTexts(window)).toEqual(allTexts);
      await composer.press("Escape");
      await unchanged();
    });

    await test.step("lists and @-mentions work while editing; Esc closes the menu first", async () => {
      await editMessage(window, "First question");
      await expect(composer).toHaveValue("First question");
      await composer.fill("");
      await composer.pressSequentially("- one");
      await composer.press("Enter");
      await expect(composer).toHaveValue("- one\n- ");
      await expect(editBar).toBeVisible();
      expect(await userTexts(window)).toEqual(allTexts);
      await composer.pressSequentially("@");
      const mentionMenu = window.getByTestId("mention-menu");
      await expect(mentionMenu.getByTestId("mention-menu-thread")).toHaveText(["Other thread"]);
      await composer.press("Escape");
      await expect(mentionMenu).toHaveCount(0);
      await expect(editBar).toBeVisible();
      await composer.press("Escape");
      await unchanged();
    });

    await test.step("a draft typed just before Edit, not yet saved, comes back", async () => {
      await composer.fill("Typed a moment ago");
      await editMessage(window, "Third question");
      await expect(composer).toHaveValue("Third question");
      await composer.press("Escape");
      await expect(composer).toHaveValue("Typed a moment ago");
      await composer.fill(draft);
      await unchanged();
    });

    await test.step("the edit survives a thread switch, then cancels", async () => {
      await editMessage(window, "Third question");
      await expect(composer).toHaveValue("Third question");
      await composer.fill("Third question, edited elsewhere");
      await selectSession(window, "Other thread");
      await expect(editBar).toHaveCount(0);
      await expect(composer).toHaveValue("");
      await selectSession(window, "Edit thread");
      await expect(editBar).toBeVisible();
      await expect(composer).toHaveValue("Third question, edited elsewhere");
      await expect.poll(() => supersededUserTexts(window)).toEqual(["Third question"]);
      await composer.press("Escape");
      await unchanged();
    });

    await test.step("a run that starts mid-edit cancels the edit with a notice", async () => {
      await editMessage(window, "Second question");
      await expect(editBar).toBeVisible();
      const ref = await selectedSessionRef(window);
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === ref.workspaceId)!;
      const runUpdate = (status: "running" | "idle"): SessionDriverEvent => {
        const now = new Date().toISOString();
        return {
          type: "sessionUpdated",
          sessionRef: ref,
          timestamp: now,
          ...(status === "running" ? { runId: "injected-run" } : {}),
          snapshot: {
            ref,
            workspace: { workspaceId: workspace.id, path: workspace.path },
            title: "Edit thread",
            status,
            updatedAt: now,
            ...(status === "running" ? { runningRunId: "injected-run" } : {}),
          },
        };
      };
      await emitTestSessionEvent(harness, runUpdate("running"));
      await expect(editBar).toHaveCount(0);
      await expect(composer).toHaveValue(draft);
      await expect(window.getByText("your message edit was cancelled")).toBeVisible();
      await emitTestSessionEvent(harness, runUpdate("idle"));
      await expect.poll(() => sessionStatus(window)).toBe("idle");
      expect(await leafId(window)).toBe(leafBefore);
    });

    await test.step("an app restart mid-edit comes back to the draft", async () => {
      await editMessage(window, "Second question");
      await composer.fill("Second question, never sent");
      await expect(errorBanner).toHaveCount(0);
    });
  } finally {
    await harness.close();
  }

  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Edit thread");
    await expect.poll(() => userTexts(window)).toEqual(allTexts);
    await expect(window.getByTestId("composer-message-edit")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toHaveValue(draft);
    expect(await leafId(window)).toBe(leafBefore);
    expect(await readFile(sessionFile, "utf8")).toBe(fileBefore);

    await test.step("sending an edit starts a sibling branch; the old one stays in /tree", async () => {
      const composer = window.getByTestId("composer");
      await editMessage(window, "Second question");
      await expect(composer).toHaveValue("Second question");
      await send(window, "Second question, edited");
      expect(await userTexts(window)).toEqual(["First question", "Second question, edited"]);
      await expect(window.getByTestId("composer-message-edit")).toHaveCount(0);
      await composer.fill("/tree");
      await composer.press("Enter");
      const tree = window.getByTestId("tree-modal");
      await expect(tree).toContainText("Third question");
      await expect(tree).toContainText("Second question, edited");
      await window.getByRole("button", { name: "Close tree modal" }).click();
    });

    await test.step("an @-mention added while editing reaches the model as a thread id", async () => {
      const composer = window.getByTestId("composer");
      const state = await getDesktopState(window);
      const other = state.workspaces
        .flatMap((workspace) => workspace.sessions.map((session) => ({ workspace, session })))
        .find(({ session }) => session.title === "Other thread")!;
      await editMessage(window, "Second question, edited");
      await expect(composer).toHaveValue("Second question, edited");
      await composer.press("End");
      await composer.pressSequentially(" for @Other");
      await expect(window.getByTestId("mention-menu-thread")).toHaveText(["Other thread"]);
      await composer.press("Tab");
      await expect(composer).toHaveValue("Second question, edited for @Other-thread ");
      const before = server.requests.length;
      await composer.press("Enter");
      await expect(window.getByTestId("composer-message-edit")).toHaveCount(0);
      await expect
        .poll(() => userTexts(window))
        .toEqual(["First question", "Second question, edited for @Other-thread"]);
      await expect
        .poll(
          () =>
            server.requests
              .slice(before)
              .flatMap((request) => request.messages)
              .find((message) => message.role === "user" && message.content.includes("@Other"))
              ?.content,
        )
        .toContain(`thread_id "${other.workspace.id}:${other.session.id}"`);
      await expect.poll(() => sessionStatus(window)).toBe("idle");
    });
  } finally {
    await harness.close();
    await server.close();
  }
});
