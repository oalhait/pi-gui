import assert from "node:assert/strict";
import test from "node:test";
import { runningWaits, scriptedModelDriver } from "./fixtures/scripted-model-driver.mts";

await test("Stop publishes idle only after the stopped run's message identities", async (t) => {
  const h = await scriptedModelDriver(t, [{ kind: "hang" }], { slowListenerMs: 40 });
  const sending = h.driver.sendUserMessage(h.ref, { text: "Never answered" });
  await h.waitFor(() => runningWaits(h.events).some((wait) => wait !== undefined));
  await h.driver.cancelCurrentRun(h.ref);
  await sending;
  const persisted = h.events.findIndex((event) => event.type === "userMessagePersisted");
  assert.ok(persisted >= 0, "the stopped question's entry ID is reported");
  const idleAfterStop = h.events.findIndex(
    (event, index) =>
      index >
        h.events.findIndex((e) => e.type === "sessionUpdated" && e.snapshot.status === "running") &&
      event.type === "sessionUpdated" &&
      event.snapshot.status === "idle",
  );
  assert.ok(idleAfterStop > persisted, "idle comes after the entry ID");
  const last = h.events.at(-1);
  assert.equal(last?.type === "sessionUpdated" && last.snapshot.status, "idle");
  assert.equal(last?.type === "sessionUpdated" && last.snapshot.modelWait, undefined);
});
