import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent, SessionModelWait } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];
type StreamOptions = Parameters<StreamFunction>[2];

/** How the scripted model answers one request. */
export type Reply =
  | { readonly kind: "text"; readonly text: string; readonly afterMs?: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "hang" };

function assistant(
  model: Parameters<StreamFunction>[0],
  fields: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...fields,
  };
}

/** Real installed pi with persisted session entries; only the provider is scripted. */
export async function scriptedModelDriver(
  t: TestContext,
  replies: Reply[],
  options: { slowListenerMs?: number },
) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-model-wait-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { baseDelayMs: 200 },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "wait-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const stream: StreamFunction = (model, _context, streamOptions?: StreamOptions) => {
    const reply = replies.shift() ?? { kind: "text", text: "Default answer" };
    const events = createAssistantMessageEventStream();
    if (reply.kind === "hang") {
      // Accepted, then silent until the run is stopped.
      streamOptions?.signal?.addEventListener("abort", () => {
        events.push({
          type: "error",
          reason: "aborted",
          error: assistant(model, { stopReason: "aborted", errorMessage: "aborted" }),
        });
      });
      return events;
    }
    if (reply.kind === "error") {
      events.push({
        type: "error",
        reason: "error",
        error: assistant(model, { stopReason: "error", errorMessage: reply.message }),
      });
      return events;
    }
    const message = assistant(model, { content: [{ type: "text", text: reply.text }] });
    setTimeout(() => {
      events.push({ type: "start", partial: assistant(model, {}) });
      events.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
      events.push({ type: "done", reason: "stop", message });
    }, reply.afterMs ?? 0);
    return events;
  };
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: [],
      });
      runtime.session.agent.streamFunction = stream;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "wait-workspace", path: cwd },
    { initialModel: { provider: "wait-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(ref, async (event) => {
    events.push(event);
    // A busy app takes this long to apply each event.
    if (options.slowListenerMs) await new Promise((r) => setTimeout(r, options.slowListenerMs));
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let tries = 0; tries < 400 && !predicate(); tries += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(predicate(), "timed out waiting");
  };
  return { driver, ref, events, waitFor };
}

export const runningWaits = (
  events: readonly SessionDriverEvent[],
): (SessionModelWait | undefined)[] =>
  events.flatMap((event) =>
    event.type === "sessionUpdated" && event.snapshot.status === "running"
      ? [event.snapshot.modelWait]
      : [],
  );
