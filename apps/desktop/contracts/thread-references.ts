import type {
  ChildThreadLink,
  OrchestrationChildThreadStatus,
  SessionStatus,
  WorkspaceRecord,
} from "./desktop-state";

/**
 * How a mentioned thread relates to the sender, in list_threads' words plus `parent`:
 * a thread the sender started, the one that started it, its own workspace, or elsewhere.
 */
export type ThreadMentionRelationship = "child" | "parent" | "workspace" | "other_project";

/** A thread the composer can @-mention: one the sending thread's tools can resolve. */
export interface ThreadMentionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  /** Display name of the thread's project. */
  readonly project: string;
  /** True when the thread is in another project than the sender. */
  readonly otherProject: boolean;
  readonly relationship: ThreadMentionRelationship;
  /** A child's orchestration status, else the session's. */
  readonly status: SessionStatus | OrchestrationChildThreadStatus;
  readonly updatedAt: string;
  /** The text after `@` in the composer. */
  readonly mention: string;
}

/** The thread a composer sends from; a new thread has no session yet. */
export interface ThreadMentionOrigin {
  readonly workspaceId: string;
  readonly sessionId?: string;
}

/** Title as a single `@` token: the composer's mention trigger stops at whitespace. */
export function threadMentionText(title: string): string {
  return title.trim().replace(/^@+/, "").replace(/\s+/g, "-");
}

/**
 * Threads the sender's read_thread and send_message_to_thread can reach by
 * `workspaceId:sessionId`: its own workspace, its child threads, and other projects.
 * Sibling worktrees of the same project resolve only as children, so the others are left out.
 */
export function threadMentionTargets(
  workspaces: readonly WorkspaceRecord[],
  childThreadLinks: readonly ChildThreadLink[],
  origin: ThreadMentionOrigin,
): ThreadMentionTarget[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const projectOf = (workspaceId: string) => {
    const workspace = byId.get(workspaceId);
    return byId.get(workspace?.rootWorkspaceId ?? workspaceId) ?? workspace;
  };
  const originProjectId = projectOf(origin.workspaceId)?.id;
  const linkKey = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;
  const children = new Map(
    origin.sessionId
      ? childThreadLinks
          .filter(
            (link) =>
              link.parentWorkspaceId === origin.workspaceId &&
              link.parentSessionId === origin.sessionId,
          )
          .map((link) => [linkKey(link.childWorkspaceId, link.childSessionId), link] as const)
      : [],
  );
  const parentLink = origin.sessionId
    ? childThreadLinks.find(
        (link) =>
          link.childWorkspaceId === origin.workspaceId && link.childSessionId === origin.sessionId,
      )
    : undefined;
  const parentKey = parentLink
    ? linkKey(parentLink.parentWorkspaceId, parentLink.parentSessionId)
    : undefined;

  const targets: ThreadMentionTarget[] = [];
  for (const workspace of workspaces) {
    const project = projectOf(workspace.id);
    const reachableWorkspace =
      workspace.id === origin.workspaceId || project?.id !== originProjectId;
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      if (workspace.id === origin.workspaceId && session.id === origin.sessionId) continue;
      const key = linkKey(workspace.id, session.id);
      const child = children.get(key);
      if (!reachableWorkspace && !child) continue;
      const mention = threadMentionText(session.title);
      if (!mention) continue;
      const otherProject = project?.id !== originProjectId;
      targets.push({
        workspaceId: workspace.id,
        sessionId: session.id,
        title: session.title,
        project: project?.name ?? workspace.name,
        otherProject,
        relationship: child
          ? "child"
          : key === parentKey
            ? "parent"
            : otherProject
              ? "other_project"
              : "workspace",
        status: child?.status ?? session.status,
        updatedAt: session.updatedAt,
        mention,
      });
    }
  }
  return targets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const REFERENCES_BLOCK = /\n*<thread-references>\n[\s\S]*?\n<\/thread-references>\s*$/;

/** The message without the trailing block {@link withThreadReferences} adds. */
export function stripThreadReferences(text: string): string {
  return text.replace(REFERENCES_BLOCK, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "just now", "5m ago", "3h ago" or "2d ago": enough for the model to judge staleness. */
export function relativeAge(updatedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(updatedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Appends what the model needs to act on each thread `text` @-mentions: the id for
 * read_thread or send_message_to_thread, how the thread relates to this one, whether it is
 * busy and how fresh it is. Transcripts stay out; read_thread fetches them when needed.
 * The composer shows only the readable `@title`; the timeline drops the block again with
 * {@link stripThreadReferences}.
 */
export function withThreadReferences(
  text: string,
  targets: readonly ThreadMentionTarget[],
  now: number = Date.now(),
): string {
  const body = stripThreadReferences(text);
  // Longest first, so `@fix-login-flow` is not also read as a mention of `@fix-login`; among
  // equal titles the stable sort keeps the most recent thread first. A matched mention is
  // removed from `remaining`, so each one resolves to a single thread.
  const ordered = [...targets].sort((left, right) => right.mention.length - left.mention.length);
  let remaining = body;
  const lines: string[] = [];
  for (const target of ordered) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(target.mention)}(?=$|[\\s.,;:!?)\\]])`,
      "gi",
    );
    if (!pattern.test(remaining)) continue;
    remaining = remaining.replace(pattern, "$1");
    const fields = [
      `thread_id ${JSON.stringify(`${target.workspaceId}:${target.sessionId}`)}`,
      target.relationship,
      target.status,
      `updated ${relativeAge(target.updatedAt, now)}`,
      `title ${JSON.stringify(target.title)}`,
      `project ${JSON.stringify(target.project)}`,
    ];
    lines.push(`- @${target.mention}: ${fields.join(", ")}`);
  }
  if (lines.length === 0) return body;
  return [
    body.trimEnd(),
    "",
    "<thread-references>",
    "Threads mentioned above. Relationship to this thread: child (this thread started it), parent (it started this thread), workspace (same folder) or other_project. Pass a thread_id to read_thread for its transcript and goal, or to send_message_to_thread.",
    ...lines,
    "</thread-references>",
  ].join("\n");
}
