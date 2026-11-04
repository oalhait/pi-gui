import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  selectSidePanel,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/** The side panel shows one thing at a time beside the conversation. */
async function expectBesideConversation(window: Page, testId: string): Promise<void> {
  const conversation = window.locator(".canvas--thread");
  const pane = window.getByTestId(testId);
  await expect(conversation).toBeVisible();
  await expect(pane).toBeVisible();
  const conversationBox = await conversation.boundingBox();
  const paneBox = await pane.boundingBox();
  if (!conversationBox || !paneBox) throw new Error(`Expected conversation and ${testId} boxes`);
  expect(conversationBox.x + conversationBox.width).toBeLessThanOrEqual(paneBox.x + 2);
  expect(paneBox.width).toBeGreaterThan(250);
  await expect(window.locator(".diff-panel")).toHaveCount(0);
}

test("the Files explorer opens each file in its own side panel tab", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("plain-files-workspace");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "app.ts"), "export const ready = true;\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Plain folder files");
    await selectSidePanel(window, "Files");

    const workbench = window.getByTestId("file-workbench");
    await expect(workbench).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await expect(window.getByTestId("file-workbench-filter")).toHaveAttribute(
      "placeholder",
      "Filter files…",
    );
    await expectBesideConversation(window, "file-explorer");
    await expect(window.getByTestId("file-editor")).toHaveCount(0);

    const tree = window.getByTestId("file-workbench-tree");
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="README.md"]'),
    ).toBeVisible();
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toHaveCount(0);

    await tree.locator(".file-workbench__tree-row--dir", { hasText: "src" }).click();
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toBeVisible();
    await tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]').click();

    const editor = window.getByTestId("file-editor");
    const appTab = window.getByRole("tab", { name: "app.ts", exact: true });
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(appTab).toHaveAttribute("title", /src\/app\.ts/);
    await expectBesideConversation(window, "file-editor");
    await expect(window.getByTestId("file-explorer")).toHaveCount(0);
    await expect(editor.getByTestId("file-editor-breadcrumb")).toContainText("src");
    await expect(editor.getByTestId("file-workbench-preview")).toContainText("export const ready");

    // A second file is a second tab; picking the first again focuses its tab.
    await window.getByRole("tab", { name: "Files", exact: true }).click();
    await tree.locator('.file-workbench__tree-row--file[data-file-path="README.md"]').click();
    await expect(window.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await window.getByRole("tab", { name: "Files", exact: true }).click();
    await tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]').click();
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveText(["Review", "Files", "app.ts", "README.md"]);

    await window.getByRole("tab", { name: "Files", exact: true }).click();
    await window.getByTestId("file-workbench-filter").fill("app.ts");
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="README.md"]'),
    ).toHaveCount(0);
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("Files explorer drops the previous workspace tree after a folder switch", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("alpha-files-workspace");
  const bravoPath = await makeWorkspace("bravo-files-workspace");
  await writeFile(join(alphaPath, "alpha-only.md"), "# alpha\n", "utf8");
  await writeFile(join(bravoPath, "bravo-only.md"), "# bravo\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, bravoPath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Alpha files", { workspaceName: "alpha-files-workspace" });
    await createNamedThread(window, "Bravo files", { workspaceName: "bravo-files-workspace" });
    await window.locator(".session-row__select", { hasText: "Alpha files" }).click();
    await selectSidePanel(window, "Files");
    const tree = window.getByTestId("file-workbench-tree");
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="alpha-only.md"]'),
    ).toBeVisible();
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="bravo-only.md"]'),
    ).toHaveCount(0);

    await window.locator(".session-row__select", { hasText: "Bravo files" }).click();
    const workbench = window.getByTestId("file-workbench");
    if ((await workbench.count()) === 0) {
      await selectSidePanel(window, "Files");
    }
    await expect(workbench).toBeVisible();
    await expect(
      workbench.locator('.file-workbench__tree-row--file[data-file-path="bravo-only.md"]'),
    ).toBeVisible();
    await expect(
      workbench.locator('.file-workbench__tree-row--file[data-file-path="alpha-only.md"]'),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
