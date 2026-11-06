import test from "node:test";
import assert from "node:assert/strict";
import { sessionKey } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/session-supervisor.js";

function fixture(overrides: { status?: string; pendingMessageCount?: number } = {}) {
  const record = {
    ref: { workspaceId: "/tmp/move-a", sessionId: "thread" },
    workspace: { workspaceId: "/tmp/move-a", path: "/tmp/move-a" },
    title: "A thread",
    status: overrides.status ?? "idle",
    sessionFile: "/tmp/move-a/session.jsonl",
    runningRunId: undefined as string | undefined,
    promptStarting: false,
    extensionCommandsRunning: 0,
    queuedStartScheduled: false,
    sendsSettling: 0,
    queueStepsPending: 0,
    reloadInFlight: undefined,
    queuedMessages: [] as unknown[],
    startingQueuedMessage: undefined,
    pendingHostUiRequests: new Map(),
    closed: false,
    listeners: new Set(),
    session: {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: overrides.pendingMessageCount ?? 0,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      sessionManager: { getSessionFile: () => "/tmp/move-a/session.jsonl" },
    },
  };
  const supervisor = new SessionSupervisor({ catalogStorage: {} as never });
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(
    sessionKey(record.ref),
    record,
  );
  return { supervisor, record };
}

await test("a thread with work in flight does not move", async () => {
  const f = fixture({ pendingMessageCount: 1 });
  await assert.rejects(
    f.supervisor.moveSession(f.record.ref, {
      targetWorkspace: { workspaceId: "/tmp/move-b", path: "/tmp/move-b" },
    }),
    /Only an idle thread can move/,
  );
});

await test("moving a thread into its own folder is refused", async () => {
  const f = fixture();
  await assert.rejects(
    f.supervisor.moveSession(f.record.ref, {
      targetWorkspace: { workspaceId: "/tmp/move-a", path: "/tmp/move-a" },
    }),
    /already in that folder/,
  );
});
