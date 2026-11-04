import { runInNewContext } from "node:vm";
import { expect, test } from "@playwright/test";
import {
  isBrowserPasskeyEvent,
  watchPasskeyRequests,
  type BrowserPasskeyEvent,
} from "../../electron/platform/browser-passkey-watch";

/** Runs the watcher from its source text alone, as executeInMainWorld does, in a fake page. */
function fakePage() {
  const events: BrowserPasskeyEvent[] = [];
  const settle: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const page = runInNewContext(
    `
    globalThis.CredentialsContainer = class CredentialsContainer {
      get(options) { return new Promise((resolve, reject) => settle.push({ resolve, reject })); }
      create(options) { return new Promise((resolve, reject) => settle.push({ resolve, reject })); }
    };
    globalThis.PublicKeyCredential = class PublicKeyCredential {
      static getClientCapabilities() {
        return Promise.resolve({ hybridTransport: true, passkeyPlatformAuthenticator: true, conditionalGet: true });
      }
    };
    (${watchPasskeyRequests.toString()})((event) => events.push(event));
    ({ credentials: new CredentialsContainer(), PublicKeyCredential });
  `,
    { events, settle, Promise },
  ) as {
    credentials: {
      get(options?: unknown): Promise<unknown>;
      create(options?: unknown): Promise<unknown>;
    };
    PublicKeyCredential: { getClientCapabilities(): Promise<Record<string, boolean>> };
  };
  return { ...page, events, settle };
}

test("interactive passkey requests report start and outcome and pass their result through", async () => {
  const page = fakePage();
  const publicKey = { challenge: new Uint8Array(1) };
  const signedIn = page.credentials.get({ publicKey });
  expect(page.events).toEqual(["waiting"]);
  page.settle[0]!.resolve("credential");
  await expect(signedIn).resolves.toBe("credential");
  expect(page.events).toEqual(["waiting", "done"]);

  const refused = page.credentials.create({ publicKey });
  page.settle[1]!.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
  await expect(refused).rejects.toMatchObject({ name: "NotAllowedError" });
  const aborted = page.credentials.get({ publicKey });
  page.settle[2]!.reject(Object.assign(new Error("abort"), { name: "AbortError" }));
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  expect(page.events).toEqual(["waiting", "done", "waiting", "failed", "waiting", "done"]);
  expect(page.credentials.get.name).toBe("get");
});

test("autofill, silent and password requests never raise the passkey hint", () => {
  const page = fakePage();
  page.credentials.get({ mediation: "conditional", publicKey: {} }).catch(() => undefined);
  page.credentials.get({ mediation: "silent", publicKey: {} }).catch(() => undefined);
  page.credentials.get({ mediation: "immediate", publicKey: {} }).catch(() => undefined);
  page.credentials.get({ password: true }).catch(() => undefined);
  expect(page.events).toEqual([]);
  expect(page.settle).toHaveLength(4);
});

test("capabilities stop advertising phone and platform passkeys and keep the rest", async () => {
  const page = fakePage();
  expect(await page.PublicKeyCredential.getClientCapabilities()).toEqual({
    hybridTransport: false,
    passkeyPlatformAuthenticator: false,
    conditionalGet: true,
  });
});

test("only the known passkey events are accepted from a page", () => {
  for (const value of ["waiting", "done", "failed"])
    expect(isBrowserPasskeyEvent(value)).toBe(true);
  for (const value of ["", "open", 1, null, { event: "waiting" }])
    expect(isBrowserPasskeyEvent(value)).toBe(false);
});
