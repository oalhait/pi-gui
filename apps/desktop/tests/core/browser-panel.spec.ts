import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopIpc } from "../../contracts/ipc";
import { expect, test, type Page } from "@playwright/test";
import {
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
  await window.getByRole("button", { name: "Add tab", exact: true }).click();
  await window.getByRole("button", { name: "Browser", exact: true }).click();
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

test("native browser navigates, isolates pages, keeps tabs per chat and restores logins", async () => {
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
    const secondPage = first.electronApp
      .context()
      .pages()
      .find((page) => page.url() === `${base}/second`)!;
    await secondPage.getByRole("link", { name: "Popup", exact: true }).click();
    await expect(
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect(address).toHaveValue(`${base}/popup`);
    await expect
      .poll(
        async () =>
          (await nativeState(first)).find((page) => page.url === `${base}/popup`)?.privileges,
      )
      .toEqual(["undefined", "undefined", "undefined"]);
    await window
      .getByRole("button", { name: "Close browser tab Browser /popup", exact: true })
      .click();
    await address.focus();
    await first.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "t",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    await expect(
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
    ).toHaveCount(2);
    await address.fill("file:///etc/passwd");
    await address.press("Enter");
    await expect(window.getByRole("alert")).toContainText("HTTP");
    await createNamedThread(window, "Browser Bravo");
    await openBrowser(window);
    await expect(
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
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
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
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
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect
      .poll(
        async () => (await nativeState(second)).find((page) => page.url === `${base}/second`)?.text,
      )
      .toContain("browser_login=present");
    for (let index = 2; index < 32; index++)
      await window.getByRole("button", { name: "New browser tab", exact: true }).click();
    await expect(
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
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
    await window
      .getByRole("button", { name: "Close browser tab New tab", exact: true })
      .last()
      .click();
    await expect(
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
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
    await window.getByRole("button", { name: "New browser tab", exact: true }).click();
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
      window.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab"),
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
    const tabs = window.getByRole("tablist", { name: "Browser tabs" });
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
    await window.getByRole("button", { name: "New browser tab", exact: true }).click();
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
