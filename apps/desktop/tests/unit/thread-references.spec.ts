import { expect, test } from "@playwright/test";
import type { SessionRecord, WorkspaceRecord } from "../../contracts/desktop-state";
import {
  relativeAge,
  stripThreadReferences,
  threadMentionTargets,
  withThreadReferences,
} from "../../contracts/thread-references";

function session(id: string, title: string, updatedAt: string, archived = false): SessionRecord {
  return {
    id,
    title,
    updatedAt,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...(archived ? { archivedAt: updatedAt } : {}),
  };
}

function workspace(
  id: string,
  name: string,
  sessions: SessionRecord[],
  rootWorkspaceId?: string,
): WorkspaceRecord {
  return {
    id,
    name,
    path: `/code/${id}`,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    kind: rootWorkspaceId ? "worktree" : "primary",
    ...(rootWorkspaceId ? { rootWorkspaceId } : {}),
    sessions,
  };
}

const workspaces = [
  workspace("app", "pi-gui", [
    session("current", "Current work", "2026-01-05T00:00:00.000Z"),
    session("gb", "Using GitButler for commits", "2026-01-04T00:00:00.000Z"),
    session("old", "Archived idea", "2026-01-03T00:00:00.000Z", true),
  ]),
  workspace(
    "app-wt",
    "pi-gui-wt",
    [
      session("child", "Child worker", "2026-01-02T00:00:00.000Z"),
      session("sibling", "Sibling worktree", "2026-01-06T00:00:00.000Z"),
    ],
    "app",
  ),
  workspace("site", "website", [session("docs", "Docs refresh", "2026-01-01T00:00:00.000Z")]),
];

const childLinks = [
  {
    id: "child-thread",
    parentWorkspaceId: "app",
    parentSessionId: "current",
    childWorkspaceId: "app-wt",
    childSessionId: "child",
    title: "Child worker",
    status: "running" as const,
  },
];

test("offers the threads the sender's tools can resolve, newest first", () => {
  const targets = threadMentionTargets(workspaces, childLinks, {
    workspaceId: "app",
    sessionId: "current",
  });
  expect(
    targets.map((target) => [target.sessionId, target.mention, target.relationship, target.status]),
  ).toEqual([
    ["gb", "Using-GitButler-for-commits", "workspace", "idle"],
    // A child reports its orchestration status, not its session's.
    ["child", "Child-worker", "child", "running"],
    ["docs", "Docs-refresh", "other_project", "idle"],
  ]);
});

test("a child thread sees the thread that started it as its parent", () => {
  const targets = threadMentionTargets(
    [
      workspace("app", "pi-gui", [
        session("lead", "Lead", "2026-01-02T00:00:00.000Z"),
        session("worker", "Worker", "2026-01-01T00:00:00.000Z"),
      ]),
    ],
    [
      {
        ...childLinks[0]!,
        childWorkspaceId: "app",
        childSessionId: "worker",
        parentSessionId: "lead",
      },
    ],
    { workspaceId: "app", sessionId: "worker" },
  );
  expect(targets.map((target) => [target.sessionId, target.relationship])).toEqual([
    ["lead", "parent"],
  ]);
});

test("ages read in the coarsest useful unit", () => {
  const now = Date.parse("2026-01-10T12:00:00.000Z");
  expect(relativeAge("2026-01-10T11:59:40.000Z", now)).toBe("just now");
  expect(relativeAge("2026-01-10T11:55:00.000Z", now)).toBe("5m ago");
  expect(relativeAge("2026-01-09T12:00:00.000Z", now)).toBe("24h ago");
  expect(relativeAge("2026-01-07T12:00:00.000Z", now)).toBe("3d ago");
  expect(relativeAge("not a date", now)).toBe("unknown");
});

test("appends the ids of mentioned threads and strips them for display", () => {
  const targets = threadMentionTargets(workspaces, childLinks, {
    workspaceId: "app",
    sessionId: "current",
  });
  const draft = "Ask @using-gitbutler-for-commits, then check @Docs-refresh and @Child-worker.";
  const now = Date.parse("2026-01-06T00:00:00.000Z");
  const text = withThreadReferences(draft, targets, now);

  expect(text).toContain(
    '- @Using-GitButler-for-commits: thread_id "app:gb", workspace, idle, updated 2d ago, title "Using GitButler for commits", project "pi-gui"',
  );
  expect(text).toContain('- @Child-worker: thread_id "app-wt:child", child, running,');
  expect(text).toContain(
    '- @Docs-refresh: thread_id "site:docs", other_project, idle, updated 5d ago,',
  );
  expect(stripThreadReferences(text)).toBe(draft);
  // Re-sending an edited message does not stack a second block.
  expect(withThreadReferences(text, targets, now)).toBe(text);
});

test("leaves messages without thread mentions unchanged", () => {
  const targets = threadMentionTargets(workspaces, childLinks, { workspaceId: "app" });
  for (const draft of ["no mentions", "email me@Docs-refresh", "@Docs-refreshed is not it"]) {
    expect(withThreadReferences(draft, targets)).toBe(draft);
  }
});

test("prefers the longest matching title", () => {
  const targets = threadMentionTargets(
    [
      workspace("w", "w", [
        session("a", "Fix login", "2026-01-01T00:00:00.000Z"),
        session("b", "Fix login flow", "2026-01-01T00:00:00.000Z"),
      ]),
    ],
    [],
    { workspaceId: "w" },
  );
  const text = withThreadReferences("see @Fix-login-flow", targets);
  expect(text).toContain('"w:b"');
  expect(text).not.toContain('"w:a"');
});
