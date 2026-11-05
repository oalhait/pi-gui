import { expect, test } from "@playwright/test";
import {
  modelWaitText,
  retryReason,
  SLOW_FIRST_OUTPUT_MS,
} from "../../src/features/conversation/model-wait-label";

const since = "2026-11-05T23:00:56.000Z";
const after = (ms: number) => Date.parse(since) + ms;

test("the wait counts up and says when the provider may be stuck", () => {
  expect(modelWaitText({ since }, undefined, after(12_000))).toEqual({
    label: "Waiting for the model · 12s",
    notes: [],
  });
  expect(modelWaitText({ since }, undefined, after(SLOW_FIRST_OUTPUT_MS + 164_000))).toEqual({
    label: "Waiting for the model · 3m 44s",
    notes: [
      "No response yet. The provider may be slow or overloaded; you can stop and send again.",
    ],
  });
});

test("a large context explains a slow first response", () => {
  expect(
    modelWaitText({ since }, { tokens: 407_510, cacheExpired: true }, after(3_000)).notes,
  ).toEqual([
    "Large context (408k tokens) and its prompt cache has expired, so the first response may take a while.",
  ]);
  expect(
    modelWaitText({ since }, { tokens: 200_000, cacheExpired: false }, after(3_000)).notes,
  ).toEqual(["Large context (200k tokens), so the first response may take a while."]);
});

test("a retry shows its reason and countdown, then its attempt once sent", () => {
  const retry = {
    attempt: 2,
    maxAttempts: 3,
    retryAt: new Date(after(4_000)).toISOString(),
    error: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  };
  expect(modelWaitText({ since, retry }, undefined, after(0))).toEqual({
    label: "Model request failed (provider overloaded). Retrying in 4s, attempt 2 of 3",
    notes: [],
  });
  const { retryAt: _sent, ...sent } = retry;
  expect(modelWaitText({ since, retry: sent }, undefined, after(9_000)).label).toBe(
    "Retrying the model request, attempt 2 of 3 · 9s",
  );
});

test("provider errors shorten to a reason", () => {
  expect(retryReason("429 Too Many Requests")).toBe("rate limited");
  expect(retryReason("rate_limit_error: slow down")).toBe("rate limited");
  expect(retryReason("503 Service Unavailable")).toBe("server error");
  expect(retryReason("Request timed out.")).toBe("timed out");
  expect(retryReason("fetch failed")).toBe("connection error");
  expect(retryReason("Something odd")).toBe("Something odd");
  expect(retryReason("x".repeat(100))).toHaveLength(60);
});
