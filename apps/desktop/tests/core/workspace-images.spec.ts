import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { WorkbenchAgentCommand, WorkbenchAgentState } from "../../contracts/workbench-agent";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  selectSidePanel,
  type DesktopHarness,
} from "../helpers/electron-app";

/** A solid-colour RGB PNG of the given size. */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="parent.__svgRan = true">
  <script>parent.__svgRan = true; top.__svgRan = true;</script>
  <rect width="120" height="80" fill="#3a7"/>
</svg>`;

async function run(harness: DesktopHarness, target: SessionRef, params: WorkbenchAgentCommand) {
  const result = await harness.electronApp.evaluate(
    async (_electron, input) => {
      const hooks = (
        globalThis as typeof globalThis & {
          __PI_APP_TEST_HOOKS: {
            runWorkbenchRuntimeTool: (input: unknown) => Promise<{
              details: WorkbenchAgentState & { error?: string; description?: string };
            }>;
          };
        }
      ).__PI_APP_TEST_HOOKS;
      return hooks.runWorkbenchRuntimeTool(input);
    },
    { sessionRef: target, params },
  );
  return result.details;
}

async function openFromTree(window: Page, folder: string, path: string): Promise<void> {
  await selectSidePanel(window, "Files");
  const tree = window.getByTestId("file-workbench-tree");
  const dir = tree.locator(".file-workbench__tree-row--dir", { hasText: folder });
  // The explorer remembers expanded folders; expand only a collapsed one.
  await expect(dir).toBeVisible();
  if ((await dir.getAttribute("aria-expanded")) !== "true") await dir.click();
  await expect(dir).toHaveAttribute("aria-expanded", "true");
  await tree.locator(`.file-workbench__tree-row--file[data-file-path="${path}"]`).click();
}

test("Files tabs show images, flip through a folder and fall back for other binaries", async () => {
  test.setTimeout(60_000);
  const workspace = await makeGitWorkspace("image-files");
  await writeFile(join(workspace, ".gitignore"), ".dev-local/\n");
  await mkdir(join(workspace, "shots"));
  await mkdir(join(workspace, ".dev-local", "mock"), { recursive: true });
  await writeFile(join(workspace, "shots", "big.png"), solidPng(1600, 900, [220, 40, 40]));
  await writeFile(join(workspace, "shots", "logo.svg"), SVG);
  await writeFile(join(workspace, "shots", "spin.gif"), GIF);
  await writeFile(join(workspace, "shots", "data.bin"), Buffer.from([0xfe, 0xff, 0x80, 0x81, 7]));
  await writeFile(join(workspace, ".dev-local", "mock", "screen.png"), solidPng(40, 30, [0, 0, 0]));

  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Image files");
    const snapshot = await getDesktopState(window);
    const target = {
      workspaceId: snapshot.selectedWorkspaceId,
      sessionId: snapshot.selectedSessionId,
    };

    // A large PNG fits the pane, then shows at 100% with scrolling.
    await openFromTree(window, "shots", "shots/big.png");
    const viewer = window.getByTestId("file-image");
    await expect(viewer).toHaveAttribute("data-state", "loaded");
    await expect(viewer).toHaveAttribute("data-path", "shots/big.png");
    await expect(viewer.getByTestId("file-image-info")).toHaveText(/1600 × 900 px · .* · PNG/);
    const image = viewer.getByTestId("file-image-image");
    await expect(image).toHaveAttribute("src", /^pi-gui-image:\/\/workspace\//);
    const stage = viewer.getByTestId("file-image-stage");
    const stageBox = await stage.boundingBox();
    const fitted = await image.boundingBox();
    expect(fitted!.width).toBeLessThanOrEqual(stageBox!.width);
    expect(fitted!.width).toBeLessThan(1600);
    await expect(viewer.getByTestId("file-image-scale")).not.toHaveText("100%");

    await viewer.getByTestId("file-image-zoom").click();
    await expect(viewer).toHaveAttribute("data-zoom", "actual");
    await expect(viewer.getByTestId("file-image-scale")).toHaveText("100%");
    expect((await image.boundingBox())!.width).toBeCloseTo(1600, 0);
    expect(
      await stage.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBeTruthy();
    await viewer.getByTestId("file-image-zoom").click();
    await expect(viewer).toHaveAttribute("data-zoom", "fit");

    // ←/→ flip through the folder's images in the same tab.
    await expect(viewer.getByTestId("file-image-position")).toHaveText("1 / 3");
    await viewer.focus();
    await window.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAttribute("data-path", "shots/logo.svg");
    await expect(window.getByRole("tab", { name: "logo.svg", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(window.getByRole("tab", { name: "big.png", exact: true })).toHaveCount(0);

    // SVG renders as an image, never inline, so its scripts don't run.
    await expect(viewer).toHaveAttribute("data-state", "loaded");
    await expect(viewer.getByTestId("file-image-info")).toHaveText(/120 × 80 px · .* · SVG/);
    await expect(viewer.locator("svg")).toHaveCount(0);
    await expect(image).toHaveAttribute("src", /^pi-gui-image:\/\/workspace\//);
    expect(await window.evaluate(() => (window as { __svgRan?: boolean }).__svgRan)).toBeFalsy();
    // Its source is still one toggle away.
    await window.getByRole("button", { name: "View source" }).click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("<rect");
    await window.getByRole("button", { name: "View source" }).click();
    await expect(viewer).toHaveAttribute("data-state", "loaded");

    // Keyboard focus follows the flip, so the next arrow keeps going; the end stops there.
    await viewer.focus();
    await window.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAttribute("data-path", "shots/spin.gif");
    await expect(viewer).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAttribute("data-path", "shots/spin.gif");
    await expect(viewer).toHaveAttribute("data-state", "loaded");
    await expect(viewer).toHaveAttribute("data-width", "1");
    await viewer.getByRole("button", { name: "Previous image" }).click();
    await expect(viewer).toHaveAttribute("data-path", "shots/logo.svg");

    // A binary that isn't an image says so instead of showing garbage.
    await openFromTree(window, "shots", "shots/data.bin");
    await expect(window.getByTestId("file-no-preview")).toContainText("Can't preview this file");
    await expect(window.getByTestId("file-workbench-preview")).toHaveCount(0);

    // The agent can open an image under a gitignored folder the explorer leaves out.
    await selectSidePanel(window, "Files");
    await expect(
      window.getByTestId("file-workbench-tree").locator(".file-workbench__tree-row--dir", {
        hasText: ".dev-local",
      }),
    ).toHaveCount(0);
    const opened = await run(harness, target, {
      action: "open",
      tool: "files",
      path: ".dev-local/mock/screen.png",
    });
    expect(opened.error).toBeUndefined();
    expect(opened.selectedTabId).toBe("file:.dev-local/mock/screen.png");
    await expect(viewer).toHaveAttribute("data-path", ".dev-local/mock/screen.png");
    await expect(viewer).toHaveAttribute("data-state", "loaded");
    await expect(viewer.getByTestId("file-image-info")).toHaveText(/40 × 30 px/);
    const captured = await run(harness, target, { action: "capture" });
    expect(captured.description).toBe(
      "Image: .dev-local/mock/screen.png, 40×30 px, shown fitted to the pane",
    );
  } finally {
    await harness.close();
  }
});
