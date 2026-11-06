import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { PiDesktopApi } from "../../contracts/ipc";
import type { WorkbenchAgentCommand, WorkbenchAgentState } from "../../contracts/workbench-agent";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  type DesktopHarness,
} from "../helpers/electron-app";

async function run(harness: DesktopHarness, target: SessionRef, params: WorkbenchAgentCommand) {
  const result = await harness.electronApp.evaluate(
    async (_electron, input) =>
      (
        globalThis as typeof globalThis & {
          __PI_APP_TEST_HOOKS: {
            runWorkbenchRuntimeTool: (
              input: unknown,
            ) => Promise<{ details: WorkbenchAgentState & { error?: string } }>;
          };
        }
      ).__PI_APP_TEST_HOOKS.runWorkbenchRuntimeTool(input),
    { sessionRef: target, params },
  );
  return result.details;
}

async function setup(name: string, files: Record<string, string>) {
  const workspace = await makeWorkspace(name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  await createNamedThread(window, `Live ${name}`);
  const snapshot = await getDesktopState(window);
  const target = {
    workspaceId: snapshot.selectedWorkspaceId,
    sessionId: snapshot.selectedSessionId,
  };
  return { workspace, harness, window, target };
}

/** Writes through a temporary file and a rename, as editors and agent tools often do. */
async function writeAtomically(path: string, content: string) {
  await writeFile(`${path}.tmp-${process.pid}`, content);
  await rename(`${path}.tmp-${process.pid}`, path);
}

const body = (window: Page) => window.locator(".file-editor__body");
const editorState = (window: Page) => window.getByTestId("file-editor");

test("an open Markdown tab follows its file on disk, rendered and as source, keeping its scroll", async () => {
  const filler = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  const { workspace, harness, window, target } = await setup("live-markdown", {
    "notes/draft.md": `# First draft\n\n${filler}\n`,
  });
  const file = join(workspace, "notes", "draft.md");
  try {
    await run(harness, target, { action: "open", tool: "files", path: "notes/draft.md" });
    const preview = window.getByTestId("file-workbench-preview");
    await expect(preview.getByRole("heading", { name: "First draft" })).toBeVisible();

    // Scrolled down, an outside write swaps the content in place.
    await body(window).evaluate((element) => {
      element.scrollTop = 1200;
    });
    await writeFile(file, `# Second draft\n\n## New section\n\n${filler}\n`);
    await expect(preview.getByRole("heading", { name: "Second draft" })).toBeAttached();
    await expect(preview.getByRole("heading", { name: "New section" })).toBeAttached();
    await expect(preview.getByRole("heading", { name: "First draft" })).toHaveCount(0);
    expect(await body(window).evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);

    // An atomic replace (a new inode) is followed too, and so are later writes to it.
    await writeAtomically(file, `# Third draft\n\n${filler}\n`);
    await expect(preview.getByRole("heading", { name: "Third draft" })).toBeAttached();
    await writeFile(file, `# Fourth draft\n\n${filler}\n`);
    await expect(preview.getByRole("heading", { name: "Fourth draft" })).toBeAttached();
    await expect(window.locator('[data-testid^="workbench-tab-file:"]')).toHaveCount(1);

    // View source follows the file the same way.
    await window.getByRole("button", { name: "View source" }).click();
    await expect(preview).toContainText("# Fourth draft");
    await writeAtomically(file, `# Fifth draft\n\n${filler}\n`);
    await expect(preview).toContainText("# Fifth draft");
    await expect(preview).not.toContainText("# Fourth draft");
    await expect(window.getByRole("button", { name: "View source" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await harness.close();
  }
});

test("an open code tab follows writes, shows a deleted file as missing and recovers", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `export const value${index} = ${index};`);
  const { workspace, harness, window, target } = await setup("live-code", {
    "src/values.ts": `${lines.join("\n")}\n`,
  });
  const file = join(workspace, "src", "values.ts");
  try {
    await run(harness, target, { action: "open", tool: "files", path: "src/values.ts" });
    const preview = window.getByTestId("file-workbench-preview");
    await expect(preview).toContainText("export const value0 = 0;");
    await body(window).evaluate((element) => {
      element.scrollTop = 1500;
    });
    await writeFile(file, `${lines.join("\n").replace("value0 = 0", "value0 = 42")}\n`);
    await expect(preview).toContainText("export const value0 = 42;");
    expect(await body(window).evaluate((element) => element.scrollTop)).toBeGreaterThan(1300);

    // Deleted: a clear missing state, not the stale content.
    await rm(file);
    await expect(window.getByTestId("file-missing")).toContainText("This file no longer exists");
    await expect(preview).toHaveCount(0);
    await expect(editorState(window)).toHaveAttribute("data-state", "missing");

    // Recreated: the tab shows it again by itself.
    await writeAtomically(file, "export const recreated = true;\n");
    await expect(preview).toContainText("export const recreated = true;");
    await expect(window.getByTestId("file-missing")).toHaveCount(0);

    // The folder goes away and comes back.
    await rm(join(workspace, "src"), { recursive: true });
    await expect(window.getByTestId("file-missing")).toBeVisible();
    await mkdir(join(workspace, "src"));
    await writeFile(file, "export const again = 1;\n");
    await expect(preview).toContainText("export const again = 1;");
  } finally {
    await harness.close();
  }
});

test("the agent's open on an already open file answers with its current content", async () => {
  const { workspace, harness, window, target } = await setup("live-reopen", {
    "draft.md": "# Old title\n\nOld section\n",
  });
  try {
    await run(harness, target, { action: "open", tool: "files", path: "draft.md" });
    await expect(window.getByRole("heading", { name: "Old title" })).toBeVisible();
    // Stop main's watch, so only the re-read on open can show the new content.
    await window.evaluate(async (workspaceId) => {
      const api = (window as unknown as { piApp: PiDesktopApi }).piApp;
      await api.watchWorkspaceFiles(workspaceId, []);
    }, target.workspaceId);
    await writeFile(join(workspace, "draft.md"), "# New title\n\nNew section\n");
    const reopened = await run(harness, target, {
      action: "open",
      tool: "files",
      path: "draft.md",
    });
    expect(reopened.selectedTabId).toBe("file:draft.md");
    // Read right away: open answers once the tab shows the re-read file.
    expect(await window.getByTestId("file-workbench-preview").textContent()).toContain(
      "New section",
    );
    await expect(window.getByRole("heading", { name: "Old title" })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("an open image tab shows the new image when the file is replaced, and its source too", async () => {
  const svg = (width: number, height: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="teal"/></svg>`;
  const { workspace, harness, window, target } = await setup("live-image", {
    "art/logo.svg": svg(120, 60),
  });
  const file = join(workspace, "art", "logo.svg");
  try {
    await run(harness, target, { action: "open", tool: "files", path: "art/logo.svg" });
    const viewer = window.getByTestId("file-image");
    await expect(viewer).toHaveAttribute("data-width", "120");
    await writeAtomically(file, svg(300, 80));
    await expect(viewer).toHaveAttribute("data-width", "300");
    await expect(viewer).toHaveAttribute("data-height", "80");

    await rm(file);
    await expect(window.getByTestId("file-missing")).toBeVisible();
    await expect(viewer).toHaveCount(0);
    await writeFile(file, svg(64, 64));
    await expect(viewer).toHaveAttribute("data-width", "64");

    await window.getByRole("button", { name: "View source" }).click();
    const preview = window.getByTestId("file-workbench-preview");
    await expect(preview).toContainText('width="64"');
    await writeFile(file, svg(32, 16));
    await expect(preview).toContainText('width="32"');
  } finally {
    await harness.close();
  }
});
