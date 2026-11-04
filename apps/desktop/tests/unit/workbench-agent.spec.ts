import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  WorkbenchAgentOwner,
  createWorkbenchAgentExtension,
  createWorkbenchAgentTool,
} from "../../electron/platform/workbench-agent";
import { captureSize } from "../../electron/platform/workbench-capture";
import { normalizePageText, PAGE_TEXT_LIMITS } from "../../electron/platform/browser-page-text";
import { expect, test } from "@playwright/test";
import {
  decodeWorkbenchAgentCommand,
  decodeWorkbenchAgentResponse,
} from "../../contracts/workbench-agent";

test("workbench commands validate browser addresses and exact tab identities", () => {
  expect(
    decodeWorkbenchAgentCommand({
      action: "open",
      tool: "browser",
      url: "localhost:8765/home.html",
    }),
  ).toEqual({ action: "open", tool: "browser", url: "http://localhost:8765/home.html" });
  expect(decodeWorkbenchAgentCommand({ action: "close", tab_id: "browser:one" })).toEqual({
    action: "close",
    tab_id: "browser:one",
  });
  for (const input of [
    { action: "open", tool: "browser", url: "file:///etc/passwd" },
    { action: "close" },
    { action: "open", tool: "unknown" },
    { action: "navigate" },
    { action: "list", workspace_id: "other" },
  ])
    expect(() => decodeWorkbenchAgentCommand(input)).toThrow();
});

test("only open tool=terminal takes new, and only as a boolean", () => {
  expect(decodeWorkbenchAgentCommand({ action: "open", tool: "terminal", new: true })).toEqual({
    action: "open",
    tool: "terminal",
    new: true,
  });
  expect(decodeWorkbenchAgentCommand({ action: "open", tool: "files", path: "src/a.ts" })).toEqual({
    action: "open",
    tool: "files",
    path: "src/a.ts",
  });
  for (const input of [
    { action: "open", tool: "terminal", new: "true" },
    { action: "open", tool: "browser", new: true },
    { action: "list", new: true },
  ])
    expect(() => decodeWorkbenchAgentCommand(input)).toThrow(/new/);
});

test("acknowledgements carry one tab per file, page and terminal, up to 200", () => {
  const tabs = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `file:f${index}.ts`, title: `f${index}` })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `terminal:t${index}`, title: "zsh" })),
    ...Array.from({ length: 32 }, (_, index) => ({ id: `browser:p${index}`, title: "Page" })),
  ];
  expect(
    decodeWorkbenchAgentResponse({
      id: "request",
      state: { visible: true, selectedTabId: "terminal:t0", tabs },
    }).state?.tabs,
  ).toHaveLength(140);
  expect(() =>
    decodeWorkbenchAgentResponse({
      id: "request",
      state: {
        visible: true,
        selectedTabId: null,
        tabs: Array.from({ length: 201 }, (_, index) => ({ id: `file:${index}`, title: "x" })),
      },
    }),
  ).toThrow();
});

test("workbench actions only accept acknowledgements from the originating chat and window", async () => {
  type Window = import("electron").BrowserWindow;
  type Owner = import("../../electron/windows/window-owner").WindowOwner;
  type Request = import("../../electron/ipc/main-frame-ipc").MainFrameRequest;
  type Response = import("../../contracts/workbench-agent").WorkbenchAgentResponse;
  const sent: { channel: string; value: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, value: unknown) => sent.push({ channel, value }),
    },
  } as unknown as Window;
  const view = {
    activeView: "threads",
    selectedWorkspaceId: "workspace",
    selectedSessionId: "alpha",
  };
  const owner = new WorkbenchAgentOwner(
    () => ({ allWindows: () => [window], viewForWindow: () => view }) as unknown as Owner,
  );
  let respond!: (input: Response, sender: Window) => void;
  owner.register((_channel, decode, handler) => {
    respond = (input, sender) => {
      handler(decode(input), { window: sender } as Request);
    };
  });
  const target = { workspaceId: "workspace", sessionId: "alpha" };
  const pending = owner.execute(target, { action: "list" });
  const id = (sent[0].value as { id: string }).id;
  const state = { visible: false, selectedTabId: null, tabs: [] };
  respond({ id, state }, {} as Window);
  respond({ id, state }, window);
  await expect(pending).resolves.toEqual({ state });
  const switched = owner.execute(target, { action: "list" });
  const switchedId = (
    sent.filter((entry) => entry.channel.endsWith("request")).at(-1)!.value as { id: string }
  ).id;
  view.selectedSessionId = "bravo";
  respond({ id: switchedId, state }, window);
  await expect(switched).rejects.toThrow("selected chat changed");
  await expect(owner.execute(target, { action: "show" })).rejects.toThrow("Open this chat");
  view.selectedSessionId = "alpha";
  const controller = new AbortController();
  const cancelled = owner.execute(target, { action: "open", tool: "browser" }, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  expect(sent.at(-1)?.channel).toContain("cancel");
});

test("workbench acknowledgements require bounded tab metadata and a valid selection", () => {
  expect(
    decodeWorkbenchAgentResponse({
      id: "request",
      state: {
        visible: true,
        selectedTabId: "browser:one",
        tabs: [{ id: "browser:one", title: "Preview", url: "http://localhost:8765/" }],
      },
    }).state?.tabs,
  ).toHaveLength(1);
  for (const state of [
    { visible: "yes", selectedTabId: null, tabs: [] },
    { visible: true, selectedTabId: "missing", tabs: [] },
    { visible: true, selectedTabId: null, tabs: [{ id: "one", title: "x".repeat(201) }] },
  ])
    expect(() => decodeWorkbenchAgentResponse({ id: "request", state })).toThrow();
});

test("capture takes only an optional tab_id and resolves bounded capture targets", () => {
  expect(decodeWorkbenchAgentCommand({ action: "capture" })).toEqual({ action: "capture" });
  expect(decodeWorkbenchAgentCommand({ action: "capture", tab_id: "files" })).toEqual({
    action: "capture",
    tab_id: "files",
  });
  for (const input of [
    { action: "capture", tool: "browser" },
    { action: "capture", url: "https://example.com" },
    { action: "capture", path: "README.md" },
    { action: "capture", tab_id: "" },
  ])
    expect(() => decodeWorkbenchAgentCommand(input)).toThrow();
  const state = { visible: true, selectedTabId: "files", tabs: [{ id: "files", title: "Files" }] };
  expect(
    decodeWorkbenchAgentResponse({
      id: "request",
      state,
      capture: { kind: "browser", tabId: "browser:one", pageId: "one", selected: true },
    }).capture,
  ).toEqual({ kind: "browser", tabId: "browser:one", pageId: "one", selected: true });
  expect(
    decodeWorkbenchAgentResponse({
      id: "request",
      state,
      capture: {
        kind: "pane",
        tabId: "files",
        tool: "files",
        title: "Files",
        description: "Open file: notes.md",
        rect: { x: 600, y: 40, width: 420, height: 800 },
      },
    }).capture,
  ).toMatchObject({ kind: "pane", rect: { width: 420 } });
  for (const capture of [
    { kind: "browser", tabId: "browser:one", pageId: "one" },
    { kind: "window", tabId: "files" },
    {
      kind: "pane",
      tabId: "files",
      tool: "files",
      title: "Files",
      description: "",
      rect: { x: 0, y: 0, width: 0, height: 10 },
    },
    {
      kind: "pane",
      tabId: "files",
      tool: "files",
      title: "Files",
      description: "",
      rect: { x: 0, y: 0, width: Infinity, height: 10 },
    },
    { kind: "pane", tabId: "files", tool: "chat", title: "Files", description: "" },
  ])
    expect(() => decodeWorkbenchAgentResponse({ id: "request", state, capture })).toThrow();
});

test("captures are downscaled to a bounded longest edge without changing their aspect", () => {
  expect(captureSize(866, 1778)).toEqual({ width: 779, height: 1600 });
  expect(captureSize(3200, 1000)).toEqual({ width: 1600, height: 500 });
  expect(captureSize(800, 600)).toEqual({ width: 800, height: 600 });
});

test("capture results return the image to the model but keep it out of tool details", async () => {
  const tool = createWorkbenchAgentTool(() =>
    Promise.resolve({
      state: { visible: true, selectedTabId: null, tabs: [] },
      capture: {
        summary: { tab_id: "browser:one", url: "http://localhost:8765/", title: "Preview" },
        image: { data: "aW1hZ2U=", mimeType: "image/png", width: 10, height: 20 },
      },
    }),
  );
  const result = await tool.execute(
    "call",
    { action: "capture" },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        tab_id: "browser:one",
        url: "http://localhost:8765/",
        title: "Preview",
      }),
    },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  expect(JSON.stringify(result.details)).not.toContain("aW1hZ2U=");
});

test("workbench stays declared with its rules next to deferred tools and across extension reloads", async () => {
  // pi is ESM-only; the Playwright unit lane compiles specs to CommonJS.
  const {
    createAgentSession,
    createToolSearchExtension,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workbench-tools-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  let connectServer = () => {};
  // Stands in for an MCP server with deferred tools (like Slack) that connects after start.
  const deferredServer: ExtensionFactory = (pi) => {
    const register = (name: string) =>
      pi.registerTool({
        name,
        label: name,
        description: "Search Slack messages",
        exposure: "deferred",
        parameters: { type: "object", properties: {} },
        execute: () => Promise.resolve({ content: [], details: undefined }),
      });
    register("mcp__slack__search");
    connectServer = () => register("mcp__slack__read_thread");
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      { name: "tool-search", factory: createToolSearchExtension() },
      // The same name and gating shape pi-gui's driver gives its built-in extensions.
      {
        name: "pi-gui-workbench",
        factory: createWorkbenchAgentExtension(() => Promise.reject(new Error("unused"))),
      },
      { name: "slack-mcp", factory: deferredServer },
    ],
  });
  await loader.reload();
  settingsManager.applyOverrides({ defaultTools: ["+tool_search"] });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  });
  try {
    await session.bindExtensions({});
    const expectWorkbenchDeclared = () => {
      const active = session.getActiveToolNames();
      expect(active).toContain("workbench");
      expect(active).toContain("tool_search");
      expect(active.filter((name) => name.startsWith("mcp__"))).toEqual([]);
      const workbench = session.getAllTools().find((entry) => entry.name === "workbench");
      expect(workbench?.exposure).toBe("direct");
      expect(workbench?.promptGuidelines?.join("\n")).toContain("action=capture");
      expect(session.systemPrompt).toContain("workbench: see (capture) and control");
      expect(session.systemPrompt).toContain("call workbench action=capture");
    };
    expectWorkbenchDeclared();
    connectServer();
    expectWorkbenchDeclared();
    await session.reload();
    expectWorkbenchDeclared();
  } finally {
    session.dispose();
  }
});

test("read is a browser-only text view whose html format is opt-in", () => {
  expect(decodeWorkbenchAgentCommand({ action: "read", format: "html" })).toEqual({
    action: "read",
    format: "html",
  });
  for (const input of [
    { action: "read", tool: "browser" },
    { action: "read", format: "dom" },
    { action: "capture", format: "html" },
    { action: "list", format: "text" },
  ])
    expect(() => decodeWorkbenchAgentCommand(input)).toThrow();
});

test("page text from the page is rebuilt with known fields and hard caps", () => {
  const huge = "x".repeat(PAGE_TEXT_LIMITS.text + 50);
  const page = normalizePageText(
    {
      text: huge,
      headings: Array.from({ length: 80 }, () => ({ level: 9, text: "Heading", extra: "drop" })),
      links: [{ text: "Docs", href: "https://example.com/docs" }, "not a link"],
      fields: [
        { tag: "input", type: "email", name: "email", value: "a@b.c", disabled: false },
        { tag: "input", type: "checkbox", name: "agree", checked: true, script: "drop" },
      ],
      html: "<p>markup</p>",
      scroll: { y: 10.4, height: Infinity, viewport: "900" },
      injected: { secret: true },
    },
    false,
  );
  expect(page.text).toHaveLength(PAGE_TEXT_LIMITS.text);
  expect(page.text_truncated).toBe(true);
  expect(page.headings).toHaveLength(PAGE_TEXT_LIMITS.headings);
  expect(page.headings[0]).toEqual({ level: 6, text: "Heading" });
  expect(page.links).toEqual([
    { text: "Docs", href: "https://example.com/docs" },
    { text: "", href: "" },
  ]);
  expect(page.fields).toEqual([
    { tag: "input", type: "email", name: "email", value: "a@b.c" },
    { tag: "input", type: "checkbox", name: "agree", checked: true },
  ]);
  expect(page).not.toHaveProperty("html");
  expect(page).not.toHaveProperty("injected");
  expect(page.scroll).toEqual({ y: 10, height: 0, viewport: 0 });
  const html = normalizePageText({ html: "y".repeat(PAGE_TEXT_LIMITS.html + 1) }, true);
  expect(html.html).toHaveLength(PAGE_TEXT_LIMITS.html);
  expect(html.html_truncated).toBe(true);
  expect(normalizePageText("not an object", true)).toMatchObject({ text: "", links: [] });
});
