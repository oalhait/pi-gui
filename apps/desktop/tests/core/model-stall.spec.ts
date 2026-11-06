import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

/**
 * A provider that accepts a long-context request and then never answers, like the Opus runs
 * that sat on "Waiting for the model" for minutes: real pi agent loop, real Anthropic SDK and
 * real HTTP. The endpoint below speaks the Anthropic Messages API. "pings" sends the response
 * headers and then only `event: ping` until the client gives up; "terminate" pings briefly and
 * then drops the connection mid-stream (pi reports "terminated"); "answer" replies.
 */
type Behavior = "pings" | "terminate" | "answer";

interface AnthropicEndpoint {
  readonly baseUrl: string;
  /** Agent-turn requests so far (thread-title requests are not counted). */
  readonly turnRequests: () => number;
  readonly close: () => Promise<void>;
}

const STALL_MS = 2_500;

async function startAnthropicEndpoint(
  behavior: (turnRequest: number) => Behavior,
): Promise<AnthropicEndpoint> {
  let turnRequests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as { tools?: unknown[] };
      // Thread titles are generated without tools; they always answer.
      const next = payload.tools?.length ? behavior(++turnRequests) : "answer";
      const text = payload.tools?.length ? "Here is the answer." : "Thread title";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `req_stall_${turnRequests}`,
      });
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (next === "pings" || next === "terminate") {
        const timer = setInterval(() => send("ping", { type: "ping" }), 300);
        response.on("close", () => clearInterval(timer));
        if (next === "terminate") setTimeout(() => request.socket.destroy(), 1_000);
        return;
      }
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_stall",
          type: "message",
          role: "assistant",
          model: "claude-stall",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      send("ping", { type: "ping" });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      });
      send("message_stop", { type: "message_stop" });
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    turnRequests: () => turnRequests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function launchWithEndpoint(name: string, endpoint: AnthropicEndpoint) {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace(name);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["stall-test/claude-stall"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "stall-test",
      defaultModel: "claude-stall",
      enabledModels: ["stall-test/claude-stall"],
      cacheWarming: "off",
      // Long enough to read Pi's retry countdown.
      retry: { baseDelayMs: 3_000 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "stall-test": {
          baseUrl: endpoint.baseUrl,
          api: "anthropic-messages",
          apiKey: "unused",
          models: [{ id: "claude-stall", contextWindow: 200_000, maxTokens: 4_096 }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_MODEL_STALL_MS: String(STALL_MS),
      // A connection resume, were one to start, would show within the test.
      PI_APP_TEST_CONNECTION_RESUME_DELAYS_MS: "500,500",
    },
  });
  const window = await harness.firstWindow();
  await createNamedThread(window, "Stall thread");
  return { harness, window, runsLog: join(userDataDir, "logs", "runs.log") };
}

async function selectedSession(window: Page) {
  const state = await getDesktopState(window);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId);
}

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await composer.press("Enter");
}

interface LogEntry {
  readonly kind: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly [key: string]: unknown;
}

async function readRunsLog(path: string): Promise<LogEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

test("a request that only gets pings shows its real state, is retried once and recovers", async () => {
  test.setTimeout(120_000);
  const endpoint = await startAnthropicEndpoint((n) => (n === 1 ? "pings" : "answer"));
  const { harness, window, runsLog } = await launchWithEndpoint("model-stall", endpoint);
  try {
    await send(window, "Explain the jobs");
    const wait = window.getByTestId("timeline-model-wait");
    const transcript = window.getByTestId("transcript");

    // Not just "Waiting for the model": the provider accepted it and is only pinging.
    await expect(wait).toHaveText(
      /^Request accepted, \d+ keep-alive pings?, waiting for the model · \d+s$/,
    );
    // The stall detector ends the attempt and Pi's retry says why.
    await expect(wait).toHaveText(
      /^Model request failed \(no output from the model\)\. Retrying in [1-3]s, attempt 1 of 3$/,
      { timeout: 10_000 },
    );
    await expect(wait).toHaveAttribute("title", /^The model stalled: no output for 3s/);
    await expect(window.getByTestId("timeline-connection-retry")).toHaveCount(0);

    await expect(
      transcript.locator(".timeline-item--assistant", { hasText: "Here is the answer." }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(async () => (await selectedSession(window))?.status).toBe("idle");
    await expect(wait).toHaveCount(0);
    expect(endpoint.turnRequests()).toBe(2);
    await expect(transcript.locator(".timeline-item--user")).toHaveCount(1);
    await expect(transcript).not.toContainText("stalled");

    // The runs log tells the same story, without any prompt or reply text.
    const sessionId = (await selectedSession(window))?.id;
    await expect
      .poll(async () => (await readRunsLog(runsLog)).some((e) => e.kind === "run_end"))
      .toBe(true);
    const entries = (await readRunsLog(runsLog)).filter(
      (entry) => entry.sessionId === sessionId && entry.cacheWarm !== true,
    );
    const turn = entries.filter((entry) => entry.runId === entries.at(-1)?.runId);
    expect(turn.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "request_start",
        "response_headers",
        "stall",
        "request_end",
        "retry_backoff",
        "first_event",
        "first_output",
        "retry_end",
        "run_end",
      ]),
    );
    const headers = turn.find((entry) => entry.kind === "response_headers");
    expect(headers).toMatchObject({ status: 200, requestId: "req_stall_1" });
    expect(turn.find((entry) => entry.kind === "stall")).toMatchObject({
      phase: "accepted",
      action: "retry",
      timeoutMs: STALL_MS,
    });
    expect(turn.find((entry) => entry.kind === "run_end")).toMatchObject({
      outcome: "completed",
    });
    const raw = await readFile(runsLog, "utf8");
    expect(raw).not.toContain("Explain the jobs");
    expect(raw).not.toContain("Here is the answer.");
  } finally {
    await harness.close();
    await endpoint.close();
  }
});

test("a provider that keeps stalling, with a dropped stream in between, fails visibly", async () => {
  test.setTimeout(120_000);
  const endpoint = await startAnthropicEndpoint((n) => (n === 2 ? "terminate" : "pings"));
  const { harness, window, runsLog } = await launchWithEndpoint("model-stall-fail", endpoint);
  try {
    await send(window, "Explain the jobs");
    const wait = window.getByTestId("timeline-model-wait");
    await expect(wait).toHaveText(/no output from the model/, { timeout: 10_000 });
    // The dropped stream is Pi's ordinary retry, shown with its own reason.
    await expect(wait).toHaveText(/connection error.*attempt 2 of 3/, { timeout: 15_000 });

    await expect
      .poll(async () => (await selectedSession(window))?.status, { timeout: 30_000 })
      .toBe("failed");
    await expect(wait).toHaveCount(0);
    await expect(window.getByTestId("timeline-working")).toHaveCount(0);
    await expect(window.getByTestId("timeline-connection-retry")).toHaveCount(0);
    expect((await selectedSession(window))?.preview).toMatch(/^The model stalled again/);
    // Neither Pi nor connection-resume tries a fourth time.
    await window.waitForTimeout(1_500);
    expect(endpoint.turnRequests()).toBe(3);

    const entries = await readRunsLog(runsLog);
    expect(entries.filter((entry) => entry.kind === "stall").map((entry) => entry.action)).toEqual([
      "retry",
      "fail",
    ]);
    expect(entries.some((entry) => entry.kind === "connection_resume_wait")).toBe(false);
    expect(
      entries.find((entry) => entry.kind === "request_end" && entry.error === "terminated"),
    ).toBeTruthy();
    expect(entries.at(-1)).toMatchObject({ kind: "run_end", outcome: "failed" });
  } finally {
    await harness.close();
    await endpoint.close();
  }
});

test("Settings sets how long a request may stall, saved in its own file", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("model-stall-settings");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const select = window.getByLabel("Retry a stalled model request after");
    await expect(select).toHaveValue("120");
    await select.selectOption({ label: "Never" });
    await expect.poll(async () => (await getDesktopState(window)).modelStallTimeoutSeconds).toBe(0);
    expect(JSON.parse(await readFile(join(userDataDir, "run-settings.json"), "utf8"))).toEqual({
      version: 1,
      modelStallTimeoutSeconds: 0,
    });
    await select.selectOption({ label: "5 min" });
    await expect
      .poll(async () => (await getDesktopState(window)).modelStallTimeoutSeconds)
      .toBe(300);
  } finally {
    await harness.close();
  }
});
