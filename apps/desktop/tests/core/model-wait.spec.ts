import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
  type ScriptedReply,
} from "../helpers/scripted-openai-server";

/** Resolved by the test to let a held reply start streaming. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function sessionStatus(window: Page) {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

test("the Working line shows the wait for the model's first output and Pi's retries", async () => {
  test.setTimeout(180_000);
  const slow = gate();
  const largeSlow = gate();
  let overloadedRequests = 0;
  const answer = (request: ScriptedChatRequest): ScriptedReply => {
    if (request.toolNames.length === 0) return { text: "Thread title" };
    const ask = [...request.messages].reverse().find((message) => message.role === "user");
    const asked = ask?.content ?? "";
    const text = `Answer to ${asked}`;
    if (asked === "Slow question") return { text, holdBeforeFirstChunk: slow.opened };
    if (asked === "Overloaded once" && (overloadedRequests += 1) === 1) {
      return { error: { status: 529, message: "Overloaded" } };
    }
    // Reports a large prompt, so the next request carries a large context.
    if (asked === "Read the big document") return { text, promptTokens: 407_000 };
    if (asked === "Question about it") return { text, holdBeforeFirstChunk: largeSlow.opened };
    return { text };
  };
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("model-wait");
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
      // Long enough to read the countdown before Pi retries.
      retry: { baseDelayMs: 4_000 },
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
          models: [{ id: "scripted", contextWindow: 1_000_000 }],
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
    await createNamedThread(window, "Wait thread");
    const composer = window.getByTestId("composer");
    const wait = window.getByTestId("timeline-model-wait");
    const notes = window.getByTestId("timeline-model-wait-note");
    const reply = (text: string) =>
      window.locator(".timeline-item--assistant", { hasText: `Answer to ${text}` });

    await test.step("a reply that has not started yet", async () => {
      await composer.fill("Slow question");
      await composer.press("Enter");
      // The scripted provider sent its response headers, so the request has been accepted.
      await expect(wait).toHaveText(/^Request accepted, waiting for the model · \d+s$/);
      await expect(wait).toHaveText(/· [2-9]s$/);
      await expect(notes).toHaveCount(0);
      slow.open();
      await expect(reply("Slow question")).toHaveCount(1);
      await expect(wait).toHaveCount(0);
      await expect.poll(() => sessionStatus(window)).toBe("idle");
    });

    await test.step("a request Pi retries after the provider is overloaded", async () => {
      await composer.fill("Overloaded once");
      await composer.press("Enter");
      await expect(wait).toHaveText(
        /^Model request failed \(provider overloaded\)\. Retrying in [1-4]s, attempt 1 of 3$/,
      );
      await expect(wait).toHaveAttribute("title", /Overloaded/);
      await expect(reply("Overloaded once")).toHaveCount(1);
      await expect(wait).toHaveCount(0);
      expect(overloadedRequests).toBe(2);
      await expect.poll(() => sessionStatus(window)).toBe("idle");
    });

    await test.step("a request that carries a large context", async () => {
      await composer.fill("Read the big document");
      await composer.press("Enter");
      await expect(reply("Read the big document")).toHaveCount(1);
      await expect.poll(() => sessionStatus(window)).toBe("idle");

      await composer.fill("Question about it");
      await composer.press("Enter");
      await expect(wait).toHaveText(/^Request accepted, waiting for the model/);
      // The scripted model declares no prompt cache, so its expiry is unknown.
      await expect(notes).toHaveText([
        /^Large context \(40\dk tokens\), so the first response may take a while\.$/,
      ]);
      largeSlow.open();
      await expect(reply("Question about it")).toHaveCount(1);
      await expect(wait).toHaveCount(0);
    });
  } finally {
    slow.open();
    largeSlow.open();
    await harness.close();
    await server.close();
  }
});
