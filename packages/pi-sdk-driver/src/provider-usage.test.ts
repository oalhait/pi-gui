import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderUsage, ProviderUsageReader } from "./provider-usage.js";

await test("reads Codex window durations without assuming primary means five hours", () => {
  const usage = parseProviderUsage("openai-codex", {
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 76, limit_window_seconds: 604800, reset_at: 1793941718 },
      secondary_window: null,
    },
    code_review_rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } },
  });
  assert.equal(usage.plan, "pro");
  assert.deepEqual(
    usage.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["Weekly", 76],
      ["Code review · Weekly", 10],
    ],
  );
  assert.equal(usage.windows[0]?.resetsAt, new Date(1793941718 * 1000).toISOString());
});

await test("reads Claude percentages as percentages and preserves zero without a reset", () => {
  const usage = parseProviderUsage("anthropic", {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 42, resets_at: "2026-11-05T23:00:00+00:00" },
    seven_day_sonnet: { utilization: 8, resets_at: null },
  });
  assert.deepEqual(
    usage.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["5-hour", 0],
      ["Weekly", 42],
      ["Sonnet · Weekly", 8],
    ],
  );
  assert.equal(usage.windows[0]?.resetsAt, undefined);
});

await test("rejects absent and invalid usage instead of presenting it as zero", () => {
  assert.equal(
    parseProviderUsage("anthropic", { five_hour: { utilization: null } }).windows.length,
    0,
  );
  assert.equal(
    parseProviderUsage("openai-codex", {
      rate_limit: { primary_window: { used_percent: "76", limit_window_seconds: 604800 } },
    }).windows.length,
    0,
  );
});

await test("deduplicates concurrent reads and caches quota requests for a minute", async () => {
  let calls = 0;
  let now = 1000;
  const reader = new ProviderUsageReader(
    async () => {
      calls++;
      return new Response(JSON.stringify({ five_hour: { utilization: 5 } }));
    },
    () => now,
  );
  const runtime = {
    isUsingOAuth: () => true,
    getRegisteredProviderConfig: () => undefined,
    getAuth: async () => ({ auth: { apiKey: "test-token" }, source: "oauth" }),
  };
  await Promise.all([reader.read(runtime, "anthropic"), reader.read(runtime, "anthropic")]);
  assert.equal(calls, 1);
  await reader.read(runtime, "anthropic");
  assert.equal(calls, 1);
  now += 60001;
  await reader.read(runtime, "anthropic");
  assert.equal(calls, 2);
});

await test("never fetches unsupported connections or sends credentials after a redirect", async () => {
  let calls = 0;
  const reader = new ProviderUsageReader(async (_url, options) => {
    calls++;
    assert.equal(options?.redirect, "error");
    return new Response("", { status: 403 });
  });
  const runtime = {
    isUsingOAuth: () => false,
    getRegisteredProviderConfig: () => undefined,
    getAuth: async () => {
      throw new Error("must not resolve auth");
    },
  };
  assert.equal((await reader.read(runtime, "openai")).status, "unavailable");
  assert.equal(calls, 0);
  const connected = {
    ...runtime,
    isUsingOAuth: () => true,
    getAuth: async () => ({ auth: { apiKey: "test-token" }, source: "oauth" }),
  };
  const usage = await reader.read(connected, "anthropic");
  assert.equal(usage.status, "error");
  assert.ok(!usage.message?.includes("test-token"));
  assert.equal(calls, 1);
});

await test("invalidates cached limits when the account credential changes", async () => {
  let token = "first";
  let calls = 0;
  const reader = new ProviderUsageReader(async () => {
    calls++;
    return new Response(JSON.stringify({ five_hour: { utilization: 5 } }));
  });
  const runtime = {
    isUsingOAuth: () => true,
    getRegisteredProviderConfig: () => undefined,
    getAuth: async () => ({ auth: { apiKey: token }, source: "oauth" }),
  };
  await reader.read(runtime, "anthropic");
  token = "second";
  await reader.read(runtime, "anthropic");
  assert.equal(calls, 2);
});

await test("does not send extension-provided credentials to built-in usage endpoints", async () => {
  const reader = new ProviderUsageReader(async () => {
    throw new Error("must not fetch");
  });
  const runtime = {
    isUsingOAuth: () => true,
    getRegisteredProviderConfig: () => ({ baseUrl: "https://example.invalid" }),
    getAuth: async () => {
      throw new Error("must not resolve credentials");
    },
  };
  assert.equal((await reader.read(runtime, "anthropic")).status, "unavailable");
  assert.equal(
    (
      await reader.read(
        {
          ...runtime,
          getRegisteredProviderConfig: () => undefined,
          getRegisteredNativeProvider: () => ({}),
        },
        "anthropic",
      )
    ).status,
    "unavailable",
  );
});
