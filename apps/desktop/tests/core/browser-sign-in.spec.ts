import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  type DesktopHarness,
} from "../helpers/electron-app";

// Two origins on one server: the "app" (127.0.0.1) and the "identity provider" (localhost),
// so the sign-in popup crosses origins like Notion → accounts.google.com → Notion.
let server: Server;
let app: string;
let idp: string;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    res.setHeader("Content-Type", "text/html");
    if (url.pathname === "/app") {
      res.end(`<title>Sign-in app</title><h1>Signed out</h1>
<button onclick="window.open('${idp}/passkey', 'oauth', 'popup')">Continue with passkey</button>
<button onclick="window.open('${idp}/oauth?redirect=${encodeURIComponent(`${app}/callback`)}', 'oauth', 'popup,width=480,height=640')">Continue with provider</button>
<script>
addEventListener('message', (event) => {
  if (event.origin === location.origin && event.data === 'signed-in') document.querySelector('h1').textContent = 'Signed in via popup';
});
</script>`);
      return;
    }
    if (url.pathname === "/oauth") {
      res.end(
        `<title>Provider</title><a href="${url.searchParams.get("redirect")}">Approve</a><p id=opener></p><script>document.getElementById('opener').textContent = 'provider opener: ' + Boolean(window.opener)</script>`,
      );
      return;
    }
    if (url.pathname === "/callback") {
      res.end(`<title>Callback</title><p id=state></p><script>
const opener = window.opener;
document.getElementById('state').textContent = 'callback opener: ' + Boolean(opener);
if (opener) { opener.postMessage('signed-in', location.origin); setTimeout(() => window.close(), 50); }
</script>`);
      return;
    }
    if (url.pathname === "/passkey") {
      // Like Google's account-passkey challenge: asks for a passkey as soon as it loads.
      res.end(`<title>Passkey challenge</title><p id=result>waiting</p><a href="/other">Try another way</a>
<button id=autofill onclick="navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: new Uint8Array(32) } })">Autofill</button>
<script>
if (!new URL(location.href).searchParams.has('manual'))
  navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required' } })
    .then(() => { document.getElementById('result').textContent = 'resolved'; }, (error) => { document.getElementById('result').textContent = error.name; });
</script>`);
      return;
    }
    res.end("<title>Other</title><p>Other sign-in options</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  app = `http://127.0.0.1:${address.port}`;
  idp = `http://localhost:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function openBrowserAt(window: Page, url: string) {
  if (!(await window.getByTestId("workbench").isVisible()))
    await window.getByTestId("toggle-side-panel").click();
  const chooser = window.getByTestId("workbench-chooser");
  if (!(await chooser.isVisible()))
    await window.getByRole("button", { name: "Add tab", exact: true }).click();
  // The tool chooser, or the Add tab menu where the tab row has one.
  await chooser
    .getByRole("button", { name: "Browser", exact: true })
    .or(window.getByRole("menuitem", { name: "New browser page" }))
    .click();
  await navigate(window, url);
}

async function navigate(window: Page, url: string) {
  const address = window.getByRole("textbox", { name: "Browser address" });
  await address.fill(url);
  await address.press("Enter");
}

function browserPage(harness: DesktopHarness, prefix: string) {
  return harness.electronApp
    .context()
    .pages()
    .find((page) => page.url().startsWith(prefix));
}

function browserTabs(window: Page) {
  return window
    .getByRole("tablist", { name: "Workspace tools" })
    .getByRole("tab")
    .filter({ hasNotText: "Review" });
}

test("a cross-origin sign-in popup reports back to its opener, closes and returns to the opener tab", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-sign-in-popup");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser sign-in");
    await openBrowserAt(window, `${app}/app`);
    await expect.poll(() => browserPage(harness, `${app}/app`)).toBeDefined();
    const appPage = browserPage(harness, `${app}/app`)!;
    await appPage.getByRole("button", { name: "Continue with provider" }).click();
    await expect(browserTabs(window)).toHaveCount(2);
    await expect.poll(() => browserPage(harness, `${idp}/oauth`)).toBeDefined();
    const provider = browserPage(harness, `${idp}/oauth`)!;
    await expect(provider.locator("#opener")).toHaveText("provider opener: true");
    await provider.getByRole("link", { name: "Approve" }).click();
    await expect(appPage.locator("h1")).toHaveText("Signed in via popup");
    await expect(browserTabs(window)).toHaveCount(1);
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(
      `${app}/app`,
    );
  } finally {
    await harness.close();
  }
});

test("a passkey request in a sign-in popup shows a hint that opens the original page elsewhere", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-passkey-hint");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    await harness.electronApp.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { openedExternally?: string[] }).openedExternally = opened;
      shell.openExternal = (url: string) => {
        opened.push(url);
        return Promise.resolve();
      };
    });
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser passkey");
    await openBrowserAt(window, `${app}/app`);
    await expect.poll(() => browserPage(harness, `${app}/app`)).toBeDefined();
    await browserPage(harness, `${app}/app`)!
      .getByRole("button", { name: "Continue with passkey" })
      .click();
    await expect.poll(() => browserPage(harness, `${idp}/passkey`)).toBeDefined();
    const challenge = browserPage(harness, `${idp}/passkey`)!;
    const hint = window.getByRole("status", { name: "Passkey sign-in" });
    await expect(hint).toContainText("Passkeys aren’t available in pi-gui’s browser");
    await expect(hint).toContainText("Try another way");
    // Electron 43 never settles the request; the page is left waiting, not broken.
    await expect(challenge.locator("#result")).toHaveText("waiting");
    expect(
      await challenge.evaluate(async () => {
        const capabilities = await PublicKeyCredential.getClientCapabilities();
        return [
          capabilities.hybridTransport,
          capabilities.passkeyPlatformAuthenticator,
          navigator.credentials.get.name,
          typeof (window as { require?: unknown }).require,
          typeof (window as { piApp?: unknown }).piApp,
        ];
      }),
    ).toEqual([false, false, "get", "undefined", "undefined"]);
    await hint.getByRole("button", { name: "Open in default browser" }).click();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () => (globalThis as { openedExternally?: string[] }).openedExternally,
        ),
      )
      .toEqual([`${app}/app`]);
    await hint.getByRole("button", { name: "Dismiss passkey hint" }).click();
    await expect(hint).toHaveCount(0);

    // Following another sign-in option clears it, and autofill-style requests don't raise it.
    await navigate(window, `${idp}/passkey?manual`);
    await expect.poll(() => browserPage(harness, `${idp}/passkey?manual`)).toBeDefined();
    const manual = browserPage(harness, `${idp}/passkey?manual`)!;
    await manual.getByRole("button", { name: "Autofill" }).click();
    await manual.waitForTimeout(2_500);
    await expect(hint).toHaveCount(0);
    await manual.evaluate(() => {
      void navigator.credentials
        .create({
          publicKey: {
            rp: { name: "Test" },
            user: { id: new Uint8Array(8), name: "a", displayName: "a" },
            challenge: new Uint8Array(32),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        })
        .catch(() => undefined);
    });
    await expect(hint).toBeVisible();
    await manual.getByRole("link", { name: "Try another way" }).click();
    await expect(hint).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("sign-in support grants no site permissions", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("browser-sign-in-permissions");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Browser permissions");
    await openBrowserAt(window, `${idp}/passkey?manual`);
    await expect.poll(() => browserPage(harness, `${idp}/passkey?manual`)).toBeDefined();
    const page = browserPage(harness, `${idp}/passkey?manual`)!;
    expect(
      await page.evaluate(async () => {
        const states = await Promise.all(
          ["geolocation", "notifications", "camera", "microphone", "clipboard-read"].map((name) =>
            navigator.permissions.query({ name: name as PermissionName }).then(
              (status) => status.state,
              (error: Error) => error.name,
            ),
          ),
        );
        const hid = await (
          navigator as Navigator & { hid?: { requestDevice(o: unknown): Promise<unknown[]> } }
        ).hid
          ?.requestDevice({ filters: [] })
          .then(
            (devices) => `devices:${devices.length}`,
            (error: Error) => error.name,
          );
        return { states, notification: await Notification.requestPermission(), hid };
      }),
    ).toEqual({
      states: ["denied", "denied", "denied", "denied", "denied"],
      notification: "denied",
      hid: expect.not.stringMatching(/^devices:[1-9]/) as unknown as string,
    });
  } finally {
    await harness.close();
  }
});
