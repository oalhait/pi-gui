import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  MAX_WORKSPACE_IMAGE_BYTES,
  type WorkspaceImageResult,
} from "../../contracts/workspace-images";
import { decodeText, readWorkspaceFile } from "../../electron/platform/files/app-store-files";
import {
  WorkspaceImageServer,
  siblingImagePaths,
  sniffImageType,
} from "../../electron/platform/files/workspace-images";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SVG = `<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><script>alert(1)</script></svg>`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workspace-images-"));
  const path = join(root, "checkout");
  await mkdir(path);
  return path;
}

function image(result: WorkspaceImageResult) {
  if (result.kind !== "image") throw new Error(`expected an image, got ${result.reason}`);
  return result;
}

test("image types come from the file's bytes", () => {
  expect(sniffImageType(PNG)).toBe("image/png");
  expect(sniffImageType(GIF)).toBe("image/gif");
  expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImageType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
  expect(sniffImageType(Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]))).toBe("image/bmp");
  expect(sniffImageType(Buffer.from(SVG))).toBe("image/svg+xml");
  expect(sniffImageType(Buffer.from("\uFEFF  <svg>"))).toBe("image/svg+xml");
  expect(sniffImageType(Buffer.from("<html><svg></svg></html>"))).toBeUndefined();
  expect(sniffImageType(Buffer.from("plain text"))).toBeUndefined();
});

test("serves a workspace image, including under a gitignored dotfolder, to its URL only", async () => {
  const root = await workspace();
  await writeFile(join(root, ".gitignore"), ".dev-local/\n");
  await mkdir(join(root, ".dev-local", "mock"), { recursive: true });
  await writeFile(join(root, ".dev-local", "mock", "screen.png"), PNG);
  const server = new WorkspaceImageServer();

  const opened = image(await server.open(1, root, ".dev-local/mock/screen.png"));
  expect(opened).toMatchObject({
    mimeType: "image/png",
    sizeBytes: PNG.length,
    siblings: [".dev-local/mock/screen.png"],
  });
  expect(opened.src).toMatch(/^pi-gui-image:\/\/workspace\/[\w-]{32}$/);
  const response = await server.response(opened.src);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);

  // Every open gets its own URL; guessed or transcript-style URLs are not workspace files.
  const again = image(await server.open(1, root, ".dev-local/mock/screen.png"));
  expect(again.src).not.toBe(opened.src);
  expect((await server.response("pi-gui-image://workspace/guess")).status).toBe(404);
  expect((await server.response(opened.src.replace("workspace", "image"))).status).toBe(404);

  server.revokeWindow(1);
  expect((await server.response(opened.src)).status).toBe(404);
});

test("SVG is served as an image with a script-blocking policy", async () => {
  const root = await workspace();
  await writeFile(join(root, "logo.svg"), SVG);
  const server = new WorkspaceImageServer();
  const opened = image(await server.open(1, root, "logo.svg"));
  const response = await server.response(opened.src);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
});

test("refuses paths outside the workspace, oversized files and mislabelled bytes", async () => {
  const root = await workspace();
  const outside = join(root, "..", "outside.png");
  await writeFile(outside, PNG);
  await symlink(outside, join(root, "link.png"));
  await writeFile(join(root, "fake.png"), "not an image");
  await writeFile(join(root, "drawing.png"), SVG);
  await writeFile(join(root, "raster.svg"), PNG);
  await writeFile(join(root, "huge.png"), PNG);
  await truncate(join(root, "huge.png"), MAX_WORKSPACE_IMAGE_BYTES + 1);
  await mkdir(join(root, "folder.png"));
  const server = new WorkspaceImageServer();

  await expect(server.open(1, root, "../outside.png")).rejects.toThrow("escapes workspace");
  await expect(server.open(1, root, "link.png")).rejects.toThrow("escapes workspace");
  expect(await server.open(1, root, "fake.png")).toEqual({
    kind: "unsupported",
    reason: "not-image",
    sizeBytes: 12,
  });
  expect(await server.open(1, root, "drawing.png")).toMatchObject({ reason: "not-image" });
  expect(await server.open(1, root, "raster.svg")).toMatchObject({ reason: "not-image" });
  expect(await server.open(1, root, "huge.png")).toMatchObject({ reason: "too-large" });
  expect(await server.open(1, root, "folder.png")).toMatchObject({ reason: "not-file" });
});

test("a granted URL stops serving once the file changes type or leaves the cap", async () => {
  const root = await workspace();
  await writeFile(join(root, "shot.png"), PNG);
  const server = new WorkspaceImageServer();
  const opened = image(await server.open(1, root, "shot.png"));
  await writeFile(join(root, "shot.png"), GIF);
  expect((await server.response(opened.src)).status).toBe(404);
  await writeFile(join(root, "shot.png"), PNG);
  expect((await server.response(opened.src)).status).toBe(200);
  await truncate(join(root, "shot.png"), MAX_WORKSPACE_IMAGE_BYTES + 1);
  expect((await server.response(opened.src)).status).toBe(404);
});

test("lists the folder's images in natural order, capped around the open one", async () => {
  const root = await workspace();
  await mkdir(join(root, "shots"));
  for (const name of ["10.png", "2.png", "1.gif", "notes.md", "logo.svg"])
    await writeFile(join(root, "shots", name), PNG);
  await mkdir(join(root, "shots", "nested.png"));
  expect(await siblingImagePaths(root, "shots/2.png")).toEqual([
    "shots/1.gif",
    "shots/2.png",
    "shots/10.png",
    "shots/logo.svg",
  ]);
  expect(await siblingImagePaths(root, "shots/logo.svg", 2)).toEqual([
    "shots/10.png",
    "shots/logo.svg",
  ]);
  expect(await siblingImagePaths(root, "shots/1.gif", 2)).toEqual(["shots/1.gif", "shots/2.png"]);
});

test("binary files that are not NUL-padded still read as binary, not garbage text", async () => {
  const root = await workspace();
  await writeFile(join(root, "noise.bin"), Buffer.from(Array.from({ length: 64 }, () => 0xfe)));
  await writeFile(join(root, "notes.txt"), "caf\u00e9 \uFFFD ok\n");
  expect(await readWorkspaceFile(root, "noise.bin")).toMatchObject({ binary: true, content: "" });
  expect(await readWorkspaceFile(root, "notes.txt")).toMatchObject({ binary: false });
  // A multibyte character cut off at the preview limit is still text.
  expect(decodeText(Buffer.from("abc\u00e9").subarray(0, 4))).toBe("abc\uFFFD");
});
