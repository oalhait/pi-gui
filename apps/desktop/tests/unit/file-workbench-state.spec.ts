import { expect, test } from "@playwright/test";
import {
  ancestorDirectoryPaths,
  breadcrumbSegments,
  fileNameFromPath,
  fileTabLabels,
  formatByteSize,
  isMarkdownPath,
  siblingPath,
} from "../../src/features/workbench/file-workbench-state";
import { imageTypeForPath, imageTypeLabel } from "../../contracts/workspace-images";

test("file tabs are labelled by basename, with the parent folder only when basenames collide", () => {
  expect([...fileTabLabels(["src/a/index.ts", "src/b/index.ts", "README.md", "index.ts"])]).toEqual(
    [
      ["src/a/index.ts", "index.ts · a"],
      ["src/b/index.ts", "index.ts · b"],
      ["README.md", "README.md"],
      ["index.ts", "index.ts"],
    ],
  );
});

test("path helpers", () => {
  expect(isMarkdownPath("notes.md")).toBe(true);
  expect(isMarkdownPath("src/app.ts")).toBe(false);
  expect(fileNameFromPath("src/lib/util.ts")).toBe("util.ts");
  expect(breadcrumbSegments("src/lib/util.ts")).toEqual(["src", "lib", "util.ts"]);
  expect(ancestorDirectoryPaths("src/lib/util.ts")).toEqual(["src", "src/lib"]);
  expect(ancestorDirectoryPaths("README.md")).toEqual([]);
});

test("image files are recognised by extension, case-insensitively", () => {
  expect(imageTypeForPath("a/b/mock.PNG")).toBe("image/png");
  expect(imageTypeForPath("photo.jpeg")).toBe("image/jpeg");
  expect(imageTypeForPath("photo.jpg")).toBe("image/jpeg");
  expect(imageTypeForPath(".dev-local/spin.gif")).toBe("image/gif");
  expect(imageTypeForPath("logo.svg")).toBe("image/svg+xml");
  expect(imageTypeForPath("favicon.ico")).toBe("image/x-icon");
  expect(imageTypeForPath("x.webp")).toBe("image/webp");
  expect(imageTypeForPath("x.bmp")).toBe("image/bmp");
  expect(imageTypeForPath("x.tiff")).toBeUndefined();
  expect(imageTypeForPath("png")).toBeUndefined();
  expect(imageTypeLabel("image/svg+xml")).toBe("SVG");
  expect(imageTypeLabel("image/jpeg")).toBe("JPEG");
  expect(imageTypeLabel("image/x-icon")).toBe("ICO");
});

test("file sizes read in the nearest unit", () => {
  expect(formatByteSize(0)).toBe("0 B");
  expect(formatByteSize(1023)).toBe("1023 B");
  expect(formatByteSize(1536)).toBe("1.5 KB");
  expect(formatByteSize(250 * 1024)).toBe("250 KB");
  expect(formatByteSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
});

test("flipping images stops at either end of the folder", () => {
  const siblings = ["a.png", "b.png", "c.png"];
  expect(siblingPath(siblings, "b.png", -1)).toBe("a.png");
  expect(siblingPath(siblings, "b.png", 1)).toBe("c.png");
  expect(siblingPath(siblings, "a.png", -1)).toBeUndefined();
  expect(siblingPath(siblings, "c.png", 1)).toBeUndefined();
  expect(siblingPath(siblings, "missing.png", 1)).toBeUndefined();
});
