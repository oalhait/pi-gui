import { expect, test } from "@playwright/test";
import { browserUrl, browserShortcut, isBrowserNavigationAllowed } from "../../contracts/browser";

test("browser addresses accept web URLs and localhost, and search plain text", () => {
  expect(browserUrl("localhost:3000/demo")).toBe("http://localhost:3000/demo");
  expect(browserUrl("https://example.com/test")).toBe("https://example.com/test");
  expect(browserUrl("example.com")).toBe("https://example.com/");
  expect(browserUrl("example.com:8443/path")).toBe("https://example.com:8443/path");
  expect(browserUrl("some search terms")).toBe("https://duckduckgo.com/?q=some%20search%20terms");
  expect(browserUrl("")).toBe("about:blank");
});
test("browser navigation denies privileged schemes and credential-bearing URLs", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,test",
    "pi-extension://secret",
    "https://name:password@example.com/",
  ]) {
    expect(() => browserUrl(url)).toThrow();
    expect(isBrowserNavigationAllowed(url)).toBe(false);
  }
  expect(isBrowserNavigationAllowed("about:blank")).toBe(true);
  expect(isBrowserNavigationAllowed("http://127.0.0.1:3000/")).toBe(true);
});

test("browser shortcuts stay scoped to unmodified platform chords", () => {
  const input = {
    platform: "darwin",
    key: "t",
    meta: true,
    control: false,
    alt: false,
    shift: false,
  };
  expect(browserShortcut(input)).toBe("new-tab");
  expect(browserShortcut({ ...input, key: "[" })).toBe("back");
  expect(browserShortcut({ ...input, key: "l" })).toBe("focus-address");
  expect(browserShortcut({ ...input, shift: true })).toBeUndefined();
  expect(browserShortcut({ ...input, alt: true })).toBeUndefined();
  expect(browserShortcut({ ...input, meta: false, control: true })).toBeUndefined();
  expect(browserShortcut({ ...input, platform: "win32", meta: false, control: true })).toBe(
    "new-tab",
  );
});
