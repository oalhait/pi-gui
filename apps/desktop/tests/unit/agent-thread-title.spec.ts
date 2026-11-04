import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import { createWorkspaceOwner } from "../../electron/workspace/app-store-workspace";
import type { PendingAutoTitle } from "../../electron/conversation/session-state-map";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "../../electron/conversation/thread-title-constants";
import { timelineFromDriverTranscript } from "../../electron/conversation/app-store-timeline";
import {
  FIRST_EXCHANGE_ONLY_MESSAGE,
  createThreadTitleRuntimeExtension,
  isFirstExchange,
  normalizeAgentThreadTitle,
  renameThreadToolName,
  type TitleGateEntry,
} from "../../electron/workspace/thread-title-runtime";

const user = (): TitleGateEntry => ({ type: "message", message: { role: "user" } });
const assistant = (stopReason: string): TitleGateEntry => ({
  type: "message",
  message: { role: "assistant", stopReason },
});
const toolResult = (): TitleGateEntry => ({ type: "message", message: { role: "toolResult" } });

test.describe("title validation", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeAgentThreadTitle("  Fix   sidebar\tCSS  ")).toEqual({
      title: "Fix sidebar CSS",
    });
  });

  test("rejects missing, short, long and multi-line titles", () => {
    expect(normalizeAgentThreadTitle(undefined)).toHaveProperty("error");
    expect(normalizeAgentThreadTitle(42)).toHaveProperty("error");
    expect(normalizeAgentThreadTitle(" ab ")).toHaveProperty("error");
    expect(normalizeAgentThreadTitle("a".repeat(81))).toHaveProperty("error");
    expect(normalizeAgentThreadTitle("a".repeat(80))).toEqual({ title: "a".repeat(80) });
    expect(normalizeAgentThreadTitle("Fix sidebar\nand more")).toEqual({
      error: "The title must be a single line.",
    });
  });
});

test.describe("first exchange", () => {
  test("covers the first message and every tool call of the run answering it", () => {
    expect(isFirstExchange([user()])).toBe(true);
    expect(isFirstExchange([user(), assistant("toolUse"), toolResult()])).toBe(true);
  });

  test("a message steered in after a tool call still belongs to the first run", () => {
    expect(isFirstExchange([user(), assistant("toolUse"), toolResult(), user()])).toBe(true);
  });

  test("ends once a reply ends and the user sends again", () => {
    expect(isFirstExchange([user(), assistant("stop"), user()])).toBe(false);
    expect(isFirstExchange([user(), assistant("aborted"), user()])).toBe(false);
    expect(isFirstExchange([user(), user()])).toBe(false);
    expect(isFirstExchange([])).toBe(false);
  });
});

function fakePi(initialActive: string[] = ["read", "bash"]) {
  let active = [...initialActive];
  const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerTool: (tool: (typeof tools)[number]) => {
      tools.push(tool);
      active.push(tool.name);
    },
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
  };
  return {
    pi,
    active: () => active,
    tool: () => tools[0]!,
    beforeAgentStart: (messageType: "user" | "custom", entries: TitleGateEntry[]) =>
      handlers.get("before_agent_start")!({ messageType }, ctxFor(entries)),
  };
}

function ctxFor(entries: readonly TitleGateEntry[]) {
  return { sessionManager: { getBranch: () => entries } };
}

test.describe("rename_thread tool", () => {
  test("is offered only to the run answering a chat's first message", async () => {
    const fake = fakePi();
    await createThreadTitleRuntimeExtension(async (_ctx, title) => title)(fake.pi as never);
    expect(fake.active()).toContain(renameThreadToolName);

    void fake.beforeAgentStart("user", []);
    expect(fake.active()).toContain(renameThreadToolName);

    void fake.beforeAgentStart("user", [user(), assistant("stop")]);
    expect(fake.active()).toEqual(["read", "bash"]);

    void fake.beforeAgentStart("custom", []);
    expect(fake.active()).not.toContain(renameThreadToolName);
  });

  test("renames during the first exchange and returns the applied title", async () => {
    const fake = fakePi();
    const renamed: string[] = [];
    await createThreadTitleRuntimeExtension(async (_ctx, title) => {
      renamed.push(title);
      return title;
    })(fake.pi as never);
    const result = (await fake
      .tool()
      .execute(
        "call",
        { title: "  Sidebar   CSS review " },
        undefined,
        undefined,
        ctxFor([user(), assistant("toolUse")]),
      )) as { details: { title: string } };
    expect(renamed).toEqual(["Sidebar CSS review"]);
    expect(result.details.title).toBe("Sidebar CSS review");
  });

  test("refuses after the first exchange without renaming", async () => {
    const fake = fakePi();
    const renamed: string[] = [];
    await createThreadTitleRuntimeExtension(async (_ctx, title) => {
      renamed.push(title);
      return title;
    })(fake.pi as never);
    await expect(
      fake
        .tool()
        .execute(
          "call",
          { title: "Later title" },
          undefined,
          undefined,
          ctxFor([user(), assistant("stop"), user()]),
        ),
    ).rejects.toThrow(FIRST_EXCHANGE_ONLY_MESSAGE);
    await expect(
      fake.tool().execute("call", { title: "x" }, undefined, undefined, ctxFor([user()])),
    ).rejects.toThrow(/3-80 characters/);
    expect(renamed).toEqual([]);
  });

  test("shows as a compact transcript row", () => {
    const [row] = timelineFromDriverTranscript(
      [
        {
          kind: "tool",
          callId: "c1",
          toolName: renameThreadToolName,
          status: "success",
          input: { title: "Sidebar CSS review" },
          createdAt: "2026-11-05T00:00:00.000Z",
        },
      ] as never,
      new Map(),
    );
    expect(row).toMatchObject({ kind: "tool", label: 'Renamed chat to "Sidebar CSS review"' });
  });
});

/** The auto-title's late result is applied or dropped within microtasks of resolving. */
function afterPendingWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A workspace owner over one thread, with the auto-title result held until the test resolves it. */
function titleFixture() {
  const ref: SessionRef = { workspaceId: "ws", sessionId: "s1" };
  let title = NEW_THREAD_PLACEHOLDER_TITLE;
  const renames: string[] = [];
  const pending = new Map<string, PendingAutoTitle>();
  const userTitled = new Set<string>();
  let resolveAutoTitle!: (title: string) => void;
  const autoTitle = new Promise<string>((resolve) => {
    resolveAutoTitle = resolve;
  });
  let autoTitleRequested!: () => void;
  const autoTitleStarted = new Promise<void>((resolve) => {
    autoTitleRequested = resolve;
  });
  const workspace = { workspaceId: "ws", path: "/tmp/ws", displayName: "ws" };
  const host = {
    driver: {
      createSession: async () => ({ ref, title, status: "idle" }),
      generateThreadTitle: async () => {
        autoTitleRequested();
        return autoTitle;
      },
      renameSession: async (_ref: SessionRef, next: string) => {
        title = next;
        renames.push(next);
      },
    },
    initialize: async () => undefined,
    workspaceRefFromState: () => workspace,
    withErrorHandling: (fn: () => Promise<unknown>) => fn(),
    resolveExtensionFlags: async () => ({ applied: {}, chosen: {} }),
    buildCreateSessionOptions: async () => ({}),
    seedSession: () => undefined,
    recordExtensionFlags: () => undefined,
    setActiveSession: () => undefined,
    refreshState: async () => ({}),
    workspaceState: () => ({ workspaces: [] }),
    sendMessageToSession: async () => undefined,
    sessionFromState: () => ({ title, status: "running", updatedAt: "" }),
    setPendingAutoTitle: (sessionRef: SessionRef, next: PendingAutoTitle) =>
      pending.set(sessionKey(sessionRef), next),
    getPendingAutoTitle: (sessionRef: SessionRef) => pending.get(sessionKey(sessionRef)),
    clearPendingAutoTitle: (sessionRef: SessionRef) => {
      pending.get(sessionKey(sessionRef))?.cancel();
      pending.delete(sessionKey(sessionRef));
    },
    markSessionTitledByUser: (sessionRef: SessionRef) => userTitled.add(sessionKey(sessionRef)),
    isSessionTitledByUser: (sessionRef: SessionRef) => userTitled.has(sessionKey(sessionRef)),
  };
  const owner = createWorkspaceOwner(host as unknown as Parameters<typeof createWorkspaceOwner>[0]);
  return {
    ref,
    owner,
    title: () => title,
    renames,
    resolveAutoTitle,
    autoTitleStarted,
    startThread: () =>
      owner.startThread({
        rootWorkspaceId: "ws",
        environment: "local",
        prompt: "hey look at this",
      }),
  };
}

test.describe("agent rename vs other titles", () => {
  test("wins over a pending auto-title that resolves later", async () => {
    const f = titleFixture();
    await f.startThread();
    await f.autoTitleStarted;

    await expect(f.owner.renameSessionFromAgent(f.ref, "Sidebar CSS review")).resolves.toBe(
      "Sidebar CSS review",
    );
    f.resolveAutoTitle("Vague look request");
    await afterPendingWork();

    expect(f.title()).toBe("Sidebar CSS review");
    expect(f.renames).toEqual(["Sidebar CSS review"]);
  });

  test("replaces a completed auto-title", async () => {
    const f = titleFixture();
    await f.startThread();
    f.resolveAutoTitle("Vague look request");
    await expect.poll(() => f.title()).toBe("Vague look request");

    await f.owner.renameSessionFromAgent(f.ref, "Sidebar CSS review");
    expect(f.title()).toBe("Sidebar CSS review");
  });

  test("never replaces a title the user set", async () => {
    const f = titleFixture();
    await f.startThread();
    await f.owner.renameSession(f.ref, "My own name");

    await expect(f.owner.renameSessionFromAgent(f.ref, "Sidebar CSS review")).rejects.toThrow(
      /user named this chat/,
    );
    f.resolveAutoTitle("Vague look request");
    await afterPendingWork();
    expect(f.title()).toBe("My own name");
    expect(f.renames).toEqual(["My own name"]);
  });
});
