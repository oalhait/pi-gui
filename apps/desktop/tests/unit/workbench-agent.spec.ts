import { WorkbenchAgentOwner } from "../../electron/platform/workbench-agent";
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
  await expect(pending).resolves.toEqual(state);
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
