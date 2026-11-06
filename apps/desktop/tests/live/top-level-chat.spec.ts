import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
} from "../helpers/electron-app";

test("a top-level chat streams a real reply and runs a tool with no folder open", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, {
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });

  try {
    const window = await harness.firstWindow();
    await expect(window.getByTestId("empty-state")).toBeVisible();

    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(window.locator(".new-thread__workspace option:checked")).toHaveText("No folder");
    await window
      .getByLabel("New thread prompt")
      .fill(
        "Use your bash tool to run exactly `pwd`. Then, without more tools, write 60 numbered " +
          "lines about working directories, at least 12 words each, and end with FINISHED.",
      );
    await window.getByRole("button", { name: "Start thread" }).click();

    // Streaming: the reply grows while the run is still going.
    const replies = window.locator(".timeline-item--assistant .message__content");
    const runningLengths: number[] = [];
    await expect
      .poll(
        async () => {
          const text = (await replies.allTextContents()).join("\n");
          const running = (await getDesktopState(window)).workspaces.some((workspace) =>
            workspace.sessions.some((session) => session.status === "running"),
          );
          if (running && text.length > 0 && text.length !== runningLengths.at(-1)) {
            runningLengths.push(text.length);
          }
          return /FINISHED/.test(text);
        },
        { timeout: 200_000, intervals: [100] },
      )
      .toBe(true);
    expect(runningLengths.length).toBeGreaterThanOrEqual(2);

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const chats = state.workspaces.find((workspace) => workspace.kind === "chats");
          return {
            selected: state.selectedWorkspaceId === chats?.id,
            status: chats?.sessions[0]?.status,
          };
        },
        { timeout: 60_000 },
      )
      .toEqual({ selected: true, status: "idle" });

    // The tool ran in pi-gui's chats folder, not in any project.
    const state = await getDesktopState(window);
    const chatsPath = state.workspaces.find((workspace) => workspace.kind === "chats")?.path;
    expect(chatsPath).toBeTruthy();
    const transcript = await getSelectedTranscript(window);
    const tool = transcript?.transcript.find(
      (item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool",
    );
    expect(tool?.status).toBe("success");
    expect(JSON.stringify(tool?.output)).toContain(chatsPath);
    await expect(window.locator(".topbar__workspace")).toHaveText("Chats");
    await window.screenshot({ path: test.info().outputPath("top-level-chat.png") });
  } finally {
    await harness.close();
  }
});
