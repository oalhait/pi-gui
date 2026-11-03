import { expect, test } from "@playwright/test";
import {
  ancestorDirectoryPaths,
  breadcrumbSegments,
  fileNameFromPath,
  fileTabLabels,
  isMarkdownPath,
} from "../../src/features/workbench/file-workbench-state";

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
