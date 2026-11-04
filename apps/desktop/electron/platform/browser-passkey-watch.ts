/** What a browser page's WebAuthn request did, as reported to the browser owner. */
export type BrowserPasskeyEvent = "waiting" | "done" | "failed";

export const BROWSER_PASSKEY_CHANNEL = "pi-browser:passkey";

export function isBrowserPasskeyEvent(value: unknown): value is BrowserPasskeyEvent {
  return value === "waiting" || value === "done" || value === "failed";
}

/**
 * Runs in a browser page's main world before its scripts. Electron 43 has no WebAuthn request
 * events and shows no WebAuthn UI, so a passkey request can wait forever with nothing on screen.
 * This reports when an interactive request starts and how it ends; the request itself, its
 * options and its result pass through unchanged. It also stops advertising authenticators this
 * browser cannot reach, so sites can offer their other sign-in options.
 *
 * Serialized into the page by `contextBridge.executeInMainWorld`, so it must not reference
 * anything outside its own body.
 */
interface PasskeyRequestOptions {
  readonly mediation?: string;
  readonly publicKey?: unknown;
}
type CredentialCall = (this: unknown, options?: PasskeyRequestOptions) => Promise<unknown>;
/** The parts of a page's globals the watcher touches; the main process has no DOM types. */
interface PasskeyPage {
  readonly CredentialsContainer?: { readonly prototype: Record<"get" | "create", CredentialCall> };
  readonly PublicKeyCredential?: {
    getClientCapabilities?: (this: unknown) => Promise<Record<string, boolean>>;
  };
}

export function watchPasskeyRequests(report: (event: BrowserPasskeyEvent) => void): void {
  const page = globalThis as unknown as PasskeyPage;
  const container = page.CredentialsContainer?.prototype;
  const credential = page.PublicKeyCredential;
  if (!container || !credential) return;
  const wrap = (name: "get" | "create") => {
    const original = container[name];
    const wrapped = {
      [name](this: unknown, options?: PasskeyRequestOptions) {
        const result = original.call(this, options);
        const mediation = options?.mediation;
        // Conditional (autofill) and silent/immediate requests never show UI in any browser.
        if (
          !options?.publicKey ||
          mediation === "conditional" ||
          mediation === "silent" ||
          mediation === "immediate"
        )
          return result;
        report("waiting");
        result.then(
          () => report("done"),
          (error: unknown) =>
            report((error as { name?: unknown } | null)?.name === "AbortError" ? "done" : "failed"),
        );
        return result;
      },
    }[name];
    Object.defineProperty(container, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapped,
    });
  };
  wrap("get");
  wrap("create");
  const capabilities = credential.getClientCapabilities;
  if (typeof capabilities === "function")
    Object.defineProperty(credential, "getClientCapabilities", {
      configurable: true,
      writable: true,
      value: function getClientCapabilities(this: unknown) {
        // Electron reports phone (hybrid) and platform passkeys although it serves neither.
        return capabilities.call(this).then((value) =>
          Object.assign({}, value, {
            hybridTransport: false,
            passkeyPlatformAuthenticator: false,
          }),
        );
      },
    });
}
