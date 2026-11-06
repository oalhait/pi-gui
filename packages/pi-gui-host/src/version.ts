import { readFileSync } from "node:fs";

/** This package's version; also what pi-gui compares to decide whether to update the host. */
export const HOST_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Written into the bundle pi-gui installs (`bundle-id` beside `dist`); absent in a checkout. */
export const HOST_BUNDLE_ID: string | undefined = (() => {
  try {
    return readFileSync(new URL("../bundle-id", import.meta.url), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
})();
