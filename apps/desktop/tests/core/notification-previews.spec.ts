import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  type DesktopHarness,
} from "../helpers/electron-app";
import {
  emitAssistantReply,
  emitCompletedEvent,
  emitFailedEvent,
  emitRunningEvent,
  emitToolCall,
  readOptionalLog,
} from "../helpers/notification-events";
import {
  createThread,
  selectSessionByTitle,
  setSessionVisibilityOverride,
  type SessionContext,
} from "../helpers/session-event-test-helpers";

interface LoggedNotification {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
}

async function readNotifications(path: string): Promise<LoggedNotification[]> {
  return (await readOptionalLog(path))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedNotification);
}

async function nextNotification(path: string, count: number): Promise<LoggedNotification> {
  await expect.poll(async () => (await readNotifications(path)).length).toBe(count);
  const entry = (await readNotifications(path))[count - 1];
  if (!entry) throw new Error(`Expected notification ${count}`);
  return entry;
}

async function completeRun(
  harness: DesktopHarness,
  session: SessionContext,
  label: string,
  steps: (runId: string) => Promise<void>,
): Promise<void> {
  const runId = await emitRunningEvent(harness, session, label);
  await steps(runId);
  await emitCompletedEvent(harness, session, label, runId);
}

async function launchWithBackgroundSession(name: string) {
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, `${name}.jsonl`);
  const workspacePath = await makeWorkspace(name);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });
  const window = await harness.firstWindow();
  const session = await createThread(window, "Preview Session");
  await createThread(window, "Viewed Session");
  await setSessionVisibilityOverride(harness, "active");
  await selectSessionByTitle(window, "Preview Session");
  await selectSessionByTitle(window, "Viewed Session");
  return { harness, window, session, notificationLogPath };
}

test("completion notifications preview this run's final reply, or stay generic", async () => {
  const { harness, window, session, notificationLogPath } = await launchWithBackgroundSession(
    "notification-previews-completed",
  );
  try {
    const projectName = (await getDesktopState(window)).workspaces[0]?.name;

    await completeRun(harness, session, "Reply", async (runId) => {
      await emitAssistantReply(harness, session, runId, ["Let me check the ", "**repo** first."]);
      await emitToolCall(harness, session, runId, "call-1");
      await emitAssistantReply(harness, session, runId, [
        "## Summary\n\nFixed the `parser` bug ",
        "in [the PR](https://example.com/pr/1).\n\n```ts\nconst hidden = 1;\n```\n",
        "- Added tests\n- Ran lint",
      ]);
    });
    const completed = await nextNotification(notificationLogPath, 1);
    expect(completed.title).toBe("Preview Session");
    expect(completed.subtitle).toBe(projectName);
    expect(completed.body).toBe(
      "Summary: Fixed the parser bug in the PR. • Added tests • Ran lint",
    );

    // A later run with only tool calls must not reuse the reply above.
    await completeRun(harness, session, "Tools", async (runId) => {
      await emitToolCall(harness, session, runId, "call-2");
    });
    expect((await nextNotification(notificationLogPath, 2)).body).toBe("Agent finished responding");

    const longReply = `${"Investigated the failing build step by step ".repeat(8)}done.`;
    await completeRun(harness, session, "Long", async (runId) => {
      await emitAssistantReply(harness, session, runId, [longReply]);
    });
    const long = (await nextNotification(notificationLogPath, 3)).body;
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(longReply.startsWith(long.slice(0, -1))).toBe(true);
  } finally {
    await harness.close();
  }
});

test("failure notifications label the error and include any partial reply", async () => {
  const { harness, session, notificationLogPath } = await launchWithBackgroundSession(
    "notification-previews-failed",
  );
  try {
    await emitFailedEvent(harness, session, "Timeout", "Request timed out after 600s");
    expect((await nextNotification(notificationLogPath, 1)).body).toBe(
      "Timed out: Request timed out after 600s",
    );

    await emitFailedEvent(harness, session, "Partial", "Connection reset", [
      "I updated *three* files and was about to",
    ]);
    expect((await nextNotification(notificationLogPath, 2)).body).toBe(
      "Failed: Connection reset\nI updated three files and was about to",
    );
  } finally {
    await harness.close();
  }
});

test("turning off reply previews keeps the generic bodies", async () => {
  const { harness, window, session, notificationLogPath } = await launchWithBackgroundSession(
    "notification-previews-off",
  );
  try {
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Notifications", exact: true }).click();
    const replyPreview = window.getByLabel("Show reply preview", { exact: true });
    await expect(replyPreview).toBeChecked();
    await replyPreview.click();
    await expect(replyPreview).not.toBeChecked();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).notificationPreferences.showReplyPreview)
      .toBe(false);

    await completeRun(harness, session, "Private", async (runId) => {
      await emitAssistantReply(harness, session, runId, ["The secret plan is ready."]);
    });
    expect((await nextNotification(notificationLogPath, 1)).body).toBe("Agent finished responding");

    await emitFailedEvent(harness, session, "PrivateFail", "Connection reset", [
      "Partial secret text",
    ]);
    expect((await nextNotification(notificationLogPath, 2)).body).toBe("Failed: Connection reset");
  } finally {
    await harness.close();
  }
});
