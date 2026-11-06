import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { startScriptedOpenAiServer } from "../helpers/scripted-openai-server";

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => join(dir, entry));
}

function locate(state: DesktopAppState, sessionId: string) {
  return state.workspaces
    .filter((workspace) => workspace.sessions.some((session) => session.id === sessionId))
    .map((workspace) => workspace.id);
}

async function moveTo(window: Page, sessionId: string, destination: string): Promise<void> {
  const row = window.locator(`.session-row[data-session-id="${sessionId}"]`);
  await row.click({ button: "right" });
  await row.getByRole("button", { name: "Move to…", exact: true }).click();
  const dialog = window.getByTestId("move-thread-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(destination, { exact: true }).check();
  await dialog.getByTestId("move-thread-confirm").click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
}

test("moves an idle thread between folders and out of any folder, keeping its history and state", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const alphaPath = await makeWorkspace("move-alpha");
  const betaPath = await makeWorkspace("move-beta");
  // A scripted model replies, so pi saves the whole exchange to the thread's file.
  const server = await startScriptedOpenAiServer(() => ({ text: "Noted." }));
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
      initialWorkspaces: [alphaPath, betaPath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  let harness = await launch();
  let sessionId = "";
  let betaId = "";
  try {
    const window = await harness.firstWindow();
    const alpha = await waitForWorkspaceByPath(window, alphaPath);
    const beta = await waitForWorkspaceByPath(window, betaPath);
    betaId = beta.id;
    await startThreadFromSurface(window, {
      workspaceName: alpha.name,
      prompt: "Remember the word PERIWINKLE",
    });
    const started = await getDesktopState(window);
    sessionId = started.selectedSessionId;
    expect(started.selectedWorkspaceId).toBe(alpha.id);
    await expect(window.getByTestId("transcript")).toContainText("Noted.");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === sessionId)?.status;
      })
      .not.toBe("running");

    // State that must follow the thread: a pin and an unsent draft.
    const row = window.locator(`.session-row[data-session-id="${sessionId}"]`);
    await row.click({ button: "right" });
    await row.getByRole("button", { name: "Pin thread", exact: true }).click();
    await expect(row).toHaveAttribute("data-session-pinned", "true");
    await window.getByTestId("composer").fill("draft that must survive the move");

    await moveTo(window, sessionId, beta.name);
    await expect
      .poll(async () => locate(await getDesktopState(window), sessionId))
      .toEqual([beta.id]);
    let state = await getDesktopState(window);
    expect(state.selectedWorkspaceId).toBe(beta.id);
    expect(state.selectedSessionId).toBe(sessionId);
    await expect(row).toHaveAttribute("data-session-pinned", "true");
    await expect(window.getByTestId("composer")).toHaveValue("draft that must survive the move");
    await expect
      .poll(async () =>
        (await getSelectedTranscript(window))?.transcript.some(
          (item) => item.kind === "message" && item.text.includes("PERIWINKLE"),
        ),
      )
      .toBe(true);

    // The model sees the earlier exchange, and the thread keeps working in its new folder.
    await window.getByTestId("composer").fill("And now?");
    await window.getByTestId("composer").press("Enter");
    const followUp = () =>
      server.requests.find((request) =>
        request.messages.some((message) => message.content.includes("And now?")),
      );
    await expect.poll(() => Boolean(followUp())).toBe(true);
    expect(followUp()?.messages.some((m) => m.content.includes("PERIWINKLE"))).toBe(true);
    await expect
      .poll(async () => {
        const current = await getDesktopState(window);
        return current.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === sessionId)?.status;
      })
      .toBe("idle");

    // The original file is set aside, never deleted.
    const files = await filesUnder(join(agentDir, "sessions"));
    expect(files.filter((file) => file.endsWith(".jsonl.moved"))).toHaveLength(1);

    // Out of any folder, and back into one.
    await moveTo(window, sessionId, "No folder");
    state = await getDesktopState(window);
    const chats = state.workspaces.find((workspace) => workspace.kind === "chats");
    await expect
      .poll(async () => locate(await getDesktopState(window), sessionId))
      .toEqual([chats?.id]);
    await expect(window.locator(".topbar__workspace")).toHaveCount(0);
    await moveTo(window, sessionId, alpha.name);
    await expect
      .poll(async () => locate(await getDesktopState(window), sessionId))
      .toEqual([alpha.id]);
    await moveTo(window, sessionId, beta.name);
    await expect
      .poll(async () => locate(await getDesktopState(window), sessionId))
      .toEqual([beta.id]);
  } finally {
    await harness.close();
  }

  // After a restart the thread is only where it was moved; the old folders do not list it.
  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await expect
      .poll(async () => locate(await getDesktopState(window), sessionId), { timeout: 15_000 })
      .toEqual([betaId]);
    await expect(window.locator(`.session-row[data-session-id="${sessionId}"]`)).toHaveAttribute(
      "data-session-pinned",
      "true",
    );
  } finally {
    await harness.close();
    await server.close();
  }
});
