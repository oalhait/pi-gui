import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  triggerWindowActivation,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
} from "../helpers/scripted-openai-server";

// A prompt containing "stall" gets response headers and then nothing until the test ends, like
// a provider that accepted the request and never started answering.
let releaseStalls: () => void = () => undefined;
const stalled = new Promise<void>((resolve) => {
  releaseStalls = resolve;
});

function answer(request: ScriptedChatRequest) {
  if (request.toolNames.length === 0) return { text: "Thread title" };
  const ask = [...request.messages].reverse().find((message) => message.role === "user");
  const text = `Answer to ${ask?.content ?? "nothing"}`;
  return ask?.content.includes("stall") ? { text, holdBeforeFirstChunk: stalled } : { text };
}

async function sessionStatus(window: Page) {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(
    window.locator(".timeline-item--assistant", { hasText: `Answer to ${text}` }),
  ).toHaveCount(1);
  await expect.poll(() => sessionStatus(window)).toBe("idle");
}

/** Sends a prompt the model never answers, then stops it from the composer. */
async function sendAndStop(window: Page, text: string, options: { settle: boolean }) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
  const stop = window.getByTestId("send");
  await expect(stop).toHaveAttribute("aria-label", "Stop run");
  await expect(window.getByTestId("timeline-working")).toBeVisible();
  await stop.click();
  if (options.settle) {
    await expect.poll(() => sessionStatus(window)).toBe("idle");
    await expect(stop).not.toHaveAttribute("aria-label", "Stop run");
  }
}

async function editMessage(window: Page, text: string) {
  await waitForTimelineLayout(window);
  const message = window
    .getByTestId("transcript")
    .locator(".timeline-item--user", { hasText: text })
    .last();
  await message.hover();
  await message.getByRole("button", { name: "Edit message", exact: true }).click();
}

async function userTexts(window: Page) {
  return window.locator(".timeline-item--user .timeline-item__bubble").allInnerTexts();
}

test("editing works for messages around a run stopped before its first token", async () => {
  test.setTimeout(240_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("edit-after-stop");
  const server = await startScriptedOpenAiServer(answer);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["scripted-test/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "scripted-test",
      defaultModel: "scripted",
      enabledModels: ["scripted-test/scripted"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "scripted-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "scripted" }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Other thread");
    await createNamedThread(window, "Stopped thread");
    const composer = window.getByTestId("composer");
    const errorBanner = window.getByTestId("composer-error-banner");

    await send(window, "First question");

    await test.step("the message whose run was stopped before any output", async () => {
      await sendAndStop(window, "Please stall here", { settle: true });
      await editMessage(window, "Please stall here");
      await expect(composer).toHaveValue("Please stall here");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question"]);
    });

    await test.step("a message sent right after a stopped run, and the stopped one", async () => {
      await composer.fill("");
      await sendAndStop(window, "Second stall", { settle: true });
      await send(window, "Answer the question above");
      await editMessage(window, "Answer the question above");
      await expect(composer).toHaveValue("Answer the question above");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question", "Second stall"]);

      await editMessage(window, "Second stall");
      await expect(composer).toHaveValue("Second stall");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question"]);
    });

    await test.step("a message edited while the stopped run is still settling", async () => {
      await composer.fill("");
      await sendAndStop(window, "Third stall", { settle: false });
      await editMessage(window, "Third stall");
      await expect(composer).toHaveValue("Third stall");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question"]);
    });

    await test.step("after switching threads and back", async () => {
      await composer.fill("");
      await sendAndStop(window, "Fourth stall", { settle: true });
      await send(window, "Another follow-up");
      await selectSession(window, "Other thread");
      await selectSession(window, "Stopped thread");
      await expect
        .poll(() => userTexts(window))
        .toEqual(["First question", "Fourth stall", "Another follow-up"]);
      await editMessage(window, "Fourth stall");
      await expect(composer).toHaveValue("Fourth stall");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question"]);
    });

    await test.step("switching threads while the stalled run waits", async () => {
      await composer.fill("");
      await send(window, "Before the switch");
      await composer.fill("Fifth stall");
      await composer.press("Enter");
      await expect(window.getByTestId("timeline-working")).toBeVisible();
      await selectSession(window, "Other thread");
      await selectSession(window, "Stopped thread");
      await expect(window.getByTestId("timeline-working")).toBeVisible();
      await triggerWindowActivation(harness);
      await window.getByTestId("send").click();
      await expect.poll(() => sessionStatus(window)).toBe("idle");
      await editMessage(window, "Fifth stall");
      await expect(composer).toHaveValue("Fifth stall");
      await expect(errorBanner).toHaveCount(0);
      await expect.poll(() => userTexts(window)).toEqual(["First question", "Before the switch"]);
    });

    await test.step("a failed edit stays visible until dismissed and is logged", async () => {
      const mainLog: string[] = [];
      harness.electronApp.process().stderr?.on("data", (chunk: Buffer) => {
        mainLog.push(chunk.toString());
      });
      const state = await getDesktopState(window);
      const sessionRef = {
        workspaceId: state.selectedWorkspaceId ?? "",
        sessionId: state.selectedSessionId ?? "",
      };
      // A user row Pi never wrote, so no entry on the branch matches it.
      await emitTestSessionEvent(harness, {
        type: "queuedMessageStarted",
        sessionRef,
        timestamp: new Date().toISOString(),
        message: {
          id: "row-pi-never-wrote",
          text: "A message Pi never wrote",
          mode: "followUp",
          createdAt: new Date().toISOString(),
        },
      });
      await editMessage(window, "A message Pi never wrote");
      await expect(errorBanner).toContainText(
        "Couldn't edit the message. This message is not on the thread's current branch",
      );
      await expect(errorBanner).not.toContainText("Error invoking remote method");
      await expect
        .poll(() => mainLog.join(""))
        .toContain("[app-store] editing message row-pi-never-wrote");
      // Later app snapshots (a thread switch publishes several) leave it in place.
      await selectSession(window, "Other thread");
      await selectSession(window, "Stopped thread");
      await expect(errorBanner).toContainText("Couldn't edit the message.");
      await errorBanner.getByRole("button", { name: "Dismiss error" }).click();
      await expect(errorBanner).toHaveCount(0);
    });
  } finally {
    releaseStalls();
    await harness.close();
    await server.close();
  }
});
