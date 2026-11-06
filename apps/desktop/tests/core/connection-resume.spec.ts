import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
import { readOptionalLog } from "../helpers/notification-events";
import { setSessionVisibilityOverride } from "../helpers/session-event-test-helpers";

/**
 * A run whose provider connection keeps dropping. Real pi agent loop, real HTTP: the endpoint
 * below closes the socket without answering, which the OpenAI SDK reports as
 * "Connection error.", the same class of failure as the Anthropic "Request timed out." runs
 * that pi's own retries could not outlast.
 */
type Answer = "drop" | "unauthorized" | { readonly text: string };

interface FlakyEndpoint {
  readonly baseUrl: string;
  /** Agent-turn requests so far (thread-title requests are not counted). */
  readonly turnRequests: () => number;
  readonly close: () => Promise<void>;
}

async function startFlakyEndpoint(answer: (turnRequest: number) => Answer): Promise<FlakyEndpoint> {
  let turnRequests = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as { tools?: unknown[] };
      // Thread titles are generated without tools; they always succeed.
      const next = payload.tools?.length ? answer(++turnRequests) : { text: "Thread title" };
      if (next === "drop") {
        request.socket.destroy();
        return;
      }
      if (next === "unauthorized") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Incorrect API key provided", type: "invalid_api_key" },
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finishReason: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: "flaky",
            object: "chat.completion.chunk",
            model: "flaky",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      chunk({ role: "assistant", content: next.text }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    turnRequests: () => turnRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function launchWithEndpoint(name: string, endpoint: FlakyEndpoint, resumeDelaysMs: string) {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const notificationLogPath = join(userDataDir, "notifications.jsonl");
  const workspacePath = await makeWorkspace(name);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["flaky-test/flaky"],
  });
  // pi's own retry stays on, shortened: one retry, 100 ms apart, before the run would settle.
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "flaky-test",
      defaultModel: "flaky",
      enabledModels: ["flaky-test/flaky"],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "flaky-test": {
          baseUrl: endpoint.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "flaky" }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    notificationLogPath,
    envOverrides: { PI_APP_TEST_CONNECTION_RESUME_DELAYS_MS: resumeDelaysMs },
  });
  const window = await harness.firstWindow();
  await createNamedThread(window, "Flaky thread");
  // Not looked at, so a finished or failed run would notify.
  await setSessionVisibilityOverride(harness, "inactive");
  return { harness, window, notificationLogPath };
}

async function selectedStatus(window: Page): Promise<string | undefined> {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
}

test("a run that loses its connection resumes on its own and completes", async () => {
  test.setTimeout(120_000);
  // pi tries twice per round; two rounds fail, then the connection is back.
  const endpoint = await startFlakyEndpoint((n) => (n <= 4 ? "drop" : { text: "Back online." }));
  const { harness, window, notificationLogPath } = await launchWithEndpoint(
    "connection-resume",
    endpoint,
    "1500,1500",
  );
  try {
    await send(window, "Do the work");
    const transcript = window.getByTestId("transcript");
    const retryLine = window.getByTestId("timeline-connection-retry");
    await expect(retryLine).toContainText("Connection lost. Retrying in");
    await expect(window.getByTestId("connection-retry-cancel")).toBeVisible();
    await expect(retryLine).toHaveAttribute("title", "Connection error.");
    expect(await selectedStatus(window)).toBe("running");

    await expect(
      transcript.locator(".timeline-item--assistant", { hasText: "Back online." }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => selectedStatus(window)).toBe("idle");
    await expect(retryLine).toHaveCount(0);
    expect(endpoint.turnRequests()).toBe(5);
    await expect(transcript).not.toContainText("Connection error.");
    // One user message: the run continued, nothing was sent on the person's behalf.
    await expect(transcript.locator(".timeline-item--user")).toHaveCount(1);

    // The completion notifies; the dropped attempts never did.
    await expect
      .poll(async () => (await readOptionalLog(notificationLogPath)).trim().split("\n").length)
      .toBe(1);
    const log = await readOptionalLog(notificationLogPath);
    expect(log).toContain("Back online.");
    expect(log).not.toMatch(/Failed|Connection error/);
  } finally {
    await harness.close();
    await endpoint.close();
  }
});

test("an error that is not about the connection fails at once", async () => {
  test.setTimeout(120_000);
  const endpoint = await startFlakyEndpoint(() => "unauthorized");
  const { harness, window, notificationLogPath } = await launchWithEndpoint(
    "connection-resume-auth",
    endpoint,
    "1500,1500",
  );
  try {
    await send(window, "Do the work");
    await expect.poll(() => selectedStatus(window), { timeout: 15_000 }).toBe("failed");
    expect(endpoint.turnRequests()).toBe(1);
    await expect(window.getByTestId("timeline-connection-retry")).toHaveCount(0);
    // The failure notifies at once, with the provider's reason.
    await expect
      .poll(() => readOptionalLog(notificationLogPath))
      .toContain("Incorrect API key provided");
  } finally {
    await harness.close();
    await endpoint.close();
  }
});

test("Cancel ends the wait and leaves the thread stopped, not failed", async () => {
  test.setTimeout(120_000);
  const endpoint = await startFlakyEndpoint(() => "drop");
  const { harness, window, notificationLogPath } = await launchWithEndpoint(
    "connection-resume-cancel",
    endpoint,
    "30000",
  );
  try {
    await send(window, "Do the work");
    const retryLine = window.getByTestId("timeline-connection-retry");
    await expect(retryLine).toContainText("Connection lost. Retrying in");
    const requestsBeforeCancel = endpoint.turnRequests();
    await window.getByTestId("connection-retry-cancel").click();

    await expect.poll(() => selectedStatus(window)).toBe("idle");
    await expect(retryLine).toHaveCount(0);
    await expect(window.getByTestId("timeline-working")).toHaveCount(0);
    // Long enough for a resume that should not happen to have reached the endpoint.
    await window.waitForTimeout(1_500);
    expect(endpoint.turnRequests()).toBe(requestsBeforeCancel);
    expect(await selectedStatus(window)).toBe("idle");
    expect(await readOptionalLog(notificationLogPath)).toBe("");
  } finally {
    await harness.close();
    await endpoint.close();
  }
});
