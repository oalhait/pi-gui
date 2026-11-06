import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  chooseThreadGrouping,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function selectedWorkspaceKind(window: Page): Promise<string | undefined> {
  const state = await getDesktopState(window);
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.kind;
}

async function startFromSurface(window: Page, prompt: string): Promise<void> {
  await window.getByLabel("New thread prompt").fill(prompt);
  const start = window.getByRole("button", { name: "Start thread" });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

test("starts a top-level chat with no folder open, and keeps it after restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);

  let harness = await launchDesktop(userDataDir, { agentDir, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();

    await openNewThread(window);
    await expect(window.getByRole("heading", { name: "Ask anything" })).toBeVisible();
    const picker = window.locator(".new-thread__workspace");
    await expect(picker).toBeDisabled();
    await expect(picker.locator("option:checked")).toHaveText("No folder");
    await expect(window.getByRole("button", { name: "Worktree", exact: true })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Start without a folder" })).toHaveCount(0);

    await startFromSurface(window, "What is a good name for a research notebook?");

    await expect.poll(() => selectedWorkspaceKind(window), { timeout: 15_000 }).toBe("chats");
    const state = await getDesktopState(window);
    const chats = state.workspaces.find((workspace) => workspace.kind === "chats");
    expect(chats?.name).toBe("Chats");
    expect(chats?.sessions).toHaveLength(1);
    await expect(window.getByTestId("empty-state")).toHaveCount(0);
    const row = window.locator(`.session-row[data-session-id="${state.selectedSessionId}"]`);
    await expect(row).toBeVisible();
    // No folder label on the row, and no folder name in the top bar.
    await expect(row.locator(".session-row__context")).toHaveCount(0);
    await expect(window.locator(".topbar__workspace")).toHaveCount(0);
    await expect(window.locator(".topbar__separator")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toHaveAttribute(
      "placeholder",
      "Ask a follow-up...",
    );
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, { agentDir, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await expect
      .poll(
        async () =>
          (await getDesktopState(window)).workspaces.find((workspace) => workspace.kind === "chats")
            ?.sessions.length,
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect(window.locator(".session-row")).toHaveCount(1);
    // Chats is not a folder: it is neither listed as one nor offered for removal.
    await expect(window.locator(".workspace-row")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("× next to the folder starts a top-level chat; New thread then defaults to the last place", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("top-level-chats-folder");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const folder = await waitForWorkspaceByPath(window, workspacePath);

    // A folder is the default while the user is in it.
    await openNewThread(window);
    const picker = window.locator(".new-thread__workspace");
    await expect(picker).toHaveValue(folder.id);
    await expect(window.getByRole("button", { name: "Worktree", exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Start without a folder" }).click();
    await expect(picker.locator("option:checked")).toHaveText("No folder");
    await expect(picker).toBeEnabled();
    await expect(window.getByRole("button", { name: "Worktree", exact: true })).toHaveCount(0);
    await startFromSurface(window, "Summarize the tradeoffs of SQLite WAL mode");
    await expect.poll(() => selectedWorkspaceKind(window), { timeout: 15_000 }).toBe("chats");

    // The last place was Chats, so the next New thread starts there too.
    await window.keyboard.press(desktopShortcut("N"));
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await expect(picker.locator("option:checked")).toHaveText("No folder");

    // Choosing the folder again puts the thread back in the project.
    await picker.selectOption({ label: folder.name });
    await expect(picker).toHaveValue(folder.id);
    await expect(window.getByRole("button", { name: "Start without a folder" })).toBeVisible();

    // Folder grouping lists the chat as a loose row above the folder, with no Chats group.
    await chooseThreadGrouping(window, "workspace");
    const loose = window.getByTestId("top-level-threads");
    await expect(loose.locator(".session-row")).toHaveCount(1);
    await expect(window.locator(".workspace-row")).toHaveCount(1);
    await expect(window.locator(".workspace-row__name")).toHaveText(folder.name);
    await expect(window.getByText("Chats", { exact: true })).toHaveCount(0);
    const looseBox = await loose.boundingBox();
    const folderBox = await window.locator(".workspace-row").boundingBox();
    expect(looseBox && folderBox && looseBox.y < folderBox.y).toBeTruthy();
  } finally {
    await harness.close();
  }
});
