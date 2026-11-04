import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopIpc } from "../../contracts/ipc";
import { expect, test, type Page } from "@playwright/test";
import {
  chooseNewWorkbenchTab,
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

let server: Server;
let base: string;
const slowResponses: ServerResponse[] = [];
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect-file") {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      res.end();
      return;
    }
    if (req.url === "/slow") {
      slowResponses.push(res);
      return;
    }
    if (req.url === "/login")
      res.setHeader("Set-Cookie", "browser_login=present; Path=/; Max-Age=3600");
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<title>Browser ${req.url}</title><h1>${req.url}</h1><p>${req.headers.cookie ?? "signed out"}</p><a href="/second">Next page</a><a href="/popup" target="_blank">Popup</a><a href="file:///etc/passwd">Blocked file link</a><button onclick="window.open('file:///etc/passwd')">Blocked popup</button><iframe src="file:///etc/passwd"></iframe>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function openBrowser(window: Page) {
  if (!(await window.getByTestId("workbench").isVisible()))
    await window.getByTestId("toggle-side-panel").click();
  await chooseNewWorkbenchTab(window, "Browser");
}

async function nativeState(harness: DesktopHarness) {
  return harness.electronApp.evaluate(async ({ webContents, BrowserWindow }) => {
    const pages = webContents
      .getAllWebContents()
      .filter((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
    return Promise.all(
      pages.map(async (contents) => ({
        url: contents.getURL(),
        text: (await contents.executeJavaScript('document.body?.innerText ?? ""')) as string,
        privileges: (await contents.executeJavaScript(
          "[typeof require, typeof process, typeof window.piApp]",
        )) as string[],
        visible: BrowserWindow.getAllWindows().some((window) =>
          window.contentView.children.some(
            (view) => "webContents" in view && view.webContents === contents && view.getVisible(),
          ),
        ),
      })),
    );
  });
}

test("browser pages share the top-level tool row, isolate chats and restore logins", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("native-browser");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Browser Alpha");
    await openBrowser(window);
    await expect(window.getByRole("tablist", { name: "Browser tabs" })).toHaveCount(0);
    const address = window.getByRole("textbox", { name: "Browser address" });
    await address.fill(`${base}/login`);
    await address.press("Enter");
    await expect
      .poll(
        async () => (await nativeState(first)).find((page) => page.url === `${base}/login`)?.text,
      )
      .toContain("/login");
    const page = (await nativeState(first)).find((entry) => entry.url === `${base}/login`)!;
    expect(page.privileges).toEqual(["undefined", "undefined", "undefined"]);
    const browserPage = first.electronApp
      .context()
      .pages()
      .find((page) => page.url() === `${base}/login`);
    expect(browserPage).toBeDefined();
    await address.fill("A draft before following a link");
    await browserPage!.getByRole("link", { name: "Next page", exact: true }).click();
    await expect(address).toHaveValue(`${base}/second`);
    await expect(window.getByRole("button", { name: "Browser back", exact: true })).toBeEnabled();
    await address.fill("A draft before going back");
    await window.getByRole("button", { name: "Browser back", exact: true }).click();
    await expect(address).toHaveValue(`${base}/login`);
    await window.getByRole("button", { name: "Browser forward", exact: true }).click();
    await expect(address).toHaveValue(`${base}/second`);
    await window.getByRole("tab", { name: "Review", exact: true }).click();
    await expect
      .poll(async () => (await nativeState(first)).some((page) => page.visible))
      .toBe(false);
    await expect(window.getByRole("tab", { name: "Browser /second", exact: true })).toBeVisible();
    await window.getByRole("tab", { name: "Browser /second", exact: true }).click();
    await expect(address).toHaveValue(`${base}/second`);
    const secondPage = first.electronApp
      .context()
      .pages()
      .find((page) => page.url() === `${base}/second`)!;
    await secondPage.getByRole("link", { name: "Popup", exact: true }).click();
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(2);
    await expect(address).toHaveValue(`${base}/popup`);
    await expect
      .poll(
        async () =>
          (await nativeState(first)).find((page) => page.url === `${base}/popup`)?.privileges,
      )
      .toEqual(["undefined", "undefined", "undefined"]);
    await window.getByRole("button", { name: "Close Browser /popup tab", exact: true }).click();
    await address.focus();
    await first.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "t",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(2);
    await address.fill("file:///etc/passwd");
    await address.press("Enter");
    await expect(window.getByRole("alert")).toContainText("HTTP");
    await createNamedThread(window, "Browser Bravo");
    await openBrowser(window);
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(1);
    await expect(address).toHaveValue("");
    await address.fill(`${base}/bravo`);
    await address.press("Enter");
    await expect
      .poll(async () =>
        (await nativeState(first)).filter((page) => page.visible).map((page) => page.url),
      )
      .toEqual([`${base}/bravo`]);
    await selectSession(window, "Browser Alpha");
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(2);
    await window.getByRole("tab", { name: "Browser /second", exact: true }).click();
    await expect
      .poll(async () =>
        (await nativeState(first)).filter((page) => page.visible).map((page) => page.url),
      )
      .toEqual([`${base}/second`]);
    await first.electronApp.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
      contents?.focus();
      contents?.sendInputEvent({
        type: "keyDown",
        keyCode: "k",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    }, `${base}/second`);
    await expect
      .poll(async () => (await nativeState(first)).some((page) => page.visible))
      .toBe(false);
    const palette = window.getByRole("dialog");
    await expect(palette).toBeVisible();
    const search = palette.getByRole("combobox");
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect
      .poll(async () => (await nativeState(first)).some((page) => page.visible))
      .toBe(true);
    await window.getByTestId("toggle-side-panel").click();
    await expect
      .poll(async () => (await nativeState(first)).some((page) => page.visible))
      .toBe(false);
    await window.getByTestId("toggle-side-panel").click();
    await expect
      .poll(async () => (await nativeState(first)).some((page) => page.visible))
      .toBe(true);
  } finally {
    await first.close();
  }
  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    await selectSession(window, "Browser Alpha");
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(2);
    await expect
      .poll(
        async () => (await nativeState(second)).find((page) => page.url === `${base}/second`)?.text,
      )
      .toContain("browser_login=present");
    for (let index = 2; index < 32; index++) await openBrowser(window);
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(32);
    await window.getByRole("tab", { name: "Browser /second", exact: true }).click();
    await window.getByRole("textbox", { name: "Browser address" }).focus();
    await second.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "t",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    await expect(window.getByTestId("browser-panel").getByRole("status")).toContainText(
      "Close a browser tab",
    );
    await expect
      .poll(async () => (await nativeState(second)).some((page) => page.visible))
      .toBe(true);
    await window.getByRole("button", { name: "Close New tab tab", exact: true }).last().click();
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(31);
    await expect(
      window.getByText("Close a browser tab before opening another.", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await nativeState(second)).some((page) => page.visible))
      .toBe(true);
  } finally {
    await second.close();
  }
});

test("restoring a slow tab preserves its saved destination when another tab finishes", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-slow-restore");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  let key = "";
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Slow browser restore");
    const state = await getDesktopState(window);
    key = JSON.stringify([state.selectedWorkspaceId, state.selectedSessionId]);
  } finally {
    await first.close();
  }
  const savedPath = join(userDataDir, "browser-tabs.json");
  await writeFile(
    savedPath,
    JSON.stringify({ [key]: { urls: [`${base}/slow`, `${base}/second`], active: 1 } }),
  );
  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    await openBrowser(window);
    await expect.poll(() => slowResponses.length).toBeGreaterThan(0);
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(
      `${base}/second`,
    );
    await openBrowser(window);
    await expect
      .poll(async () => {
        const saved = JSON.parse(await readFile(savedPath, "utf8")) as Record<
          string,
          { urls: string[] }
        >;
        return saved[key]?.urls;
      })
      .toEqual([`${base}/slow`, `${base}/second`, "about:blank"]);
  } finally {
    for (const response of slowResponses.splice(0)) response.end("<title>Slow page</title>Done");
    await second.close();
  }
});

test("web pages cannot open privileged pages, access the app, or gain site permissions", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-security");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser boundary");
    await openBrowser(window);
    const address = window.getByRole("textbox", { name: "Browser address" });
    await address.fill(`${base}/hostile`);
    await address.press("Enter");
    await expect
      .poll(
        async () =>
          (await nativeState(harness)).find((page) => page.url === `${base}/hostile`)?.text,
      )
      .toContain("/hostile");
    const page = harness.electronApp
      .context()
      .pages()
      .find((entry) => entry.url() === `${base}/hostile`)!;
    expect(
      await page.evaluate(() =>
        navigator.permissions.query({ name: "geolocation" }).then((permission) => permission.state),
      ),
    ).toBe("denied");
    await page.getByRole("button", { name: "Blocked popup", exact: true }).click();
    await expect(
      window
        .getByRole("tablist", { name: "Workspace tools" })
        .getByRole("tab")
        .filter({ hasNotText: "Review" }),
    ).toHaveCount(1);
    await page.getByRole("link", { name: "Blocked file link", exact: true }).click();
    expect(page.frames().some((frame) => frame.url().startsWith("file:"))).toBe(false);
    expect(
      (await nativeState(harness)).every((entry) =>
        entry.privileges.every((value) => value === "undefined"),
      ),
    ).toBe(true);
    await address.fill(`${base}/redirect-file`);
    await address.press("Enter");
    await expect(window.getByRole("alert")).toBeVisible();
    expect(
      await harness.electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((entry) => entry.getURL() === "file:///etc/passwd"),
      ),
    ).toBe(false);
    await address.fill(`${base}/second`);
    await address.press("Enter");
    await expect
      .poll(
        async () =>
          (await nativeState(harness)).find((entry) => entry.url === `${base}/second`)?.text,
      )
      .toContain("/second");
  } finally {
    await harness.close();
  }
});

test("a delayed browser action response cannot replace newer tabs or a typed address", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-response-order");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser response order");
    await openBrowser(window);
    const tabs = window.getByRole("tablist", { name: "Workspace tools" });
    await window.getByRole("button", { name: "Close Review tab", exact: true }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await harness.electronApp.evaluate(({ ipcMain }, channel) => {
      type Handler = (...args: unknown[]) => unknown;
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get(channel);
      if (!original) throw new Error("Missing browser handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const control = { entered: false, release };
      (
        globalThis as typeof globalThis & { browserResponseGate?: typeof control }
      ).browserResponseGate = control;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args);
        if ((args[1] as { kind?: string }).kind === "select-tab") {
          control.entered = true;
          await gate;
        }
        return result;
      });
    }, desktopIpc.browserAction);
    await tabs.getByRole("tab").first().click();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { browserResponseGate?: { entered: boolean } })
              .browserResponseGate?.entered,
        ),
      )
      .toBe(true);
    await openBrowser(window);
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    const address = window.getByRole("textbox", { name: "Browser address" });
    await address.fill("A draft address");
    await harness.electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & { browserResponseGate?: { release: () => void } }
      ).browserResponseGate?.release(),
    );
    await getDesktopState(window);
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(address).toHaveValue("A draft address");
  } finally {
    await harness.close();
  }
});

test("closing the last browser page leaves other tools intact and reopens a fresh page", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-last-page");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Close browser pages");
    await openBrowser(window);
    await window.getByRole("textbox", { name: "Browser address" }).fill(`${base}/closing`);
    await window.getByRole("button", { name: "Open address", exact: true }).click();
    await expect(window.getByRole("tab", { name: "Browser /closing", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Close Browser /closing tab", exact: true }).click();
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(1);
    await expect(window.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => nativeState(harness)).toEqual([]);
    await openBrowser(window);
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue("");
    await expect(window.getByRole("tablist", { name: "Browser tabs" })).toHaveCount(0);
    await openBrowser(window);
    const modifier = process.platform === "darwin" ? "Control" : "Alt";
    await window.keyboard.press(`${modifier}+2`);
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab").nth(1),
    ).toHaveAttribute("aria-selected", "true");
    await window.getByRole("tab", { name: "Review", exact: true }).click();
    await window.getByRole("button", { name: "Close New tab tab", exact: true }).last().click();
    await expect(window.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await window.keyboard.press(`${modifier}+2`);
    await expect(window.getByRole("textbox", { name: "Browser address" })).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("closing browser and other tool tabs selects and focuses the same flat-row neighbor", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-neighbors");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser neighbors");
    await openBrowser(window);
    const address = window.getByRole("textbox", { name: "Browser address" });
    await address.fill(`${base}/neighbor`);
    await window.getByRole("button", { name: "Open address", exact: true }).click();
    const pageTab = window.getByRole("tab", { name: "Browser /neighbor", exact: true });
    await expect(pageTab).toBeVisible();
    await openBrowser(window);
    await window.getByRole("button", { name: "Add tab", exact: true }).click();
    await window.getByRole("menuitem", { name: "New terminal" }).click();
    const terminal = window.locator('[role="tab"][data-testid^="workbench-tab-terminal:"]');
    await expect(terminal).toHaveAttribute("aria-selected", "true");
    await window.getByRole("tab", { name: "New tab", exact: true }).click();
    await window.getByRole("button", { name: "Close New tab tab", exact: true }).click();
    await expect(terminal).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        window.evaluate(() => {
          const focused = document.activeElement;
          return (
            Boolean(focused?.getAttribute("data-testid")?.startsWith("workbench-tab-terminal:")) ||
            Boolean(focused?.closest('[data-testid="integrated-terminal"]'))
          );
        }),
      )
      .toBe(true);
    await terminal.locator("..").locator(".workbench__tab-close").click();
    await expect(pageTab).toHaveAttribute("aria-selected", "true");
    await expect(pageTab).toBeFocused();
    await openBrowser(window);
    await window.getByRole("tab", { name: "Review", exact: true }).click();
    await window.getByRole("button", { name: "Close Review tab", exact: true }).click();
    await expect(pageTab).toHaveAttribute("aria-selected", "true");
    await expect(pageTab).toBeFocused();
  } finally {
    await harness.close();
  }
});

test("the native page leaves the side panel resize handle reachable along its full height", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-resize-handle");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser resize handle");
    await openBrowser(window);
    await window.getByRole("textbox", { name: "Browser address" }).fill(`${base}/resize`);
    await window.getByRole("button", { name: "Open address", exact: true }).click();
    await expect(window.getByRole("tab", { name: "Browser /resize", exact: true })).toBeVisible();
    const handle = window.getByRole("separator", { name: "Side panel width" });
    const pageBounds = () =>
      harness.electronApp.evaluate(({ BrowserWindow, webContents }) => {
        const page = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().endsWith("/resize"));
        for (const owner of BrowserWindow.getAllWindows())
          for (const view of owner.contentView.children)
            if ("webContents" in view && view.webContents === page && view.getVisible())
              return view.getBounds();
        return null;
      });
    // The native page paints above the DOM, so any overlap would swallow the handle's pointer.
    const expectClearOfHandle = async () => {
      await expect
        .poll(async () => {
          const box = await handle.boundingBox();
          const bounds = await pageBounds();
          return Boolean(box && bounds && bounds.width > 0 && bounds.x >= box.x + box.width);
        })
        .toBe(true);
    };
    await expectClearOfHandle();

    const box = (await handle.boundingBox())!;
    const startWidth = (await window.getByTestId("workbench").boundingBox())!.width;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await window.mouse.down();
    await window.mouse.move(box.x - 60, box.y + box.height * 0.75, { steps: 4 });
    await window.mouse.up();
    await expect
      .poll(async () => (await window.getByTestId("workbench").boundingBox())!.width)
      .toBeGreaterThan(startWidth + 40);
    await expectClearOfHandle();
  } finally {
    await harness.close();
  }
});
