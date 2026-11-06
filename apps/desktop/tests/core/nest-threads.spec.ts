import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

function row(window: Page, title: string): Locator {
  return window.locator(".session-row:not(.session-row--overlay)", { hasText: title });
}

/** Drags with the real pointer: dnd-kit starts a drag only after the pointer moves 5px. */
async function dragOnto(window: Page, from: Locator, to: Locator): Promise<void> {
  const start = await from.locator(".session-row__select").boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("Rows must be visible to drag");
  await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await window.mouse.down();
  await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 10, {
    steps: 4,
  });
  await window.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await expect(to).toHaveClass(/session-row--drop-target/);
  await window.mouse.up();
}

test("dragging a thread onto another nests it there, and Move out of parent undoes it", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("nest-threads");
  const launch = () =>
    launchDesktop(userDataDir, { initialWorkspaces: [workspacePath], testMode: "background" });

  let harness = await launch();
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent plan");
    await createNamedThread(window, "Child research");
    await createNamedThread(window, "Grandchild notes");
    const state = await getDesktopState(window);
    const keyOf = (title: string) => {
      const workspace = state.workspaces.find((entry) =>
        entry.sessions.some((session) => session.title === title),
      );
      const session = workspace?.sessions.find((entry) => entry.title === title);
      return `${workspace?.id}:${session?.id}`;
    };

    await dragOnto(window, row(window, "Child research"), row(window, "Parent plan"));
    await expect(row(window, "Child research")).toHaveAttribute(
      "data-parent-thread",
      keyOf("Parent plan"),
    );
    await dragOnto(window, row(window, "Grandchild notes"), row(window, "Child research"));
    await expect(row(window, "Grandchild notes")).toHaveAttribute(
      "data-parent-thread",
      keyOf("Child research"),
    );

    // A thread cannot go inside its own descendant: the row never offers itself as a target.
    const parentBox = await row(window, "Parent plan")
      .locator(".session-row__select")
      .boundingBox();
    const grandchildBox = await row(window, "Grandchild notes").boundingBox();
    if (!parentBox || !grandchildBox) throw new Error("Rows must be visible");
    await window.mouse.move(parentBox.x + 20, parentBox.y + parentBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(parentBox.x + 20, parentBox.y + parentBox.height / 2 + 10, {
      steps: 4,
    });
    await window.mouse.move(grandchildBox.x + 20, grandchildBox.y + grandchildBox.height / 2, {
      steps: 12,
    });
    await expect(row(window, "Grandchild notes")).not.toHaveClass(/session-row--drop-target/);
    await window.mouse.up();
    await expect(row(window, "Parent plan")).not.toHaveAttribute("data-parent-thread", /.+/);
  } finally {
    await harness.close();
  }

  // The nesting is saved, and the menu takes a thread back out.
  harness = await launch();
  try {
    const window = await harness.firstWindow();
    const child = row(window, "Child research");
    await expect(child).toHaveAttribute("data-parent-thread", /.+/, { timeout: 15_000 });
    await child.click({ button: "right" });
    await child.getByRole("button", { name: "Move out of parent", exact: true }).click();
    await expect(child).not.toHaveAttribute("data-parent-thread", /.+/);
    // Its own child stays with it.
    await expect(row(window, "Grandchild notes")).toHaveAttribute("data-parent-thread", /.+/);
  } finally {
    await harness.close();
  }
});
