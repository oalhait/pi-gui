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

/** Shape of Claude's usage response as of late 2026, with plan limits and usage credits. */
function claudeUsage(usedCredits = 55022) {
  return {
    five_hour: { utilization: 0, resets_at: null, limit_dollars: null },
    seven_day: { utilization: 0, resets_at: "2026-11-12T23:00:00.086695+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_oauth_apps: null,
    some_future_window: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 500000,
      used_credits: usedCredits,
      utilization: usedCredits / 5000,
      currency: "USD",
      decimal_places: 2,
      disabled_reason: null,
      spend_limit_reached: false,
      daily: null,
    },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 0,
        severity: "normal",
        resets_at: null,
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resets_at: "2026-11-12T23:00:00.086695+00:00",
        scope: null,
        is_active: false,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resets_at: "2026-11-12T23:00:00+00:00",
        scope: { model: { id: null, display_name: "Opus" }, surface: null },
        is_active: false,
      },
    ],
    spend: {
      used: { amount_minor: usedCredits, currency: "USD", exponent: 2 },
      limit: { amount_minor: 500000, currency: "USD", exponent: 2 },
      percent: Math.round(usedCredits / 5000),
      severity: "normal",
      enabled: true,
      disabled_reason: null,
      balance: null,
      disclaimer:
        "Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)",
    },
  };
}

await test("prefers Claude's limits array and reads usage credits from spend", () => {
  const usage = parseProviderUsage("anthropic", claudeUsage());
  assert.deepEqual(usage.windows, [
    { label: "Session", usedPercent: 0, severity: "normal", active: true },
    {
      label: "Weekly",
      usedPercent: 0,
      resetsAt: "2026-11-12T23:00:00.086Z",
      severity: "normal",
      active: false,
    },
    {
      label: "Weekly · Opus",
      usedPercent: 0,
      resetsAt: "2026-11-12T23:00:00.000Z",
      severity: "normal",
      active: false,
    },
  ]);
  assert.deepEqual(usage.credits, {
    used: 550.22,
    limit: 5000,
    currency: "USD",
    fractionDigits: 2,
    usedPercent: 11,
    severity: "normal",
    limitReached: false,
    disclaimer:
      "Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)",
  });
});

await test("falls back to extra_usage when spend is missing and flags a reached limit", () => {
  const { spend: _spend, ...body } = claudeUsage();
  const usage = parseProviderUsage("anthropic", {
    ...body,
    extra_usage: { ...body.extra_usage, spend_limit_reached: true },
  });
  assert.equal(usage.credits?.used, 550.22);
  assert.equal(usage.credits?.limit, 5000);
  assert.equal(usage.credits?.currency, "USD");
  assert.equal(usage.credits?.limitReached, true);
  assert.ok(Math.abs((usage.credits?.usedPercent ?? 0) - 11.0044) < 1e-9);
  assert.equal(usage.credits?.disclaimer, undefined);
});

await test("uses legacy Claude windows when limits are absent or unusable", () => {
  for (const limits of [undefined, null, [], [{ kind: "session", percent: null }], "x"]) {
    const usage = parseProviderUsage("anthropic", {
      limits,
      five_hour: { utilization: 3, resets_at: null },
      seven_day: null,
      seven_day_opus: { utilization: 9 },
    });
    assert.deepEqual(
      usage.windows.map((w) => [w.label, w.usedPercent]),
      [
        ["5-hour", 3],
        ["Opus · Weekly", 9],
      ],
    );
    assert.equal(usage.credits, undefined);
  }
});

await test("tolerates null, disabled and malformed credit fields", () => {
  const base = claudeUsage();
  assert.equal(
    parseProviderUsage("anthropic", { ...base, spend: null, extra_usage: null }).credits,
    undefined,
  );
  assert.equal(
    parseProviderUsage("anthropic", {
      ...base,
      spend: { ...base.spend, enabled: false },
    }).credits,
    undefined,
  );
  assert.equal(
    parseProviderUsage("anthropic", {
      ...base,
      spend: { used: { amount_minor: "1", currency: "usd", exponent: 2 } },
      extra_usage: { used_credits: 100, decimal_places: 2, currency: null },
    }).credits,
    undefined,
  );
  const unlimited = parseProviderUsage("anthropic", {
    spend: { used: { amount_minor: 1234, currency: "EUR", exponent: 2 }, limit: null },
  }).credits;
  assert.deepEqual(unlimited, {
    used: 12.34,
    currency: "EUR",
    fractionDigits: 2,
    limitReached: false,
  });
  const unscoped = parseProviderUsage("anthropic", {
    limits: [{ kind: "weekly_scoped", group: "weekly", percent: 5, scope: { model: null } }, null],
  });
  assert.deepEqual(unscoped.windows, [{ label: "Weekly", usedPercent: 5 }]);
});

await test("reports credits-only usage as available and detects credits billed while plans stay idle", async () => {
  let used = 55022;
  let now = 0;
  const reader = new ProviderUsageReader(
    async () => new Response(JSON.stringify(claudeUsage(used))),
    () => now,
  );
  const runtime = {
    isUsingOAuth: () => true,
    getRegisteredProviderConfig: () => undefined,
    getAuth: async () => ({ auth: { apiKey: "test-token" }, source: "oauth" }),
  };
  const first = await reader.read(runtime, "anthropic");
  assert.equal(first.status, "available");
  assert.equal(first.credits?.used, 550.22);
  assert.equal(first.billedToCredits, undefined);
  used = 55104;
  now += 60001;
  assert.equal((await reader.read(runtime, "anthropic")).billedToCredits, true);
  now += 60001;
  assert.equal((await reader.read(runtime, "anthropic")).billedToCredits, true, "stays set");

  const credited = parseProviderUsage("anthropic", { spend: claudeUsage().spend });
  assert.equal(credited.windows.length, 0);
  assert.equal(credited.credits?.used, 550.22);
});

await test("does not claim credit billing when plan usage is moving", async () => {
  let used = 100;
  let now = 0;
  let percent = 0;
  const reader = new ProviderUsageReader(
    async () => {
      const body = claudeUsage(used);
      body.limits[0] = { ...body.limits[0]!, percent };
      return new Response(JSON.stringify(body));
    },
    () => now,
  );
  const runtime = {
    isUsingOAuth: () => true,
    getRegisteredProviderConfig: () => undefined,
    getAuth: async () => ({ auth: { apiKey: "test-token" }, source: "oauth" }),
  };
  await reader.read(runtime, "anthropic");
  used = 200;
  percent = 4;
  now += 60001;
  const usage = await reader.read(runtime, "anthropic");
  assert.equal(usage.billedToCredits, undefined);
  assert.equal(usage.windows[0]?.usedPercent, 4);
});
