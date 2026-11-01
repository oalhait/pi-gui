import type { PiDesktopApi } from "../../contracts/ipc";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { WorkbenchAgentState, WorkbenchAgentCommand } from "../../contracts/workbench-agent";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

async function run(harness: DesktopHarness, target: SessionRef, params: WorkbenchAgentCommand) {
  const result = await harness.electronApp.evaluate(
    async (_electron, input) => {
      const hooks = (
        globalThis as typeof globalThis & {
          __PI_APP_TEST_HOOKS: {
            runWorkbenchRuntimeTool: (
              input: unknown,
            ) => Promise<{ details: WorkbenchAgentState & { error?: string } }>;
          };
        }
      ).__PI_APP_TEST_HOOKS;
      return hooks.runWorkbenchRuntimeTool(input);
    },
    { sessionRef: target, params },
  );
  return result.details;
}

test("the agent opens browser pages and manages the side pane without desktop permissions", async () => {
  const server = createServer((_req, res) =>
    res.end("<title>Agent preview</title><h1>Opened by the agent</h1>"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing test port");
  const url = `http://127.0.0.1:${port.port}/`;
  const workspace = await makeWorkspace("agent-side-pane");
  await writeFile(join(workspace, "preview.txt"), "Agent selected this file");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Agent pane Alpha");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };
    const opened = await run(harness, target, { action: "open", tool: "browser", url });
    expect(opened.error).toBeUndefined();
    expect(opened.visible).toBe(true);
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(url);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((page) => page.getTitle() === "Agent preview"),
        ),
      )
      .toBe(true);
    const firstId = (await run(harness, target, { action: "list" })).tabs.find(
      (tab) => tab.url === url,
    )!.id;
    await run(harness, target, { action: "open", tool: "browser", url: `${url}second` });
    expect(
      (await run(harness, target, { action: "list" })).tabs.filter((tab) => tab.url),
    ).toHaveLength(2);
    await run(harness, target, { action: "navigate", tab_id: firstId, url: `${url}changed` });
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(
      `${url}changed`,
    );
    await run(harness, target, { action: "hide" });
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await run(harness, target, { action: "show" });
    await expect(window.getByTestId("workbench")).toBeVisible();
    await run(harness, target, { action: "open", tool: "files", path: "preview.txt" });
    await expect(window.getByTestId("file-workbench-preview")).toContainText(
      "Agent selected this file",
    );
    await run(harness, target, { action: "select", tab_id: firstId });
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(
      `${url}changed`,
    );
    await run(harness, target, { action: "close", tab_id: firstId });
    expect(
      (await run(harness, target, { action: "list" })).tabs.some((tab) => tab.id === firstId),
    ).toBe(false);
    await createNamedThread(window, "Agent pane Bravo");
    const rejected = await run(harness, target, { action: "open", tool: "browser", url });
    expect(rejected.error).toContain("Open this chat");
    await expect(
      window.getByRole("heading", { name: "Agent pane Bravo", exact: true }),
    ).toBeVisible();
    await expect(window.getByTestId("browser-panel")).toHaveCount(0);
    await selectSession(window, "Agent pane Alpha");
    const invalid = await run(harness, target, {
      action: "open",
      tool: "browser",
      url: "file:///etc/passwd",
    });
    expect(invalid.error).toContain("HTTP");
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function holdReply(harness: DesktopHarness, channel: string, kind?: string) {
  await harness.electronApp.evaluate(
    ({ ipcMain }, input) => {
      type Handler = (...args: unknown[]) => unknown;
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get(input.channel)!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const control = { entered: false, release };
      (
        globalThis as typeof globalThis & { workbenchReplyGate?: typeof control }
      ).workbenchReplyGate = control;
      ipcMain.removeHandler(input.channel);
      ipcMain.handle(input.channel, async (...args) => {
        const result = await original(...args);
        if (!input.kind || (args[1] as { kind?: string }).kind === input.kind) {
          control.entered = true;
          await gate;
        }
        return result;
      });
    },
    { channel, kind },
  );
}
async function waitForGate(harness: DesktopHarness) {
  await expect
    .poll(() =>
      harness.electronApp.evaluate(
        () =>
          (globalThis as typeof globalThis & { workbenchReplyGate?: { entered: boolean } })
            .workbenchReplyGate?.entered,
      ),
    )
    .toBe(true);
}
async function releaseGate(harness: DesktopHarness) {
  await harness.electronApp.evaluate(() =>
    (
      globalThis as typeof globalThis & { workbenchReplyGate?: { release: () => void } }
    ).workbenchReplyGate?.release(),
  );
}

test("cancelling while a file read is pending prevents the delayed file-tab mutation", async () => {
  const workspace = await makeWorkspace("agent-file-cancel");
  await writeFile(join(workspace, "late.txt"), "A cancelled open must not show this");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Cancel pane action");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };
    await window.evaluate(() => {
      const api = (window as unknown as { piApp: PiDesktopApi }).piApp;
      api.onWorkbenchAgentRequest((request) => {
        (window as Window & { agentRequestId?: string }).agentRequestId = request.id;
      });
    });
    await holdReply(harness, "pi-gui:read-workspace-file");
    const pending = run(harness, target, { action: "open", tool: "files", path: "late.txt" });
    await waitForGate(harness);
    const id = await window.evaluate(
      () => (window as Window & { agentRequestId?: string }).agentRequestId!,
    );
    await harness.electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0].webContents.send("pi-gui:workbench-agent-cancel", id);
    }, id);
    await getDesktopState(window);
    await releaseGate(harness);
    expect((await pending).error).toContain("cancelled");
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);
    await expect(window.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
  } finally {
    await releaseGate(harness);
    await harness.close();
  }
});

test("opening a browser URL keeps its created page ID when a user selects another tab during the reply", async () => {
  const workspace = await makeWorkspace("agent-browser-selection");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Stable browser target");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };
    const first = await run(harness, target, { action: "open", tool: "browser" });
    const original = first.tabs.find((tab) => tab.url === "about:blank")!.id;
    await holdReply(harness, "pi-gui:browser-action", "new-tab");
    const pending = run(harness, target, {
      action: "open",
      tool: "browser",
      url: "http://127.0.0.1:1/new-page",
    });
    await waitForGate(harness);
    await window.getByTestId(`workbench-tab-${original}`).click();
    await expect(window.getByTestId(`workbench-tab-${original}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await releaseGate(harness);
    expect((await pending).error).toBeUndefined();
    const result = await run(harness, target, { action: "list" });
    expect(result.tabs.find((tab) => tab.id === original)?.url).toBe("about:blank");
    expect(
      result.tabs.some((tab) => tab.id !== original && tab.url === "http://127.0.0.1:1/new-page"),
    ).toBe(true);
  } finally {
    await releaseGate(harness);
    await harness.close();
  }
});
