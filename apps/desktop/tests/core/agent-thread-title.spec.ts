import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  resolveDeferredThreadTitle,
  seedAgentDir,
  setDeferredThreadTitleMode,
  startThreadFromSurface,
  waitForDeferredThreadTitleRequest,
} from "../helpers/electron-app";
import {
  startScriptedOpenAiServer,
  type ScriptedChatRequest,
  type ScriptedReply,
} from "../helpers/scripted-openai-server";

/** A pi agent dir whose only model is the scripted OpenAI-compatible endpoint. */
async function seedScriptedAgent(agentDir: string, baseUrl: string): Promise<void> {
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
          baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "scripted" }],
        },
      },
    }),
  );
}

const userMessages = (request: ScriptedChatRequest) =>
  request.messages.filter((message) => message.role === "user").map((message) => message.content);
const lastMessage = (request: ScriptedChatRequest) => request.messages.at(-1);

function chatTitle(window: Page) {
  return window.locator(".chat-header__title");
}

function sidebarRow(window: Page, title: string) {
  return window.locator(".session-row__select", { hasText: title });
}

function toolRow(window: Page, label: string) {
  return window.getByTestId("transcript").locator(".timeline-tool", { hasText: label });
}

test("the agent names its chat in the first exchange, a later turn cannot, and the name persists", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("agent-thread-title");
  const server = await startScriptedOpenAiServer((request): ScriptedReply => {
    if (lastMessage(request)?.role === "tool") return { text: "Done." };
    if (userMessages(request).length > 1) {
      // A model that ignores the guideline still cannot rename in a later turn.
      return { tool: "rename_thread", args: { title: "Second turn title" } };
    }
    return { tool: "rename_thread", args: { title: "  Sidebar   CSS review " } };
  });
  await seedScriptedAgent(agentDir, server.baseUrl);
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  let harness = await launch();
  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    await startThreadFromSurface(window, {
      prompt: "hey can you look at something for me in this repo: the sidebar css",
    });

    await test.step("the first reply renames the chat live, ahead of the pending auto-title", async () => {
      await waitForDeferredThreadTitleRequest(harness);
      await expect(chatTitle(window)).toHaveText("Sidebar CSS review");
      await expect(sidebarRow(window, "Sidebar CSS review")).toHaveCount(1);
      await expect(toolRow(window, 'Renamed chat to "Sidebar CSS review"')).toHaveCount(1);
      await expect(
        window.getByTestId("transcript").locator(".timeline-item--assistant", { hasText: "Done." }),
      ).toHaveCount(1);
      expect(server.requests.find((r) => r.toolNames.length > 0)?.toolNames).toContain(
        "rename_thread",
      );
    });

    await test.step("a late auto-title does not replace the agent's name", async () => {
      await resolveDeferredThreadTitle(harness, "Vague look request");
      await expect(sidebarRow(window, "Vague look request")).toHaveCount(0);
      await expect(chatTitle(window)).toHaveText("Sidebar CSS review");
    });

    await test.step("a second turn is not offered the tool and cannot rename", async () => {
      const requestsBefore = server.requests.length;
      const composer = window.getByTestId("composer");
      await composer.fill("thanks, now the second message");
      await composer.press("Enter");
      await expect(
        window.getByTestId("transcript").locator(".timeline-item--assistant", { hasText: "Done." }),
      ).toHaveCount(2);
      const secondTurn = server.requests.slice(requestsBefore);
      expect(secondTurn.length).toBeGreaterThan(0);
      for (const request of secondTurn) expect(request.toolNames).not.toContain("rename_thread");
      await expect(chatTitle(window)).toHaveText("Sidebar CSS review");
      await expect(sidebarRow(window, "Second turn title")).toHaveCount(0);
    });
  } finally {
    await harness.close();
  }

  harness = await launch();
  try {
    const window = await harness.firstWindow();
    await expect(sidebarRow(window, "Sidebar CSS review")).toHaveCount(1);
    await expect(sidebarRow(window, "Vague look request")).toHaveCount(0);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("the agent cannot replace a title the user set from the sidebar during the first run", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("agent-thread-title-manual");
  const gate = join(workspacePath, "renamed.flag");
  const server = await startScriptedOpenAiServer((request): ScriptedReply => {
    const toolResults = request.messages.filter((message) => message.role === "tool").length;
    if (toolResults === 0) {
      // Holds the first run in a tool call until the user has renamed the chat.
      return {
        tool: "bash",
        args: { command: `while [ ! -f '${gate}' ]; do sleep 0.1; done; echo renamed` },
      };
    }
    if (toolResults === 1) return { tool: "rename_thread", args: { title: "Agent title" } };
    return { text: "Done." };
  });
  await seedScriptedAgent(agentDir, server.baseUrl);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    await startThreadFromSurface(window, { prompt: "look at something" });
    await waitForDeferredThreadTitleRequest(harness);
    await expect(window.getByRole("button", { name: "Stop run" })).toBeVisible();

    const row = window.locator(".session-row", { hasText: "New thread" }).first();
    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Rename thread" }).click();
    await window.getByLabel("Rename thread New thread").fill("My own title");
    await window.getByRole("button", { name: "Save" }).click();
    await expect(chatTitle(window)).toHaveText("My own title");
    await writeFile(gate, "");

    const refused = toolRow(window, 'Renamed chat to "Agent title"');
    await expect(refused).toHaveClass(/timeline-tool--error/);
    await expect(refused).toContainText("user named this chat");
    await expect(
      window.getByTestId("transcript").locator(".timeline-item--assistant", { hasText: "Done." }),
    ).toHaveCount(1);
    await expect(chatTitle(window)).toHaveText("My own title");
    await expect(sidebarRow(window, "Agent title")).toHaveCount(0);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("a child thread names itself and its parent sees the new title", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("agent-thread-title-child");
  let listedThreads = "";
  const server = await startScriptedOpenAiServer((request): ScriptedReply => {
    const users = userMessages(request);
    const last = lastMessage(request);
    if (users[0]?.startsWith("child:")) {
      if (last?.role === "tool") return { text: "Child done." };
      return { tool: "rename_thread", args: { title: "Child sidebar audit" } };
    }
    if (users.length === 1) {
      if (last?.role === "tool") return { text: "Started the child." };
      return { tool: "create_child_thread", args: { prompt: "child: audit the sidebar" } };
    }
    if (last?.role === "tool") {
      listedThreads = last.content;
      return { text: "Listed." };
    }
    return { tool: "list_threads", args: {} };
  });
  await seedScriptedAgent(agentDir, server.baseUrl);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    await startThreadFromSurface(window, { prompt: "parent: delegate the sidebar audit" });
    const transcript = window.getByTestId("transcript");
    await expect(
      transcript.locator(".timeline-item--assistant", { hasText: "Started the child." }),
    ).toHaveCount(1);
    await expect
      .poll(async () =>
        (await getDesktopState(window)).orchestrationChildren.map((child) => child.title),
      )
      .toEqual(["Child sidebar audit"]);

    const composer = window.getByTestId("composer");
    await composer.fill("list the threads");
    await composer.press("Enter");
    await expect(
      transcript.locator(".timeline-item--assistant", { hasText: "Listed." }),
    ).toHaveCount(1);
    expect(listedThreads).toContain("Child sidebar audit");
  } finally {
    await harness.close();
    await server.close();
  }
});
