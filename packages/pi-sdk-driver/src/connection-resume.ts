import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Resuming a run that lost its provider connection.
 *
 * Pi retries a failed provider request a few times (2s, 4s, 8s by default) and then settles
 * the run as failed. A connect timeout or reset outlasts that easily, so the person comes back
 * to a failed thread and types "continue". This keeps such a run open a few minutes longer:
 * when Pi is about to settle after a connection-level failure, the hidden extension below
 * waits with backoff and then asks Pi to continue the same run from `agent_before_settle`.
 *
 * The continuation is Pi's own: the failed attempt is left out of the model's context with a
 * `context_edit`, the same entry Pi writes for each of its own retries, and the boundary
 * requests one more provider request. No message is added to the conversation.
 */

/** How long to wait before each resume, and for how long in total. */
export interface ConnectionResumePolicy {
  /** Wait before resume N (0-based). The last value repeats. */
  readonly delaysMs: readonly number[];
  /** No resume starts later than this after the first failure Pi gave up on. */
  readonly budgetMs: number;
  /** How often the network signal is read while waiting. */
  readonly onlinePollMs: number;
}

export const DEFAULT_CONNECTION_RESUME_POLICY: ConnectionResumePolicy = {
  delaysMs: [5_000, 10_000, 20_000, 40_000, 60_000],
  budgetMs: 5 * 60_000,
  onlinePollMs: 1_000,
};

// HTTP statuses, credentials, request shape, quotas, provider load, context size and
// cancellation. A message naming any of these came from the provider or the person, not
// from the transport, and resuming would repeat it or override a Stop.
const NOT_A_CONNECTION_FAILURE = new RegExp(
  [
    // A port (":443") or a decimal is not a status.
    "(?<![a-z0-9.:])[45]\\d\\d(?![a-z0-9])",
    "auth",
    "unauthori[sz]ed",
    "forbidden",
    "permission",
    "api.?key",
    "credential",
    "invalid",
    "bad request",
    "not found",
    "quota",
    "billing",
    "usage limit",
    "rate.?limit",
    "too many requests",
    "overloaded",
    "capacity",
    "context",
    "too long",
    "too large",
    "abort",
    "cancel",
  ].join("|"),
  "i",
);

// Failures to reach the provider or keep the response stream open. "Request timed out." and
// "Connection error." are the Anthropic and OpenAI SDK wrappers around undici's
// ConnectTimeoutError and other fetch failures.
const CONNECTION_FAILURE = new RegExp(
  [
    "timed? ?out",
    "timeout",
    "connection.?(?:error|reset|refused|closed|lost|terminated)",
    "connect(?:ion)? ?timeout",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ENETUNREACH",
    "ENETDOWN",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "getaddrinfo",
    "UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|CLOSED)",
    "socket hang up",
    "other side closed",
    "fetch failed",
    "network.?error",
    "network is (?:down|unreachable)",
    "terminated",
  ].join("|"),
  "i",
);

/** The generic text a run gets when the error carried no message. */
const GENERIC_ERROR = /^\s*(?:unknown error|run failed)?\s*$/i;

/**
 * Whether a failed assistant message is a provider connection or transport failure that is
 * worth resuming. Anything Pi reports as aborted, any HTTP status, and any provider-reported
 * reason (auth, invalid request, rate limit, overload, context size) is not.
 *
 * An error with no description that produced nothing at all (no content, no tokens) counts
 * too: that is what a request that never reached the provider looks like.
 */
export function isResumableConnectionFailure(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") {
    return false;
  }
  const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (GENERIC_ERROR.test(error)) return producedNothing(message);
  if (NOT_A_CONNECTION_FAILURE.test(error)) return false;
  return CONNECTION_FAILURE.test(error);
}

function producedNothing(message: Record<string, unknown>): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  const usage = isRecord(message.usage) ? message.usage : {};
  const tokens = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].reduce(
    (sum, key) => sum + (typeof usage[key] === "number" ? usage[key] : 0),
    0,
  );
  return content.length === 0 && tokens === 0;
}

/**
 * The wait before resume `attempt` (0-based), or undefined once that resume would start past
 * the budget. `elapsedMs` counts from the first failure Pi gave up on.
 */
export function connectionResumeDelayMs(
  policy: ConnectionResumePolicy,
  attempt: number,
  elapsedMs: number,
): number | undefined {
  const delays = policy.delaysMs;
  if (delays.length === 0) return undefined;
  const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
  return elapsedMs + delay > policy.budgetMs ? undefined : delay;
}

export type ConnectionWaitOutcome = "resume" | "expired" | "cancelled";

/**
 * Wait `delayMs`, then resume. While the network reads offline, an attempt would only fail
 * again, so the wait goes on until it is back or the deadline passes; a return to online
 * after being offline resumes at once instead of finishing the delay.
 */
export function waitForConnectionResume(options: {
  readonly delayMs: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly pollMs: number;
  readonly isOnline?: (() => boolean) | undefined;
  readonly now?: () => number;
}): Promise<ConnectionWaitOutcome> {
  const now = options.now ?? Date.now;
  const resumeAt = now() + options.delayMs;
  const online = () => options.isOnline?.() ?? true;
  return new Promise((resolve) => {
    if (options.signal.aborted) {
      resolve("cancelled");
      return;
    }
    let wasOffline = !online();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ConnectionWaitOutcome) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("cancelled");
    const check = () => {
      const isOnline = online();
      const current = now();
      if (isOnline && (wasOffline || current >= resumeAt)) {
        finish("resume");
        return;
      }
      if (!isOnline && current >= options.deadlineAt) {
        finish("expired");
        return;
      }
      wasOffline ||= !isOnline;
      const untilResume = isOnline ? resumeAt - current : options.deadlineAt - current;
      const step = options.isOnline ? Math.min(options.pollMs, untilResume) : untilResume;
      timer = setTimeout(check, Math.max(0, step));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

export interface ConnectionResumeExtensionOptions {
  /**
   * Called when Pi is about to settle a run after a resumable failure. Resolve true to resume
   * the run, false to let it settle as failed (budget spent, stopped or closed).
   */
  readonly waitToResume: (sessionId: string, errorMessage: string) => Promise<boolean>;
}

/** The hidden extension that turns a resumable failure into Pi's own continuation. */
export function createConnectionResumeExtension(
  options: ConnectionResumeExtensionOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on("agent_before_settle", async (event, ctx) => {
      // Pi continues on its own for queued messages; another handler may already continue.
      if (event.outcome !== "error" || event.continue || event.context.pendingMessages.length > 0) {
        return undefined;
      }
      const failed = lastAssistantEntry(ctx.sessionManager.getBranch());
      if (!failed || !isResumableConnectionFailure(failed.message)) return undefined;
      const errorMessage = (failed.message as { errorMessage?: string }).errorMessage ?? "";
      const resume = await options.waitToResume(ctx.sessionManager.getSessionId(), errorMessage);
      if (!resume) return undefined;
      return {
        entries: [
          ...event.entries,
          { type: "context_edit" as const, targetId: failed.id, replacement: null },
        ],
        continue: true,
      };
    });
  };
}

function lastAssistantEntry(
  branch: readonly unknown[],
): { readonly id: string; readonly message: unknown } | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string") continue;
    if (isRecord(entry.message) && entry.message.role === "assistant") {
      return { id: entry.id, message: entry.message };
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
