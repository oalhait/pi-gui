import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RunsLog } from "../../electron/platform/runs-log";
import {
  DEFAULT_RUN_SETTINGS,
  readRunSettings,
  RUN_SETTINGS_FILE,
  writeRunSettings,
} from "../../electron/persistence/run-settings-store";

const at = new Date("2026-11-06T20:29:53.000Z");
const ids = { sessionId: "s1", workspaceId: "w1", runId: "r1" };

test("the runs log writes one JSON line per entry, metadata only", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "runs-log-")), "nested");
  const log = new RunsLog({ directory, now: () => at });
  log.record({
    ...ids,
    kind: "request_start",
    attempt: 1,
    provider: "anthropic",
    model: "claude-opus-5-5",
    api: "anthropic-messages",
    cacheWarm: false,
    bodyBytes: 1_030_685,
    contextTokensEstimate: 257_671,
    stallTimeoutMs: 120_000,
  });
  log.record({
    ...ids,
    kind: "stall",
    attempt: 1,
    afterMs: 120_004,
    phase: "accepted",
    pings: 9,
    timeoutMs: 120_000,
    action: "retry",
  });
  await log.flush();
  const lines = (await readFile(log.path, "utf8")).trim().split("\n");
  expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    {
      time: at.toISOString(),
      ...ids,
      kind: "request_start",
      attempt: 1,
      provider: "anthropic",
      model: "claude-opus-5-5",
      api: "anthropic-messages",
      cacheWarm: false,
      bodyBytes: 1_030_685,
      contextTokensEstimate: 257_671,
      stallTimeoutMs: 120_000,
    },
    {
      time: at.toISOString(),
      ...ids,
      kind: "stall",
      attempt: 1,
      afterMs: 120_004,
      phase: "accepted",
      pings: 9,
      timeoutMs: 120_000,
      action: "retry",
    },
  ]);
});

test("the runs log rotates past its size limit and keeps a bounded number of files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runs-log-rotate-"));
  await writeFile(join(directory, "runs.log"), "x".repeat(150));
  const log = new RunsLog({ directory, maxBytes: 200, keep: 2, now: () => at });
  for (let index = 0; index < 12; index += 1) {
    log.record({ ...ids, kind: "turn_start" });
  }
  await log.flush();
  const files = (await readdir(directory)).sort();
  expect(files).toEqual(["runs.1.log", "runs.2.log", "runs.log"]);
  for (const file of files) {
    const size = (await readFile(join(directory, file))).byteLength;
    expect(size).toBeLessThanOrEqual(200);
  }
});

test("run settings default when missing and round-trip through their own file", async () => {
  const userData = await mkdtemp(join(tmpdir(), "run-settings-"));
  expect(await readRunSettings(userData)).toEqual(DEFAULT_RUN_SETTINGS);
  await writeRunSettings(userData, { modelStallTimeoutSeconds: 60 });
  expect(await readRunSettings(userData)).toEqual({ modelStallTimeoutSeconds: 60 });
  expect(JSON.parse(await readFile(join(userData, RUN_SETTINGS_FILE), "utf8"))).toEqual({
    version: 1,
    modelStallTimeoutSeconds: 60,
  });
});

test("an invalid run settings file falls back to defaults and is not overwritten", async () => {
  const userData = await mkdtemp(join(tmpdir(), "run-settings-bad-"));
  const file = join(userData, RUN_SETTINGS_FILE);
  await writeFile(file, '{"version":1,"modelStallTimeoutSeconds":"soon"}');
  expect(await readRunSettings(userData)).toEqual(DEFAULT_RUN_SETTINGS);
  await expect(writeRunSettings(userData, { modelStallTimeoutSeconds: 60 })).rejects.toThrow(
    /modelStallTimeoutSeconds/,
  );
  expect(await readFile(file, "utf8")).toBe('{"version":1,"modelStallTimeoutSeconds":"soon"}');
});
