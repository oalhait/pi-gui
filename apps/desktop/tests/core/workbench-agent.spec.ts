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

type CaptureResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: Record<string, unknown> & { error?: string };
};
async function capture(harness: DesktopHarness, target: SessionRef, tabId?: string) {
  return harness.electronApp.evaluate(
    async (_electron, input) => {
      const hooks = (
        globalThis as typeof globalThis & {
          __PI_APP_TEST_HOOKS: { runWorkbenchRuntimeTool: (input: unknown) => Promise<unknown> };
        }
      ).__PI_APP_TEST_HOOKS;
      return hooks.runWorkbenchRuntimeTool(input);
    },
    { sessionRef: target, params: { action: "capture", ...(tabId ? { tab_id: tabId } : {}) } },
  ) as Promise<CaptureResult>;
}
/** Decodes the returned image in main and reports its size and the share of page-colored pixels. */
async function inspectImage(harness: DesktopHarness, result: CaptureResult) {
  const image = result.content.find((entry) => entry.type === "image");
  if (!image || image.type !== "image") return undefined;
  return harness.electronApp.evaluate(({ nativeImage }, input) => {
    const decoded = nativeImage.createFromDataURL(`data:${input.mimeType};base64,${input.data}`);
    const { width, height } = decoded.getSize();
    const bitmap = decoded.toBitmap();
    let magenta = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      // BGRA: the test page paints rgb(255, 0, 255).
      if (bitmap[index] > 200 && bitmap[index + 1] < 60 && bitmap[index + 2] > 200) magenta += 1;
    }
    return { width, height, mimeType: input.mimeType, magenta: magenta / (width * height) };
  }, image);
}

test("capture returns the browser page itself, read-only, and explains hidden or blank pages", async () => {
  const server = createServer((_req, res) =>
    res.end(
      "<title>Capture proof</title><body style='margin:0;background:rgb(255,0,255)'><h1>Pixels from the page</h1></body>",
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing test port");
  const url = `http://127.0.0.1:${port.port}/`;
  const workspace = await makeWorkspace("agent-capture");
  await writeFile(join(workspace, "notes.md"), "# Captured notes");
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Capture Alpha");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };
    const initial = await capture(harness, target);
    expect(initial.details).toMatchObject({ kind: "review", tab_id: "changes", image: null });
    expect(String(initial.details.note)).toContain("hidden");

    const blank = await run(harness, target, { action: "open", tool: "browser" });
    const blankId = blank.selectedTabId!;
    const blankCapture = await capture(harness, target);
    expect(blankCapture.content.some((entry) => entry.type === "image")).toBe(false);
    expect(blankCapture.details).toMatchObject({
      tab_id: blankId,
      url: "about:blank",
      image: null,
    });
    expect(String(blankCapture.details.note)).toContain("blank");

    await run(harness, target, { action: "navigate", tab_id: blankId, url });
    await expect
      .poll(
        async () =>
          (await run(harness, target, { action: "list" })).tabs.find((tab) => tab.id === blankId)
            ?.title,
      )
      .toBe("Capture proof");
    const page = await capture(harness, target);
    expect(page.details).toMatchObject({
      tab_id: blankId,
      kind: "browser",
      url,
      title: "Capture proof",
      loading: false,
      visible_to_user: true,
    });
    expect(page.details.note).toBeUndefined();
    const pixels = await inspectImage(harness, page);
    // The page's own pixels, not the pi-gui window chrome around it.
    expect(pixels?.magenta).toBeGreaterThan(0.85);
    expect(Math.max(pixels!.width, pixels!.height)).toBeLessThanOrEqual(1600);
    const viewport = page.details.viewport as { width: number; height: number };
    expect(viewport.width).toBeGreaterThan(0);
    expect(pixels!.width / pixels!.height).toBeCloseTo(viewport.width / viewport.height, 1);
    expect(JSON.stringify(page.details)).not.toContain(
      (page.content.find((entry) => entry.type === "image") as { data: string }).data.slice(0, 64),
    );

    // Hidden pane: still the page's pixels (it is captured from its own contents), clearly marked.
    await run(harness, target, { action: "hide" });
    const hidden = await capture(harness, target, blankId);
    expect(hidden.details).toMatchObject({ url, visible_to_user: false });
    expect(String(hidden.details.note)).toContain("not looking at this page");
    const hiddenPixels = await inspectImage(harness, hidden);
    expect(hiddenPixels?.magenta).toBeGreaterThan(0.85);
    // Capture is read-only: the pane stays hidden.
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    expect((await run(harness, target, { action: "list" })).visible).toBe(false);
    await run(harness, target, { action: "show" });

    // Covered by an app overlay: the native page view is hidden, and the result says so.
    await window.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.id = "capture-test-overlay";
      document.body.append(overlay);
    });
    await expect
      .poll(async () => (await capture(harness, target)).details.visible_to_user)
      .toBe(false);
    expect(String((await capture(harness, target)).details.note)).toContain("overlay");
    await window.evaluate(() => document.getElementById("capture-test-overlay")?.remove());

    // Other tools: the pane rectangle from the window, plus a text description.
    await run(harness, target, { action: "open", tool: "files", path: "notes.md" });
    await expect(window.getByTestId("file-workbench-preview")).toContainText("Captured notes");
    const files = await capture(harness, target);
    expect(files.details).toMatchObject({ kind: "files", tab_id: "files" });
    expect(String(files.details.description)).toContain("notes.md");
    const filePixels = await inspectImage(harness, files);
    expect(filePixels?.width).toBeGreaterThan(100);
    expect(filePixels?.magenta).toBeLessThan(0.05);
    // A non-selected pane tab is described but not selected or captured.
    const browserById = await capture(harness, target, blankId);
    expect(browserById.details).toMatchObject({ url, visible_to_user: false });
    expect((await run(harness, target, { action: "list" })).selectedTabId).toBe("files");
    const listedTerminal = await run(harness, target, { action: "open", tool: "terminal" });
    expect(listedTerminal.selectedTabId).toBe("terminal");
    const filesById = await capture(harness, target, "files");
    expect(filesById.content.some((entry) => entry.type === "image")).toBe(false);
    expect(String(filesById.details.note)).toContain("not the selected");
    expect((await capture(harness, target, "missing")).details.error).toContain("Unknown tab_id");

    // A failed page reports its error instead of a blank or stale image.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await run(harness, target, {
      action: "open",
      tool: "browser",
      url: `http://127.0.0.1:${closedPort}/`,
    });
    await expect
      .poll(async () => (await capture(harness, target)).details.error)
      .toContain("Couldn't load page");
    const failed = await capture(harness, target);
    expect(failed.content.some((entry) => entry.type === "image")).toBe(false);
    expect(String(failed.details.note)).toContain("failed to load");

    // Only this chat's pane.
    await createNamedThread(window, "Capture Bravo");
    expect((await capture(harness, target)).details.error).toContain("Open this chat");
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("read returns a bounded text view of the page from an isolated world", async () => {
  const page = `<title>Signup form</title>
<script>
  // Page scripts cannot change what the isolated read sees, or see it run.
  document.querySelectorAll = () => [];
  Object.defineProperty(HTMLElement.prototype, "innerText", { get: () => "tampered" });
</script>
<body>
<h1>Create account</h1><h2>Plans</h2>
<p>Starter plan includes ${"many words ".repeat(2000)}</p>
<a href="/terms">Terms of service</a><a href="https://example.com/help" style="display:none">Hidden help</a>
<label>Email <input name="email" value="user@example.com"></label>
<label>Password <input type="password" name="password" value="hunter2"></label>
<input type="hidden" name="csrf" value="secret-token">
<label><input type="checkbox" name="agree" checked> Agree</label>
<select name="plan"><option>Starter</option><option selected>Pro</option></select>
<button type="submit">Sign up</button>
</body>`;
  const server = createServer((_req, res) => res.end(page));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing test port");
  const url = `http://127.0.0.1:${port.port}/`;
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("agent-read")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Read Alpha");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };
    const read = async (params: Record<string, string>) =>
      (await harness.electronApp.evaluate(
        async (_electron, input) =>
          (
            globalThis as typeof globalThis & {
              __PI_APP_TEST_HOOKS: {
                runWorkbenchRuntimeTool: (input: unknown) => Promise<unknown>;
              };
            }
          ).__PI_APP_TEST_HOOKS.runWorkbenchRuntimeTool(input),
        { sessionRef: target, params: { action: "read", ...params } },
      )) as CaptureResult;
    expect((await read({})).details.error).toContain("browser tabs only");
    const opened = await run(harness, target, { action: "open", tool: "browser" });
    const tabId = opened.selectedTabId!;
    expect(String((await read({})).details.note)).toContain("blank");
    await run(harness, target, { action: "navigate", tab_id: tabId, url });
    await expect.poll(async () => (await read({})).details.title).toBe("Signup form");

    const result = await read({});
    expect(result.content).toHaveLength(1);
    const details = result.details as Record<string, unknown> & {
      text: string;
      headings: unknown[];
      links: { text: string; href: string }[];
      fields: Record<string, unknown>[];
    };
    expect(details).toMatchObject({ tab_id: tabId, url, kind: "browser", text_truncated: true });
    expect(details.text).toContain("Create account");
    expect(details.text).not.toContain("tampered");
    expect(details.text.length).toBeLessThanOrEqual(12_000);
    expect(details.headings).toEqual([
      { level: 1, text: "Create account" },
      { level: 2, text: "Plans" },
    ]);
    expect(details.links).toEqual([{ text: "Terms of service", href: `${url}terms` }]);
    expect(details.fields).toEqual([
      { tag: "input", type: "text", name: "email", label: "Email", value: "user@example.com" },
      { tag: "input", type: "password", name: "password", label: "Password" },
      { tag: "input", type: "checkbox", name: "agree", label: "Agree", checked: true },
      { tag: "select", type: "select", name: "plan", value: "Pro" },
      { tag: "button", type: "submit", value: "Sign up" },
    ]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(details).not.toHaveProperty("html");

    const html = (await read({ format: "html" })).details;
    expect(String(html.html)).toContain("<h1>Create account</h1>");
    expect(String(html.html).length).toBeLessThanOrEqual(60_000);

    // The extraction left nothing behind in the page's own world.
    const pageGlobals = await harness.electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === url)!;
      return (await contents.executeJavaScript(
        "[typeof piApp, typeof require, Object.keys(window).filter((key) => key.startsWith('__pi')).length]",
      )) as unknown[];
    }, url);
    expect(pageGlobals).toEqual(["undefined", "undefined", 0]);

    // Read is read-only and scoped to this chat.
    await run(harness, target, { action: "hide" });
    expect((await read({ tab_id: tabId })).details).toMatchObject({ visible_to_user: false });
    expect((await run(harness, target, { action: "list" })).visible).toBe(false);
    await createNamedThread(window, "Read Bravo");
    expect((await read({ tab_id: tabId })).details.error).toContain("Open this chat");
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
