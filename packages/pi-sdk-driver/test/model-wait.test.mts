import assert from "node:assert/strict";
import test from "node:test";
import { runningWaits, scriptedModelDriver } from "./fixtures/scripted-model-driver.mts";

await test("a turn waits for the model until its first output arrives", async (t) => {
  const h = await scriptedModelDriver(t, [{ kind: "text", text: "Hello", afterMs: 100 }], {});
  await h.driver.sendUserMessage(h.ref, { text: "Hi" });
  await h.waitFor(() => h.events.some((event) => event.type === "runCompleted"));
  const seen = runningWaits(h.events);
  const first = seen.findIndex((wait) => wait !== undefined);
  assert.ok(first >= 0, "the snapshot reports the wait");
  assert.equal(seen[first]?.retry, undefined);
  assert.ok(
    seen.slice(first).some((wait) => wait === undefined),
    "output ends the wait",
  );
  const completed = h.events.find((event) => event.type === "runCompleted");
  assert.equal(completed?.type === "runCompleted" && completed.snapshot.modelWait, undefined);
});

await test("Pi's retry of an overloaded request shows its attempt, reason and backoff", async (t) => {
  const h = await scriptedModelDriver(
    t,
    [
      { kind: "error", message: '529 {"type":"error","error":{"type":"overloaded_error"}}' },
      { kind: "text", text: "Recovered" },
    ],
    {},
  );
  const sentAt = Date.now();
  await h.driver.sendUserMessage(h.ref, { text: "Hi" });
  await h.waitFor(() => h.events.some((event) => event.type === "runCompleted"));
  const retries = runningWaits(h.events).flatMap((wait) => (wait?.retry ? [wait.retry] : []));
  const backoff = retries.find((retry) => retry.retryAt !== undefined);
  assert.ok(backoff, "the backoff is reported");
  assert.equal(backoff.attempt, 1);
  assert.equal(backoff.maxAttempts, 3);
  assert.match(backoff.error, /overloaded_error/);
  assert.ok(Date.parse(backoff.retryAt!) > sentAt);
  assert.ok(
    retries.some((retry) => retry.attempt === 1 && retry.retryAt === undefined),
    "the sent retry has no backoff left",
  );
  const last = runningWaits(h.events).at(-1);
  assert.equal(last, undefined, "the successful retry clears the wait");
});
