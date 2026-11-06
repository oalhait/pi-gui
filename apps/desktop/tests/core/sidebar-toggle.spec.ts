import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import {
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const NARROW_WINDOW_WIDTH = 1200;
/** `trafficLightPosition` in `electron/windows/window-chrome.ts`. */
const TRAFFIC_LIGHTS = { x: 18, y: 18 } as const;
/** macOS draws three 14px window buttons 9px apart: close, minimize and zoom. */
const TRAFFIC_LIGHT_SIZE = 14;
const TRAFFIC_LIGHTS_WIDTH = 3 * TRAFFIC_LIGHT_SIZE + 2 * 9;
/** The smallest clear gap macOS title-bar controls keep after the zoom button. */
const MIN_TRAFFIC_LIGHT_GAP = 8;
const NARROW_WINDOW_HEIGHT = 760;

interface SidebarLayout {
  readonly viewportWidth: number;
  readonly mainLeft: number;
  readonly mainRight: number;
  readonly mainWidth: number;
  readonly toggleRight: number;
  readonly topbarLeft: number;
  readonly topbarRight: number;
}

async function expectSidebarCollapsed(window: Page, collapsed: boolean): Promise<void> {
  await expect(window.locator(".sidebar")).toHaveCount(collapsed ? 0 : 1);
  await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(collapsed);
}

async function restoreSidebarIfNeeded(window: Page): Promise<void> {
  if ((await getDesktopState(window)).sidebarCollapsed) {
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
  }
}

async function readSidebarLayout(window: Page): Promise<SidebarLayout | null> {
  return window.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main");
    const toggle = document.querySelector<HTMLElement>("[data-testid='sidebar-toggle']");
    const topbar = document.querySelector<HTMLElement>(".topbar");
    if (!main || !toggle || !topbar) {
      return null;
    }
    const mainRect = main.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    const topbarRect = topbar.getBoundingClientRect();
    return {
      viewportWidth: globalThis.window.innerWidth,
      mainLeft: mainRect.left,
      mainRight: mainRect.right,
      mainWidth: mainRect.width,
      toggleRight: toggleRect.right,
      topbarLeft: topbarRect.left,
      topbarRight: topbarRect.right,
    };
  });
}

async function expectToggleClearOfTopbarDragRegion(window: Page): Promise<void> {
  const layout = await readSidebarLayout(window);
  if (!layout) {
    throw new Error("Expected main, sidebar toggle, and topbar to be present");
  }
  expect(layout.toggleRight).toBeLessThanOrEqual(layout.topbarLeft);
}

async function setElectronWindowSize(
  app: Awaited<ReturnType<typeof launchDesktop>>["electronApp"],
  window: Page,
  width: number,
  height: number,
): Promise<void> {
  const didSetSize = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        return false;
      }
      window.setSize(size.width, size.height);
      return true;
    },
    { width, height },
  );
  expect(didSetSize).toBe(true);
  await expect
    .poll(() =>
      window.evaluate(() => ({
        height: globalThis.window.innerHeight,
        width: globalThis.window.innerWidth,
      })),
    )
    .toEqual({ height, width });
}

async function writeProofScreenshot(window: Page, name: string): Promise<void> {
  const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;
  if (!proofDir) {
    return;
  }
  await window.screenshot({ path: join(proofDir, name), fullPage: false });
}

async function expectSecondaryTakeover(window: Page, testId: string): Promise<void> {
  await expect(window.getByTestId(testId)).toBeVisible();
  await expect(window.locator(".secondary-surface__sidebar")).toBeVisible();
  await expect(window.locator(".shell, .sidebar, .main")).toHaveCount(0);
  await expect(window.getByTestId("sidebar-toggle")).toHaveCount(0);
}

async function writeTakeoverProof(window: Page, name: string): Promise<void> {
  const proofDir = process.env.PI_APP_TAKEOVER_PROOF_DIR;
  if (proofDir) {
    await window.screenshot({ path: join(proofDir, name), fullPage: false });
  }
}

test("toggles and persists the primary sidebar from the button and keyboard shortcut", async () => {
  test.setTimeout(90_000);
  const takeoverProofDir = process.env.PI_APP_TAKEOVER_PROOF_DIR;
  if (takeoverProofDir) {
    await mkdir(takeoverProofDir, { recursive: true });
  }
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-toggle-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const toggle = window.getByTestId("sidebar-toggle");
    await expect(toggle).toBeVisible();
    await expect(window.locator(".sidebar")).toBeVisible();
    const expandedMainBox = await window.locator(".main").boundingBox();
    expect(expandedMainBox).not.toBeNull();

    await toggle.click();
    await expectSidebarCollapsed(window, true);
    await expectToggleClearOfTopbarDragRegion(window);
    const collapsedMainBox = await window.locator(".main").boundingBox();
    expect(collapsedMainBox).not.toBeNull();
    expect(collapsedMainBox?.x ?? 999).toBeLessThan(expandedMainBox?.x ?? 0);
    expect(collapsedMainBox?.width ?? 0).toBeGreaterThan(expandedMainBox?.width ?? 9999);

    await toggle.click();
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut("Shift+O"));
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, false);

    await window.keyboard.press(desktopShortcut(","));
    await expectSecondaryTakeover(window, "settings-surface");
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await window.getByRole("radio", { name: "Light", exact: true }).click();
    await writeTakeoverProof(window, "settings-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expectSecondaryTakeover(window, "skills-surface");
    await writeTakeoverProof(window, "skills-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expectSecondaryTakeover(window, "extensions-surface");
    await writeTakeoverProof(window, "extensions-light.png");
    await window.keyboard.press(desktopShortcut("B"));
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(false);
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.keyboard.press(desktopShortcut(","));
    await expectSecondaryTakeover(window, "settings-surface");
    await window.getByRole("radio", { name: "Dark", exact: true }).click();
    await writeTakeoverProof(window, "settings-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expectSecondaryTakeover(window, "skills-surface");
    await writeTakeoverProof(window, "skills-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expectSecondaryTakeover(window, "extensions-surface");
    await writeTakeoverProof(window, "extensions-dark.png");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await restoreSidebarIfNeeded(window);
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, true);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expectSidebarCollapsed(window, true);
    await expect(window.getByTestId("sidebar-toggle")).toBeVisible();
    await expectToggleClearOfTopbarDragRegion(window);
    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
  } finally {
    await secondRun.close();
  }
});

test("keeps collapsed sidebar out of narrow windows and reopens from the button", async () => {
  test.setTimeout(90_000);
  const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-narrow-workspace");
  const run = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    ...(proofDir
      ? {
          recordVideoDir: join(proofDir, "videos"),
          recordVideoSize: { width: NARROW_WINDOW_WIDTH, height: NARROW_WINDOW_HEIGHT },
        }
      : {}),
  });
  let window: Page | undefined;

  try {
    window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await setElectronWindowSize(run.electronApp, window, NARROW_WINDOW_WIDTH, NARROW_WINDOW_HEIGHT);
    await expect(window.getByTestId("sidebar-toggle")).toBeVisible();

    await window.keyboard.press(desktopShortcut("B"));
    await expectSidebarCollapsed(window, true);
    await expectToggleClearOfTopbarDragRegion(window);
    await writeProofScreenshot(window, "narrow-sidebar-collapsed.png");

    const collapsedLayout = await readSidebarLayout(window);
    if (!collapsedLayout) {
      throw new Error(
        "Expected collapsed narrow layout to include main, topbar, and sidebar toggle",
      );
    }
    expect(collapsedLayout.viewportWidth).toBeLessThanOrEqual(NARROW_WINDOW_WIDTH);
    expect(collapsedLayout.mainLeft).toBeLessThanOrEqual(1);
    expect(collapsedLayout.mainRight).toBeGreaterThanOrEqual(collapsedLayout.viewportWidth - 1);
    expect(collapsedLayout.mainWidth).toBeGreaterThanOrEqual(collapsedLayout.viewportWidth - 1);
    expect(collapsedLayout.topbarLeft).toBeGreaterThanOrEqual(collapsedLayout.toggleRight);
    expect(collapsedLayout.topbarRight).toBeLessThanOrEqual(collapsedLayout.mainRight);

    await window.getByTestId("sidebar-toggle").click();
    await expectSidebarCollapsed(window, false);
    await expect(window.locator(".sidebar")).toBeVisible();
    const sidebarBox = await window.locator(".sidebar").boundingBox();
    const reopenedMainBox = await window.locator(".main").boundingBox();
    if (!sidebarBox || !reopenedMainBox) {
      throw new Error("Expected reopened layout to include sidebar and main regions");
    }
    expect(reopenedMainBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
    await writeProofScreenshot(window, "narrow-sidebar-reopened.png");
  } finally {
    await run.close();
    const video = window?.video();
    if (proofDir && video) {
      await video.saveAs(join(proofDir, "narrow-sidebar-reopen-flow.webm"));
    }
  }
});

interface ToggleAppearance {
  readonly background: string;
  readonly borderColor: string;
  readonly tooltipOpacity: string;
  readonly focused: boolean;
  readonly focusVisible: boolean;
}

async function readToggleAppearance(button: Locator): Promise<ToggleAppearance> {
  return button.evaluate((button) => {
    const tooltip = button.closest(".shortcut-tooltip-wrap")?.querySelector(".shortcut-tooltip");
    const style = getComputedStyle(button);
    return {
      background: style.backgroundColor,
      borderColor: style.borderColor,
      tooltipOpacity: tooltip ? getComputedStyle(tooltip).opacity : "missing",
      focused: document.activeElement === button,
      focusVisible: button.matches(":focus-visible"),
    };
  });
}

/** Reads the at-rest look once the hover and tooltip transitions settle. */
async function expectSettledAppearance(
  button: Locator,
  expected: Partial<ToggleAppearance>,
): Promise<ToggleAppearance> {
  await expect
    .poll(async () => {
      const appearance = await readToggleAppearance(button);
      return Object.fromEntries(
        Object.keys(expected).map((key) => [key, appearance[key as keyof ToggleAppearance]]),
      );
    })
    .toEqual(expected);
  return readToggleAppearance(button);
}

async function expectToggleClearOfTrafficLights(window: Page): Promise<void> {
  const box = await window.getByTestId("sidebar-toggle").boundingBox();
  if (!box) throw new Error("Expected the sidebar toggle to be laid out");
  const zoomRight = TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS_WIDTH;
  expect(box.x - zoomRight).toBeGreaterThanOrEqual(MIN_TRAFFIC_LIGHT_GAP);
  // Centred on the traffic lights' centre line.
  expect(
    Math.abs(box.y + box.height / 2 - (TRAFFIC_LIGHTS.y + TRAFFIC_LIGHT_SIZE / 2)),
  ).toBeLessThan(1);
}

/** Records every phase `SidebarPresence` passes through while `action` runs. */
async function recordSidebarPhases(window: Page, action: () => Promise<void>): Promise<string[]> {
  await window.evaluate(() => {
    const phases: string[] = [];
    const record = () => {
      const presence = document.querySelector(".sidebar-presence");
      const phase = presence
        ? `${presence.getAttribute("data-state")}${presence.hasAttribute("inert") ? ":inert" : ""}`
        : "unmounted";
      if (phases.at(-1) !== phase) phases.push(phase);
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "inert"],
    });
    Object.assign(globalThis, { sidebarPhases: phases, sidebarPhaseObserver: observer });
  });
  await action();
  return window.evaluate(() => {
    const scope = globalThis as unknown as {
      sidebarPhases: string[];
      sidebarPhaseObserver: MutationObserver;
    };
    scope.sidebarPhaseObserver.disconnect();
    return scope.sidebarPhases;
  });
}

test("a mouse click leaves no hover or tooltip behind; keyboard focus still shows them", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-toggle-hover-workspace");
  const run = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const toggle = window.getByTestId("sidebar-toggle");
    const rest = await expectSettledAppearance(toggle, {
      tooltipOpacity: "0",
      focused: false,
    });

    for (const collapsed of [true, false]) {
      await toggle.click();
      await expectSidebarCollapsed(window, collapsed);
      await window.mouse.move(700, 500);
      // The click keeps focus on the button, but without `:focus-visible` nothing shows.
      await expectSettledAppearance(toggle, {
        background: rest.background,
        borderColor: rest.borderColor,
        tooltipOpacity: "0",
        focused: true,
        focusVisible: false,
      });
    }

    // Keyboard focus shows the focus ring and the tooltip.
    await toggle.evaluate((button: HTMLElement) => button.blur());
    await window.keyboard.press("Shift");
    await toggle.focus();
    await expectSettledAppearance(toggle, {
      tooltipOpacity: "1",
      focused: true,
      focusVisible: true,
    });
    await window.keyboard.press("Enter");
    await expectSidebarCollapsed(window, true);
    await expectSettledAppearance(toggle, {
      tooltipOpacity: "1",
      focusVisible: true,
    });
    await window.keyboard.press("Enter");
    await expectSidebarCollapsed(window, false);

    // Other shortcut-tooltip buttons share the rule: Customize Sidebar keeps focus after its menu.
    const customize = window.getByRole("button", { name: "Customize Sidebar", exact: true });
    await customize.click();
    await expect(customize).toHaveAttribute("aria-expanded", "true");
    await customize.click();
    await expect(customize).toHaveAttribute("aria-expanded", "false");
    await window.mouse.move(700, 500);
    await expectSettledAppearance(customize, {
      tooltipOpacity: "0",
      focused: true,
      focusVisible: false,
    });
  } finally {
    await run.close();
  }
});

test("the toggle keeps clear of the traffic lights and slides the sidebar", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-toggle-geometry-workspace");
  const run = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expectToggleClearOfTrafficLights(window);

    const closing = await recordSidebarPhases(window, async () => {
      await window.getByTestId("sidebar-toggle").click();
      await expectSidebarCollapsed(window, true);
    });
    // The sidebar stays mounted but inert while it slides out, then unmounts.
    expect(closing).toEqual(["open", "closing:inert", "unmounted"]);
    await expectToggleClearOfTrafficLights(window);
    await expectToggleClearOfTopbarDragRegion(window);

    const opening = await recordSidebarPhases(window, async () => {
      await window.keyboard.press(desktopShortcut("B"));
      await expect(window.locator(".sidebar-presence")).toHaveAttribute("data-state", "open");
    });
    expect(opening).toEqual(["unmounted", "opening", "open"]);
    await expectSidebarCollapsed(window, false);
    await expect(window.locator(".sidebar")).not.toHaveAttribute("inert");

    if (process.platform === "darwin") {
      // Main reports native full screen, where macOS hides the traffic lights. The window is
      // hidden in background mode, so this sends main's report rather than entering full screen.
      const sendFullScreen = (fullScreen: boolean) =>
        run.electronApp.evaluate(
          ({ BrowserWindow }, input) =>
            BrowserWindow.getAllWindows()[0]?.webContents.send(input.channel, input.fullScreen),
          { channel: desktopIpc.fullScreenChanged, fullScreen },
        );
      await sendFullScreen(true);
      await expect
        .poll(async () => (await window.getByTestId("sidebar-toggle").boundingBox())?.x)
        .toBe(12);
      await window.getByTestId("sidebar-toggle").click();
      await expectSidebarCollapsed(window, true);
      await expectToggleClearOfTopbarDragRegion(window);
      await sendFullScreen(false);
      await expectToggleClearOfTrafficLights(window);
      await expectToggleClearOfTopbarDragRegion(window);
    }
  } finally {
    await run.close();
  }
});

test("reduced motion collapses and expands the sidebar without sliding", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("sidebar-toggle-reduced-motion-workspace");
  const run = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.emulateMedia({ reducedMotion: "reduce" });

    const closing = await recordSidebarPhases(window, async () => {
      await window.getByTestId("sidebar-toggle").click();
      await expectSidebarCollapsed(window, true);
    });
    expect(closing).toEqual(["open", "unmounted"]);

    const opening = await recordSidebarPhases(window, async () => {
      await window.getByTestId("sidebar-toggle").click();
      await expectSidebarCollapsed(window, false);
    });
    expect(opening).toEqual(["unmounted", "open"]);
    const sliding = await window.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().progress !== null)
        .map((animation) => (animation as CSSTransition).transitionProperty),
    );
    expect(sliding).not.toContain("margin-left");
    expect(sliding).not.toContain("transform");
  } finally {
    await run.close();
  }
});
