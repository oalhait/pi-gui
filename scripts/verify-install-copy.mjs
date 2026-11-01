import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function main() {
  const [readme, siteMetadata, websitePage] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "site.ts"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "page.tsx"), "utf8"),
  ]);

  assert.match(readme, /macOS arm64 ZIP/);
  assert.match(readme, /https:\/\/github.com\/oalhait\/pi-gui\/releases/);
  assert.match(readme, /not Apple-notarized/);
  assert.match(readme, /does not currently publish Linux or Windows binaries/);
  assert.match(readme, /Homebrew cask install the upstream distribution/);
  assert.doesNotMatch(readme, /Releases are signed and notarized/);

  assert.match(
    siteMetadata,
    /Install it from GitHub Releases on macOS, Linux and Windows, or Homebrew on macOS/,
  );
  assert.match(siteMetadata, /brew install --cask minghinmatthewlam\/tap\/pi-gui/);
  assert.doesNotMatch(siteMetadata, /source-install today/);

  assert.match(websitePage, /BREW_INSTALL/);
  assert.match(websitePage, /brew upgrade --cask pi-gui/);
  assert.match(websitePage, /Building from source is for contributors/);
  assert.doesNotMatch(websitePage, /Run the beta from source/);

  process.stdout.write("Fork README and inherited upstream website install copy are valid.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
