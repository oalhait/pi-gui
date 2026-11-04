import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
  type ScriptedReply,
} from "../helpers/scripted-openai-server";

const RESUME_TEXT = "pi-gui was restarted to install a new build";
const neverSettles = new Promise<void>(() => undefined);

/** A first prompt stays in flight forever; the restart message gets a real answer. */
function reply(request: ScriptedChatRequest): ScriptedReply {
  if (request.toolNames.length === 0) return { text: "Thread title" };
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  if (last?.content.includes(RESUME_TEXT)) return { text: "Picked up after the restart." };
  return { thinking: ["Working on it"], holdAfterThinking: neverSettles, text: "unreachable" };
}

async function runningSessionIds(window: import("@playwright/test").Page) {
  const state = await getDesktopState(window);
  return state.workspaces.flatMap((workspace) =>
    workspace.sessions.filter((session) => session.status === "running").map((s) => s.id),
  );
}

test("a restart for a new build continues the threads it cut off, and only those", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("restart-resume");
  const server = await startScriptedOpenAiServer(reply);
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
          models: [{ id: "scripted", reasoning: true }],
        },
      },
    }),
  );
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  let runningId = "";
  let harness = await launch();
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Idle thread");
    await createNamedThread(window, "Running thread");
    runningId = (await getDesktopState(window)).selectedSessionId ?? "";
    const composer = window.getByTestId("composer");
    await composer.fill("Start a long job");
    await composer.press("Enter");
    await expect.poll(() => runningSessionIds(window)).toEqual([runningId]);

    // What `pnpm app:restart` writes just before it quits the app.
    await writeFile(
      join(userDataDir, "restart-request.json"),
      JSON.stringify({ version: 1, requestedAt: new Date().toISOString() }),
    );
  } finally {
    await harness.close();
  }

  const recorded = JSON.parse(
    await readFile(join(userDataDir, "resume-after-restart.json"), "utf8"),
  ) as { sessions: { sessionId: string }[] };
  expect(recorded.sessions.map((session) => session.sessionId)).toEqual([runningId]);
  await expect(readFile(join(userDataDir, "restart-request.json"))).rejects.toThrow();

  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Running thread");
    const transcript = window.getByTestId("transcript");
    await expect(transcript.locator(".timeline-item--user", { hasText: RESUME_TEXT })).toHaveCount(
      1,
    );
    await expect(
      transcript.locator(".timeline-item--assistant", { hasText: "Picked up after the restart." }),
    ).toHaveCount(1);
    await expect(readFile(join(userDataDir, "resume-after-restart.json"))).rejects.toThrow();

    await selectSession(window, "Idle thread");
    await expect(transcript).not.toContainText(RESUME_TEXT);

    // An ordinary quit with a run going records nothing.
    await selectSession(window, "Running thread");
    const composer = window.getByTestId("composer");
    await composer.fill("Another long job");
    await composer.press("Enter");
    await expect.poll(() => runningSessionIds(window)).toEqual([runningId]);
  } finally {
    await harness.close();
  }
  await expect(readFile(join(userDataDir, "resume-after-restart.json"))).rejects.toThrow();
  await server.close();
});
