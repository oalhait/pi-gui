import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("a real agent uses workbench to open a local preview in the native browser", async () => {
  test.setTimeout(180_000);
  const authConfig = getRealAuthConfig();
  test.skip(!authConfig.enabled, authConfig.skipReason);
  const provider = process.env.PI_GUI_PROVIDER ?? "openai-codex";
  const model = process.env.PI_GUI_MODEL ?? "gpt-6.1-sol";
  const auth = JSON.parse(
    await readFile(join(authConfig.sourceDir!, "auth.json"), "utf8"),
  ) as Record<string, unknown>;
  if (!auth[provider]) throw new Error(`Missing saved authentication for ${provider}`);
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-workbench-private-"));
  await chmod(privateRoot, 0o700);
  const agentDir = join(privateRoot, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${model}`],
    }),
  );
  const server = createServer((_request, response) =>
    response.end("<title>Agent opened preview</title><h1>Workbench tool proof</h1>"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing preview port");
  const url = `http://127.0.0.1:${port.port}/`;
  const launch =
    process.env.PI_GUI_WORKBENCH_PACKAGED === "1" ? launchPackagedDesktop : launchDesktop;
  const harness = await launch(await makeUserDataDir(), {
    agentDir,
    initialWorkspaces: [await makeWorkspace("live-workbench")],
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const window = await harness.firstWindow();
    expect(
      await harness.electronApp.evaluate(() =>
        Boolean((globalThis as Record<string, unknown>).__PI_APP_TEST_HOOKS),
      ),
    ).toBe(false);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window
      .getByLabel("New thread prompt", { exact: true })
      .fill(
        `Use the workbench tool now to open ${url} in pi-gui's side pane browser. Do not use bash, external browsers, or desktop automation. After the tool succeeds, reply only WORKBENCH_READY.`,
      );
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "Browser address" })).toHaveValue(url, {
      timeout: 150_000,
    });
    await expect(
      window.getByRole("tab", { name: "Agent opened preview", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(async ({ webContents, BrowserWindow }, url) => {
          const page = webContents.getAllWebContents().find((page) => page.getURL() === url);
          if (!page) return false;
          const text: unknown = await page.executeJavaScript("document.body.innerText");
          return (
            typeof text === "string" &&
            text.includes("Workbench tool proof") &&
            BrowserWindow.getAllWindows().some((window) =>
              window.contentView.children.some(
                (view) => "webContents" in view && view.webContents === page && view.getVisible(),
              ),
            )
          );
        }, url),
      )
      .toBe(true);

    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("WORKBENCH_READY", { timeout: 150_000 });
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.status;
      })
      .toBe("idle");
    await window.screenshot({ path: test.info().outputPath("real-agent-browser.png") });
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Tool calls recorded in the private profile's Pi session files, in order. */
async function recordedToolCalls(agentDir: string) {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(join(agentDir, "sessions"), { recursive: true })).filter((file) =>
    file.endsWith(".jsonl"),
  );
  const calls: { name: string; arguments: unknown }[] = [];
  for (const file of files)
    for (const line of (await readFile(join(agentDir, "sessions", file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        message?: {
          role?: string;
          content?: { type: string; name?: string; arguments?: unknown }[];
        };
      };
      if (entry.message?.role !== "assistant") continue;
      for (const part of entry.message.content ?? [])
        if (part.type === "toolCall" && part.name)
          calls.push({ name: part.name, arguments: part.arguments });
    }
  return calls;
}

test("a real agent captures the side pane browser when asked what is in it", async () => {
  test.setTimeout(240_000);
  const authConfig = getRealAuthConfig();
  test.skip(!authConfig.enabled, authConfig.skipReason);
  const provider = process.env.PI_GUI_PROVIDER ?? "openai-codex";
  const model = process.env.PI_GUI_MODEL ?? "gpt-6.1-sol";
  const auth = JSON.parse(
    await readFile(join(authConfig.sourceDir!, "auth.json"), "utf8"),
  ) as Record<string, unknown>;
  if (!auth[provider]) throw new Error(`Missing saved authentication for ${provider}`);
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-workbench-capture-private-"));
  await chmod(privateRoot, 0o700);
  const agentDir = join(privateRoot, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${model}`],
      // tool_search active from the start, as when a deferred MCP server (e.g. Slack) is configured.
      defaultTools: ["+tool_search"],
    }),
  );
  // The distinctive words are only painted in the page body, not in its title or URL.
  const server = createServer((_request, response) =>
    response.end(
      "<title>Team dashboard</title><body style='font:32px sans-serif;padding:24px'><h1>Quarterly kiwi forecast</h1><p>Orbit code: VIOLET-4729</p><a href='/docs/kiwi-terms-8812'>Terms</a></body>",
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address();
  if (!port || typeof port === "string") throw new Error("Missing preview port");
  const url = `http://127.0.0.1:${port.port}/`;
  const harness = await launchDesktop(await makeUserDataDir(), {
    agentDir,
    initialWorkspaces: [await makeWorkspace("live-workbench-capture")],
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const window = await harness.firstWindow();
    const idle = () =>
      expect
        .poll(
          async () => {
            const state = await getDesktopState(window);
            return state.workspaces
              .flatMap((workspace) => workspace.sessions)
              .find((session) => session.id === state.selectedSessionId)?.status;
          },
          { timeout: 150_000 },
        )
        .toBe("idle");
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("Reply only READY.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("READY", { timeout: 150_000 });
    await idle();

    // The user opens the page in the side pane themselves.
    if (!(await window.getByTestId("workbench").isVisible()))
      await window.getByTestId("toggle-side-panel").click();
    await window.getByRole("button", { name: "Add tab", exact: true }).click();
    await window.getByRole("button", { name: "Browser", exact: true }).click();
    const address = window.getByRole("textbox", { name: "Browser address" });
    await address.fill(url);
    await address.press("Enter");
    await expect(window.getByRole("tab", { name: "Team dashboard", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await window.screenshot({ path: test.info().outputPath("before-question.png") });

    const composer = window.getByTestId("composer");
    const replies = window.locator(".timeline-item--assistant .message__content");
    const ask = async (question: string) => {
      const before = await replies.count();
      await composer.fill(question);
      await composer.press("Enter");
      await expect.poll(() => replies.count(), { timeout: 150_000 }).toBeGreaterThan(before);
      await idle();
    };
    await ask("What's in my browser view?");
    const answer = replies.last();
    await expect(answer).toContainText(/kiwi/i);
    await expect(answer).toContainText("4729");
    await window.screenshot({ path: test.info().outputPath("answer.png") });

    // Exact link targets are not visible in pixels; the agent should read the page text.
    await ask("What is the exact URL the Terms link in my browser view points to?");
    await expect(answer).toContainText("/docs/kiwi-terms-8812");

    const calls = await recordedToolCalls(agentDir);
    await writeFile(test.info().outputPath("tool-calls.json"), JSON.stringify(calls, null, 2));
    const captures = calls.filter(
      (call) =>
        call.name === "workbench" && (call.arguments as { action?: string }).action === "capture",
    );
    expect(captures.length).toBeGreaterThan(0);
    expect(
      calls.some(
        (call) =>
          call.name === "workbench" && (call.arguments as { action?: string }).action === "read",
      ),
    ).toBe(true);
    // Seen directly through workbench: no tool search, shell screenshots or desktop automation.
    expect(calls.map((call) => call.name).filter((name) => name !== "workbench")).toEqual([]);
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
