// Builds a self-contained pi-gui-host directory (with production node_modules) and packs it as
// bundle/pi-gui-host.tgz, plus bundle/pi-gui-host.json naming it. pi-gui uploads this archive to a
// server that does not have the current bundle. The id changes whenever the host's code or the
// lockfile changes, so a rebuilt host is reinstalled.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const root = join(packageDir, "..", "..");
const outDir = join(packageDir, "bundle");
const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

function hashTree(hash, dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      hashTree(hash, path);
    } else {
      hash.update(relative(root, path));
      hash.update(readFileSync(path));
    }
  }
}

const pnpm = process.env.npm_execpath;
const run = (args, cwd = root) =>
  pnpm
    ? execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: "inherit" })
    : execFileSync("pnpm", args, { cwd, stdio: "inherit" });

for (const name of [
  "session-driver",
  "catalogs",
  "extension-ui",
  "pi-sdk-driver",
  "remote-protocol",
  "pi-gui-host",
]) {
  run(["--filter", `@pi-gui/${name}`, "build"]);
}

const hash = createHash("sha256");
hash.update(readFileSync(join(root, "pnpm-lock.yaml")));
for (const name of [
  "session-driver",
  "catalogs",
  "extension-ui",
  "pi-sdk-driver",
  "remote-protocol",
  "pi-gui-host",
]) {
  hashTree(hash, join(root, "packages", name, "dist"));
}
const bundleId = `${version}-${hash.digest("hex").slice(0, 12)}`;

const staging = mkdtempSync(join(tmpdir(), "pi-gui-host-bundle-"));
try {
  const deployDir = join(staging, "pi-gui-host");
  run([
    "--filter",
    "@pi-gui/pi-gui-host",
    "--config.allow-unused-patches=true",
    "deploy",
    "--prod",
    "--legacy",
    deployDir,
  ]);
  writeFileSync(join(deployDir, "bundle-id"), `${bundleId}\n`);
  mkdirSync(outDir, { recursive: true });
  execFileSync("tar", ["-czf", join(outDir, "pi-gui-host.tgz"), "-C", deployDir, "."]);
  writeFileSync(
    join(outDir, "pi-gui-host.json"),
    `${JSON.stringify({ bundleId, version }, null, 2)}\n`,
  );
  console.log(`pi-gui-host bundle ${bundleId} written to ${relative(root, outDir)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
