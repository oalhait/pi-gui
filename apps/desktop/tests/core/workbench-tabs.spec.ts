import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  commitAllInGitRepo,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
  chooseNewWorkbenchTab,
  selectSidePanel,
  waitForTimelineLayout,
  type DesktopHarness,
} from "../helpers/electron-app";

const TASK_A = "Workbench task A";
const TASK_B = "Workbench task B";
type ToolName = "Files" | "Review" | "Terminal";

// Real Pi history is fixture setup. All workspace, task, tab, and draft changes
// below use the visible app, with no provider requests or injected runtime events.
async function prepareWorkspace() {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("workbench-tabs");
  await writeFile(join(workspacePath, "alpha.txt"), "Alpha document\nAlpha target line\n");
  await writeFile(join(workspacePath, "beta.txt"), "Beta document\nBeta target line\n");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "Workbench fixture");
  await writeFile(
    join(workspacePath, "alpha.txt"),
    "Alpha document\nAlpha target line\nUncommitted workspace edit\n",
  );
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  for (const [title, file] of [
    [TASK_A, "alpha.txt"],
    [TASK_B, "beta.txt"],
  ] as const) {
    await seedNamedTextSessionFixture(agentDir, workspacePath, {
      title,
      userText: `Inspect ${file}`,
      assistantText: `Open ${file}:2 for the result.`,
    });
  }
  return { userDataDir, agentDir, workspacePath };
}

function toolTabs(window: Page) {
  return window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab");
}

/** Each terminal is its own tab, titled by its shell rather than "Terminal". */
function terminalTabs(window: Page) {
  return window.locator('#task-workbench [role="tab"][data-testid^="workbench-tab-terminal"]');
}

/** A tool tab by name, or a file tab by its basename. */
async function expectActiveTool(window: Page, name: ToolName | string): Promise<void> {
  await expect(window.getByTestId("workbench")).toBeVisible();
  if (name === "Terminal") {
    await expect(terminalTabs(window).and(window.locator('[aria-selected="true"]'))).toHaveCount(1);
    return;
  }
  await expect(
    window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab", {
      name,
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
}

async function closeTab(tab: ReturnType<Page["locator"]>): Promise<void> {
  await tab.locator("..").locator(".workbench__tab-close").click();
}

/** Tasks without a saved layout start with the workbench hidden. */
async function openWorkbench(window: Page): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  await expect(workbench).toBeVisible();
}

/** Adds a tab from the Add tab menu; Terminal always starts another terminal. */
async function addTool(window: Page, name: ToolName): Promise<void> {
  await openWorkbench(window);
  await chooseNewWorkbenchTab(window, name);
  await expectActiveTool(window, name);
}

async function openSecondWindow(harness: DesktopHarness): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  // The app's native New Window shortcut is handled in before-input-event.
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, modifier) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "n",
        modifiers: [modifier, "shift"],
      });
    },
    process.platform === "darwin" ? "meta" : "control",
  );
  await expect.poll(() => harness.electronApp.windows().length).toBe(existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) throw new Error("Expected New Window to create a second desktop window");
  await opened.waitForLoadState("domcontentloaded");
  return opened;
}

async function captureToolWidths(
  harness: DesktopHarness,
  window: Page,
  testInfo: TestInfo,
  tool: ToolName,
): Promise<void> {
  for (const width of [1280, 1040]) {
    await harness.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 900);
    }, width);
    await expect.poll(() => window.evaluate(() => globalThis.window.innerWidth)).toBe(width);
    await expectActiveTool(window, tool);
    await expect(window.getByTestId("composer")).toBeVisible();
    const path = testInfo.outputPath(`${tool.toLowerCase()}-${width}.png`);
    await window.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`${tool} at ${width}px`, { path, contentType: "image/png" });
  }
}

test("adds one tab per tool, file and terminal, closes to a neighbor, and keeps an empty chooser", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
    envOverrides: process.platform === "win32" ? {} : { SHELL: "/bin/sh", ENV: "" },
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await openWorkbench(window);
    await expectActiveTool(window, "Review");
    await addTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    await captureToolWidths(harness, window, testInfo, "Files");
    // Picking a file in the tree opens it in its own tab, not inside Files.
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expectActiveTool(window, "alpha.txt");
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'WORKBENCH_'\"READY\\n\"; pwd");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("WORKBENCH_READY");
    await captureToolWidths(harness, window, testInfo, "Terminal");
    await addTool(window, "Review");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window
      .locator('.diff-panel__file[data-file-path="alpha.txt"] .diff-panel__file-name')
      .click();
    await expect(
      window.getByRole("region", { name: "Diff", exact: true }).locator(".diff-inline"),
    ).toContainText("Uncommitted workspace edit");
    await captureToolWidths(harness, window, testInfo, "Review");
    await expect(toolTabs(window)).toHaveText(["Review", "Files", "alpha.txt", /\S/]);
    // Review and Files are singletons; another Terminal is another tab.
    await addTool(window, "Review");
    await addTool(window, "Files");
    await expect(toolTabs(window)).toHaveCount(4);
    await addTool(window, "Terminal");
    await expect(toolTabs(window)).toHaveCount(5);
    await expect(terminalTabs(window)).toHaveCount(2);

    await closeTab(terminalTabs(window).last());
    await expect(terminalTabs(window)).toHaveCount(1);
    await expect(terminalTabs(window)).toHaveAttribute("aria-selected", "true");
    await closeTab(terminalTabs(window));
    await expectActiveTool(window, "alpha.txt");
    await window.getByRole("button", { name: "Close alpha.txt tab", exact: true }).click();
    await expectActiveTool(window, "Files");
    await window.getByRole("button", { name: "Close Files tab", exact: true }).click();
    await expectActiveTool(window, "Review");
    await window.getByRole("button", { name: "Close Review tab", exact: true }).click();
    await expect(window.getByTestId("workbench-chooser")).toBeVisible();
    await expect(toolTabs(window)).toHaveCount(0);
    await window
      .getByTestId("workbench-chooser")
      .getByRole("button", {
        name: "Files",
        exact: true,
      })
      .click();
    await window.getByTestId("toggle-side-panel").click();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.getByTestId("toggle-side-panel").click();
    await expectActiveTool(window, "Files");
    await expect(window.getByTestId("file-workbench")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("Cmd/Ctrl+T opens the Add tab menu, and a new terminal tab from the terminal", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  // Native input passes through main's before-input-event, unlike Playwright's keydowns.
  const pressNewTab = () =>
    harness.electronApp.evaluate(
      ({ BrowserWindow }, modifier) => {
        BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "t",
          modifiers: [modifier],
        });
      },
      process.platform === "darwin" ? ("meta" as const) : ("control" as const),
    );
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    const menu = window.getByTestId("workbench-new-tab-menu");
    const firstItem = menu.getByRole("menuitem", { name: "Files" });
    const tabs = toolTabs(window);

    // From the composer, with the side panel hidden: the panel opens with its menu.
    await window.getByTestId("composer").click();
    await pressNewTab();
    await expect(menu).toBeVisible();
    await expect(firstItem).toBeFocused();
    await expect(tabs).toHaveText(["Review"]);
    await window.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expectActiveTool(window, "Files");

    // From the command palette, the palette closes and the menu opens.
    await window.keyboard.press(desktopShortcut("K"));
    await expect(window.getByTestId("command-palette")).toBeVisible();
    await pressNewTab();
    await expect(window.getByTestId("command-palette")).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(firstItem).toBeFocused();
    await expect(tabs).toHaveText(["Review", "Files"]);
    await menu.getByRole("menuitem", { name: "New terminal" }).click();
    await expectActiveTool(window, "Terminal");

    // Inside the shell the shortcut opens another terminal in its own tab instead.
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminalTabs(window)).toHaveCount(1);
    await terminal.locator(".xterm").click();
    await pressNewTab();
    await expect(terminalTabs(window)).toHaveCount(2);
    await expect(terminalTabs(window).last()).toHaveAttribute("aria-selected", "true");
    await expect(menu).toHaveCount(0);

    // A tab button is not the shell, so the menu opens from there.
    await terminalTabs(window).first().focus();
    await pressNewTab();
    await expect(menu).toBeVisible();
    await expect(firstItem).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(window.getByTestId("workbench-add-tab")).toBeFocused();
  } finally {
    await harness.close();
  }
});

test("restores each task's tabs and draft through Settings, switching, and restart", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  try {
    let window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Files");
    await window.locator('.file-workbench__tree-row--file[data-file-path="alpha.txt"]').click();
    await expectActiveTool(window, "alpha.txt");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await window.getByTestId("composer").fill("Draft for task A");

    await selectSession(window, TASK_B);
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await openWorkbench(window);
    await expectActiveTool(window, "Review");
    await expect(window.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
    await addTool(window, "Terminal");
    await window.getByTestId("composer").fill("Draft for task B");
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expectActiveTool(window, "Terminal");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expectActiveTool(window, "Terminal");

    await selectSession(window, TASK_A);
    await expectActiveTool(window, "alpha.txt");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await window.getByTestId("toggle-side-panel").click();
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);

    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task A");
    await window.getByTestId("toggle-side-panel").click();
    await expectActiveTool(window, "alpha.txt");
    await expect(toolTabs(window)).toHaveText(["Review", "Files", "alpha.txt"]);
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
  } finally {
    await harness.close();
  }
});

test("an invalid or orphaned task layout does not block other saved UI state", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  const uiStatePath = join(fixture.userDataDir, "ui-state.json");
  const savedLayouts = async () =>
    (
      JSON.parse(await readFile(uiStatePath, "utf8")) as {
        taskWorkbenchTemplatesBySession?: Record<string, unknown>;
      }
    ).taskWorkbenchTemplatesBySession ?? {};
  let harness = await launchDesktop(fixture.userDataDir, options);
  let layoutA = "";
  let layoutB = "";
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Files");
    await selectSession(window, TASK_B);
    await addTool(window, "Terminal");
    await window.getByTestId("composer").fill("Draft for task B");
    await expect.poll(async () => Object.keys(await savedLayouts()).length).toBe(2);
    await expect.poll(() => readFile(uiStatePath, "utf8")).toContain("Draft for task B");
    const state = await getDesktopState(window);
    layoutB = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
    layoutA = Object.keys(await savedLayouts()).find((key) => key !== layoutB) ?? "";
  } finally {
    await harness.close();
  }

  const saved = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown> & {
    taskWorkbenchTemplatesBySession: Record<string, Record<string, unknown>>;
  };
  const layouts = saved.taskWorkbenchTemplatesBySession;
  layouts["missing-workspace:deleted-task"] = layouts[layoutB]!;
  layouts[layoutA] = { ...layouts[layoutA], visibility: "expanded" };
  // A layout saved while the removed Worktrees tool was open still restores its other tabs.
  const toolsB = layouts[layoutB]!.tools as unknown[];
  layouts[layoutB] = { ...layouts[layoutB], tools: [...toolsB, { kind: "worktrees" }] };
  await writeFile(uiStatePath, JSON.stringify(saved));

  harness = await launchDesktop(fixture.userDataDir, options);
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_B);
    await expectActiveTool(window, "Terminal");
    await expect(toolTabs(window)).toHaveText(["Review", /\S/]);
    await expect(window.getByTestId("composer")).toHaveValue("Draft for task B");
    await expect.poll(async () => Object.keys(await savedLayouts())).toEqual([layoutB]);
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    await expect
      .poll(async () => Object.keys(await savedLayouts()).sort())
      .toEqual([layoutA, layoutB].sort());
  } finally {
    await harness.close();
  }
});

test("a saved v19 Files tab with file sub-tabs restores as one top-level tab per file", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  const uiStatePath = join(fixture.userDataDir, "ui-state.json");
  let harness = await launchDesktop(fixture.userDataDir, options);
  let key = "";
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    await window.getByTestId("composer").fill("Draft survives migration");
    const state = await getDesktopState(window);
    key = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
    await expect.poll(() => readFile(uiStatePath, "utf8")).toContain("Draft survives migration");
  } finally {
    await harness.close();
  }

  // Rewrite the layout in the shape v19 saved: one Files tab holding a strip of files.
  const saved = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown> & {
    taskWorkbenchTemplatesBySession: Record<string, Record<string, unknown>>;
  };
  const layout = saved.taskWorkbenchTemplatesBySession[key]!;
  const files = layout.files as { workspaceId: string };
  saved.version = 19;
  saved.taskWorkbenchTemplatesBySession[key] = {
    ...layout,
    visibility: "visible",
    tools: [{ kind: "changes" }, { kind: "files" }, { kind: "terminal" }],
    selection: { kind: "tool", toolId: "files" },
    files: {
      workspaceId: files.workspaceId,
      tabs: {
        tabs: ["alpha.txt", "beta.txt"],
        active: "beta.txt",
        line: { start: 2, end: 2 },
        lineNonce: 4,
        retained: [],
      },
    },
  };
  const legacyBytes = JSON.stringify(saved);
  await writeFile(uiStatePath, legacyBytes);

  harness = await launchDesktop(fixture.userDataDir, options);
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect(window.getByTestId("composer")).toHaveValue("Draft survives migration");
    await expect(toolTabs(window)).toHaveText(["Review", "Files", "alpha.txt", "beta.txt", /\S/]);
    await expectActiveTool(window, "beta.txt");
    await expect(window.getByTestId("file-line-mark")).toContainText("Beta target line");
    await window.getByRole("tab", { name: "alpha.txt", exact: true }).click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Alpha document");
    await window.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    // The next save writes v20 and keeps the exact v19 bytes beside it.
    await window.getByRole("tab", { name: "Review", exact: true }).click();
    await expect
      .poll(
        async () =>
          (JSON.parse(await readFile(uiStatePath, "utf8")) as { version: number }).version,
      )
      .toBe(20);
    const copies = (await readdir(fixture.userDataDir)).filter((name) =>
      name.startsWith("ui-state.pre-workbench-v19."),
    );
    expect(copies).toHaveLength(1);
    expect(await readFile(join(fixture.userDataDir, copies[0]!), "utf8")).toBe(legacyBytes);
  } finally {
    await harness.close();
  }
});

test("assistant file links keep the opened document with their originating task", async () => {
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await window.getByTestId("toggle-side-panel").click();
    await waitForTimelineLayout(window);
    await window.getByTestId("workspace-file-link").filter({ hasText: "alpha.txt:2" }).click();
    await expectActiveTool(window, "alpha.txt");
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
    await selectSession(window, TASK_B);
    await waitForTimelineLayout(window);
    await window.getByTestId("workspace-file-link").filter({ hasText: "beta.txt:2" }).click();
    await expectActiveTool(window, "beta.txt");
    await expect(window.getByTestId("file-line-mark")).toContainText("Beta target line");
    await expect(toolTabs(window)).toHaveText(["Review", "beta.txt"]);
    await selectSession(window, TASK_A);
    await expectActiveTool(window, "alpha.txt");
    await expect(toolTabs(window)).toHaveText(["Review", "alpha.txt"]);
    await expect(window.getByTestId("file-line-mark")).toContainText("Alpha target line");
    // Following the same link again focuses its tab instead of adding one.
    await window.getByRole("tab", { name: "Review", exact: true }).click();
    await window.getByTestId("workspace-file-link").filter({ hasText: "alpha.txt:2" }).click();
    await expectActiveTool(window, "alpha.txt");
    await expect(toolTabs(window)).toHaveText(["Review", "alpha.txt"]);
  } finally {
    await harness.close();
  }
});

test("each terminal is its own tab, and closing one ends only that shell", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
    envOverrides: process.platform === "win32" ? {} : { SHELL: "/bin/sh", ENV: "" },
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    const run = async (command: string, output: string) => {
      await terminal.locator(".xterm").click();
      await window.keyboard.type(command);
      await window.keyboard.press("Enter");
      await expect(terminal.locator(".xterm-rows")).toContainText(output);
    };
    await run("export PI_GUI_CANARY=first; printf 'FIRST_'\"READY\\n\"", "FIRST_READY");
    await addTool(window, "Terminal");
    await expect(terminalTabs(window)).toHaveCount(2);
    await run("printf 'SECOND_%s_\\n' \"$PI_GUI_CANARY\"", "SECOND__");
    // The first terminal kept its shell and output while the second was shown.
    await terminalTabs(window).first().click();
    await expect(terminal.locator(".xterm-rows")).toContainText("FIRST_READY");
    await run("printf 'FIRST_%s\\n' \"$PI_GUI_CANARY\"", "FIRST_first");
    await terminalTabs(window).last().click();
    await closeTab(terminalTabs(window).last());
    await expect(terminalTabs(window)).toHaveCount(1);
    await expect(terminalTabs(window)).toHaveAttribute("aria-selected", "true");
    await expect(terminal.locator(".xterm-rows")).toContainText("FIRST_first");
    await closeTab(terminalTabs(window));
    await expect(terminal).toHaveCount(0);
    await expect(terminalTabs(window)).toHaveCount(0);
    await expectActiveTool(window, "Review");
    // Closing the last terminal ended its shell; a new terminal starts fresh.
    await addTool(window, "Terminal");
    await run("printf 'FRESH_%s_\\n' \"$PI_GUI_CANARY\"", "FRESH__");
    await expect(terminalTabs(window)).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("two windows keep independent live tool selections for the same task", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareWorkspace();
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const first = await harness.firstWindow();
    await selectSession(first, TASK_A);
    await addTool(first, "Files");
    const second = await openSecondWindow(harness);
    await selectSession(second, TASK_A);
    await expectActiveTool(second, "Files");
    await addTool(second, "Terminal");
    await expectActiveTool(first, "Files");
    await expect(terminalTabs(first)).toHaveCount(0);
    await selectSidePanel(first, "Review");
    await expectActiveTool(second, "Terminal");
    await first.getByTestId("toggle-side-panel").click();
    await expect(first.getByTestId("workbench")).toHaveCount(0);
    await expectActiveTool(second, "Terminal");
  } finally {
    await harness.close();
  }
});

test("keeps one resizable width across tools, chooser, tasks, and restart", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await prepareWorkspace();
  const options = {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background" as const,
  };
  let harness = await launchDesktop(fixture.userDataDir, options);
  const setWindowWidth = async (width: number) => {
    await harness.electronApp.evaluate(({ BrowserWindow }, nextWidth) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 900);
    }, width);
  };
  try {
    await setWindowWidth(1440);
    let window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await openWorkbench(window);
    const panelWidth = async () =>
      Math.round((await window.getByTestId("workbench").boundingBox())!.width);
    await expect.poll(panelWidth).toBe(440);
    const handle = window.getByRole("separator", { name: "Side panel width" });
    const start = (await handle.boundingBox())!;
    await window.mouse.move(start.x + 3, start.y + 160);
    await window.mouse.down();
    await window.mouse.move(start.x - 97, start.y + 160, { steps: 10 });
    await window.mouse.up();
    await expect.poll(panelWidth).toBe(540);
    for (const tool of ["Files", "Review", "Terminal"] as const) {
      await window.getByTestId("workbench-add-tab").click();
      await expect.poll(panelWidth).toBe(540);
      await window
        .getByTestId("workbench-new-tab-menu")
        .getByRole("menuitem", { name: tool === "Terminal" ? "New terminal" : tool })
        .click();
      await expectActiveTool(window, tool);
      await expect.poll(panelWidth).toBe(540);
    }
    const add = (await window.getByTestId("workbench-add-tab").boundingBox())!;
    const toggle = (await window.getByTestId("toggle-side-panel").boundingBox())!;
    const title = (await window.locator(".chat-header__title").boundingBox())!;
    expect(Math.abs(add.y - toggle.y)).toBeLessThan(2);
    expect(title.y).toBeLessThan(48);
    expect(toggle.x).toBeGreaterThan(add.x);
    await expect(window.getByTestId("topbar").getByRole("heading", { name: TASK_A })).toBeVisible();
    await window.getByTestId("thread-header-menu").click();
    await expect(window.locator('[data-thread-action="scheduled-task"]')).toBeVisible();
    await window.getByTestId("thread-header-menu").click();
    await window.getByTestId("toggle-side-panel").click();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.getByTestId("toggle-side-panel").click();
    await expect.poll(panelWidth).toBe(540);
    await selectSession(window, TASK_B);
    await openWorkbench(window);
    await expect.poll(panelWidth).toBe(540);
    await handle.focus();
    await handle.press("ArrowRight");
    await expect.poll(panelWidth).toBe(520);
    await window.screenshot({ path: testInfo.outputPath("compact-resizable-workspace.png") });
    await setWindowWidth(1040);
    await expect.poll(panelWidth).toBeLessThanOrEqual(520);
    await expect(window.getByTestId("composer")).toBeVisible();
    await setWindowWidth(900);
    await expect.poll(panelWidth).toBe(520);
    await handle.focus();
    await handle.press("Home");
    await expect.poll(panelWidth).toBe(320);
    await selectSession(window, TASK_A);
    await addTool(window, "Terminal");
    const activeTab = (await terminalTabs(window).last().boundingBox())!;
    const strip = (await window.getByRole("tablist", { name: "Workspace tools" }).boundingBox())!;
    expect(activeTab.x).toBeGreaterThanOrEqual(strip.x);
    expect(activeTab.x + activeTab.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    await handle.focus();
    await handle.press("ArrowLeft");
    await expect.poll(panelWidth).toBe(340);
    await window.getByTestId("workbench-add-tab").click();
    await expect.poll(panelWidth).toBe(340);
    await expect(window.getByTestId("workbench-new-tab-menu")).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("narrow-workspace-menu.png") });
    // Wait for the debounced preference write before exercising a fresh process.
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe("340");
    await harness.close();
    harness = await launchDesktop(fixture.userDataDir, options);
    window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    await expect.poll(panelWidth).toBe(340);
  } finally {
    await harness.close();
  }
});

test("shows and selects GPT-6 Sol from the upgraded Pi model catalog", async ({}, testInfo) => {
  const fixture = await prepareWorkspace();
  // Synthetic credentials enable the provider catalog; this test never sends a request.
  await seedAgentDir(fixture.agentDir, {
    enabledModels: ["openai/gpt-6-sol", "openai/gpt-6-luna"],
  });
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, TASK_A);
    const badge = window.locator(".composer__bar .model-selector__badge").first();
    await badge.click();
    const dropdown = window.locator(".composer__bar .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-6 Sol");
    await expect(dropdown).toContainText("GPT-6 Luna");
    await dropdown.getByRole("button", { name: /GPT-6 Sol/ }).click();
    await expect(badge).toHaveText("openai:gpt-6-sol");
    await expect(
      window.locator(".composer").getByRole("button", { name: "medium", exact: true }),
    ).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("gpt-6-sol-selected.png") });
  } finally {
    await harness.close();
  }
});
