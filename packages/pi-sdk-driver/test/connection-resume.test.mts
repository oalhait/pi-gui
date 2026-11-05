import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionResumeDelayMs,
  DEFAULT_CONNECTION_RESUME_POLICY,
  isResumableConnectionFailure,
  waitForConnectionResume,
} from "../dist/connection-resume.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failed(errorMessage: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: ZERO_USAGE,
    stopReason: "error",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 1793826681193,
    ...extra,
  };
}

await test("the exact failures from the 2026-11-04 session file", () => {
  // Line 93 of 2026-11-04T21-06-33-596Z_01a1a862-….jsonl, verbatim apart from the id fields.
  const timedOut = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: ZERO_USAGE,
    stopReason: "error",
    timestamp: 1793826681193,
    providerThinkingLevel: "medium",
    errorMessage: "Request timed out.",
    durationMs: 10388,
    thinkingLevel: "medium",
  };
  assert.equal(isResumableConnectionFailure(timedOut), true);
  // Line 221 of the same file: the person stopped a run. Never resumed.
  const stopped = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: "This operation was aborted",
    timestamp: 1793839039557,
    durationMs: 0,
    thinkingLevel: "medium",
  };
  assert.equal(isResumableConnectionFailure(stopped), false);
});

await test("connection and transport failures are resumable", () => {
  for (const message of [
    "Request timed out.",
    "Connection error.",
    "fetch failed",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "connect ETIMEDOUT 160.79.104.10:443",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "socket hang up",
    "other side closed",
    "terminated",
    "Network error",
    "Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)",
    "TypeError: fetch failed (cause: UND_ERR_CONNECT_TIMEOUT)",
  ]) {
    assert.equal(isResumableConnectionFailure(failed(message)), true, message);
  }
});

await test("a connection failure after partial output still resumes", () => {
  const partial = failed("terminated", {
    content: [{ type: "text", text: "Half a reply" }],
    usage: { ...ZERO_USAGE, input: 1200, output: 40, totalTokens: 1240 },
  });
  assert.equal(isResumableConnectionFailure(partial), true);
});

await test("provider-reported, request, auth and stop errors are never resumed", () => {
  for (const message of [
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    '403 {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}',
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: field required"}}',
    '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}',
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "500 Internal server error",
    "408 Request Timeout",
    "504 Gateway Timeout",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "No API key found for anthropic",
    'Authentication failed for "anthropic". Credentials may have expired or network is unavailable.',
    "You exceeded your current quota, please check your plan and billing details. insufficient_quota",
    "Request was aborted.",
    "This operation was aborted",
    "Retry cancelled",
    "Something unexpected happened",
  ]) {
    assert.equal(isResumableConnectionFailure(failed(message)), false, message);
  }
});

await test("only error stops count, never aborts or successes", () => {
  assert.equal(
    isResumableConnectionFailure(failed("Request timed out.", { stopReason: "aborted" })),
    false,
  );
  assert.equal(
    isResumableConnectionFailure(failed("Request timed out.", { stopReason: "stop" })),
    false,
  );
  assert.equal(
    isResumableConnectionFailure({ ...failed("Request timed out."), role: "user" }),
    false,
  );
  assert.equal(isResumableConnectionFailure(undefined), false);
});

await test("an undescribed error counts only when the attempt produced nothing", () => {
  assert.equal(isResumableConnectionFailure(failed(undefined)), true);
  assert.equal(isResumableConnectionFailure(failed("")), true);
  assert.equal(isResumableConnectionFailure(failed("Unknown error")), true);
  assert.equal(
    isResumableConnectionFailure(
      failed(undefined, { content: [{ type: "text", text: "Some reply" }] }),
    ),
    false,
  );
  assert.equal(
    isResumableConnectionFailure(
      failed("Unknown error", { usage: { ...ZERO_USAGE, output: 3, totalTokens: 3 } }),
    ),
    false,
  );
});

await test("the default backoff grows and stops at the budget", () => {
  const policy = DEFAULT_CONNECTION_RESUME_POLICY;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => connectionResumeDelayMs(policy, attempt, 0)),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
  );
  // A resume that would start past five minutes from the first failure is not scheduled.
  assert.equal(connectionResumeDelayMs(policy, 4, 4 * 60_000), 60_000);
  assert.equal(connectionResumeDelayMs(policy, 4, 4 * 60_000 + 1), undefined);
  assert.equal(connectionResumeDelayMs({ ...policy, delaysMs: [] }, 0, 0), undefined);
  // Several minutes, not pi's 14 seconds of retry waits.
  assert.ok(policy.budgetMs >= 3 * 60_000);
});

await test("a wait resumes after its delay, or at once when the network returns", async () => {
  const controller = new AbortController();
  let started = Date.now();
  assert.equal(
    await waitForConnectionResume({
      delayMs: 30,
      deadlineAt: Date.now() + 10_000,
      signal: controller.signal,
      pollMs: 5,
    }),
    "resume",
  );
  assert.ok(Date.now() - started >= 25);

  let online = false;
  setTimeout(() => {
    online = true;
  }, 20);
  started = Date.now();
  assert.equal(
    await waitForConnectionResume({
      delayMs: 60_000,
      deadlineAt: Date.now() + 120_000,
      signal: controller.signal,
      pollMs: 5,
      isOnline: () => online,
    }),
    "resume",
  );
  assert.ok(Date.now() - started < 5_000, "the network's return cut the 60 s delay short");
});

await test("a wait stays put while offline and expires at the deadline", async () => {
  const outcome = await waitForConnectionResume({
    delayMs: 5,
    deadlineAt: Date.now() + 40,
    signal: new AbortController().signal,
    pollMs: 5,
    isOnline: () => false,
  });
  assert.equal(outcome, "expired");
});

await test("cancelling a wait ends it at once", async () => {
  const controller = new AbortController();
  const waiting = waitForConnectionResume({
    delayMs: 60_000,
    deadlineAt: Date.now() + 120_000,
    signal: controller.signal,
    pollMs: 1_000,
  });
  controller.abort();
  assert.equal(await waiting, "cancelled");
  const already = new AbortController();
  already.abort();
  assert.equal(
    await waitForConnectionResume({
      delayMs: 10,
      deadlineAt: Date.now() + 100,
      signal: already.signal,
      pollMs: 5,
    }),
    "cancelled",
  );
});
