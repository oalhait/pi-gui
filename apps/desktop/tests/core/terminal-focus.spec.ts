import { expect, test } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

test("a terminal that finishes opening keeps focus in the composer when the user moved there", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("terminal-focus");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Terminal focus");
    await harness.electronApp.evaluate(({ ipcMain }, channel) => {
      type Handler = (...args: unknown[]) => unknown;
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get(channel);
      if (!original) throw new Error("Missing terminal handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const control = { entered: false, release };
      (
        globalThis as typeof globalThis & { terminalResponseGate?: typeof control }
      ).terminalResponseGate = control;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args);
        control.entered = true;
        await gate;
        return result;
      });
    }, desktopIpc.terminalEnsurePanel);
    await selectSidePanel(window, "Terminal");
    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { terminalResponseGate?: { entered: boolean } })
              .terminalResponseGate?.entered,
        ),
      )
      .toBe(true);
    const composer = window.getByTestId("composer");
    await composer.fill("Keep typing here");
    await harness.electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & { terminalResponseGate?: { release: () => void } }
      ).terminalResponseGate?.release(),
    );
    await expect(window.locator(".terminal-panel .xterm-helper-textarea")).toHaveCount(1);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep typing here");
  } finally {
    await harness.close();
  }
});
