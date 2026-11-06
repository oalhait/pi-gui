import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
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

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(
    window.locator(".timeline-item--assistant", { hasText: `Answer to ${text}` }),
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === state.selectedSessionId)?.status;
    })
    .toBe("idle");
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

/** The user messages shown faded as the ones a pending edit will replace. */
async function supersededUserTexts(window: Page) {
  return window
    .locator(".timeline__virtual-row--superseded .timeline-item--user .timeline-item__bubble")
    .allInnerTexts();
}

/** The session file's active branch, read with pi's own SessionManager. */
async function persistedBranch(sessionFile: string) {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      open(path: string): {
        getBranch(): { type: string; message?: { role: string; content: unknown } }[];
      };
    };
  };
  return SessionManager.open(sessionFile)
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" &&
      (entry.message?.role === "user" || entry.message?.role === "assistant")
        ? [
            `${entry.message.role}: ${
              typeof entry.message.content === "string"
                ? entry.message.content
                : (entry.message.content as { type: string; text?: string }[])
                    .map((part) => part.text ?? "")
                    .join("")
            }`,
          ]
        : [],
    );
}

test("sending an edited user message rewinds the thread in place and reruns from there", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("edit-rewind");
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

  let harness = await launch();
  let sessionId = "";
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Other thread");
    await createNamedThread(window, "Rewind thread");
    sessionId = (await getDesktopState(window)).selectedSessionId ?? "";
    const composer = window.getByTestId("composer");
    const transcript = window.getByTestId("transcript");
    const errorBanner = window.getByTestId("composer-error-banner");

    // Messages sent in this app run, so their rows carry no session entry id yet.
    await send(window, "First question");
    await send(window, "Second question");
    await send(window, "Third question");

    await test.step("an earlier message", async () => {
      await editMessage(window, "Second question");
      await expect(composer).toHaveValue("Second question");
      await expect(composer).toBeFocused();
      await expect(errorBanner).toHaveCount(0);
      expect((await getDesktopState(window)).selectedSessionId).toBe(sessionId);
      // The thread is unchanged until the edit is sent.
      await expect(window.getByTestId("composer-message-edit")).toBeVisible();
      expect(await userTexts(window)).toEqual([
        "First question",
        "Second question",
        "Third question",
      ]);
      await expect
        .poll(() => supersededUserTexts(window))
        .toEqual(["Second question", "Third question"]);

      const requestsBefore = server.requests.length;
      await send(window, "Second question, edited");
      await expect(errorBanner).toHaveCount(0);
      expect(await userTexts(window)).toEqual(["First question", "Second question, edited"]);
      await expect(window.getByTestId("composer-message-edit")).toHaveCount(0);
      await expect(transcript).not.toContainText("Third question");
      const sent = server.requests.slice(requestsBefore).find((r) => r.toolNames.length > 0);
      expect(sent?.messages.filter((m) => m.role !== "system").map((m) => m.content)).toEqual([
        "First question",
        "Answer to First question",
        "Second question, edited",
      ]);
    });

    await test.step("the latest message", async () => {
      await editMessage(window, "Second question, edited");
      await expect(composer).toHaveValue("Second question, edited");
      await expect.poll(() => supersededUserTexts(window)).toEqual(["Second question, edited"]);
      await send(window, "Second question, again");
      await expect(errorBanner).toHaveCount(0);
    });

    await test.step("the first message", async () => {
      await editMessage(window, "First question");
      await expect(composer).toHaveValue("First question");
      await expect
        .poll(() => supersededUserTexts(window))
        .toEqual(["First question", "Second question, again"]);
      await expect(errorBanner).toHaveCount(0);
      await send(window, "First question, edited");
      await send(window, "Follow-up");
      await expect(errorBanner).toHaveCount(0);
    });

    const expected = ["First question, edited", "Follow-up"];
    expect(await userTexts(window)).toEqual(expected);

    await test.step("survives a thread switch", async () => {
      await selectSession(window, "Other thread");
      await selectSession(window, "Rewind thread");
      await expect.poll(() => userTexts(window)).toEqual(expected);
    });
  } finally {
    await harness.close();
  }

  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Rewind thread");
    await expect.poll(() => userTexts(window)).toEqual(["First question, edited", "Follow-up"]);
    await expect(window.getByTestId("transcript")).not.toContainText("Second question");

    const state = await getDesktopState(window);
    const session = state.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((candidate) => candidate.id === sessionId);
    const sessionFile = await findSessionFile(agentDir, sessionId);
    expect(session).toBeTruthy();
    expect(await persistedBranch(sessionFile)).toEqual([
      "user: First question, edited",
      "assistant: Answer to First question, edited",
      "user: Follow-up",
      "assistant: Answer to Follow-up",
    ]);
    // The abandoned branches stay in the file for /tree.
    const raw = await readFile(sessionFile, "utf8");
    expect(raw).toContain("Third question");
    expect(raw).toContain("Second question, again");
  } finally {
    await harness.close();
    await server.close();
  }
});

async function findSessionFile(agentDir: string, sessionId: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const root = join(agentDir, "sessions");
  for (const folder of await readdir(root)) {
    for (const file of await readdir(join(root, folder))) {
      if (file.endsWith(`_${sessionId}.jsonl`)) return join(root, folder, file);
    }
  }
  throw new Error(`No session file for ${sessionId}`);
}
