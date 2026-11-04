import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  RESTART_REQUEST_FILE,
  RESUME_AFTER_RESTART_FILE,
  recordInterruptedSessions,
  takeInterruptedSessions,
  takeRestartRequest,
} from "../../electron/persistence/restart-resume-store";

const now = new Date("2026-11-04T18:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const dir = () => mkdtemp(join(tmpdir(), "pi-gui-restart-resume-"));

test("a fresh restart request is taken once; stale, malformed or missing ones are not", async () => {
  const userData = await dir();
  const request = (requestedAt: string) =>
    writeFile(join(userData, RESTART_REQUEST_FILE), JSON.stringify({ version: 1, requestedAt }));

  expect(await takeRestartRequest(userData, now)).toBe(false);
  await request(minutesAgo(1));
  expect(await takeRestartRequest(userData, now)).toBe(true);
  expect(await takeRestartRequest(userData, now)).toBe(false);
  await request(minutesAgo(30));
  expect(await takeRestartRequest(userData, now)).toBe(false);
  await writeFile(join(userData, RESTART_REQUEST_FILE), "{not json");
  expect(await takeRestartRequest(userData, now)).toBe(false);
  // Even an unusable request is removed, so it cannot apply to a later quit.
  await expect(readFile(join(userData, RESTART_REQUEST_FILE))).rejects.toThrow();
});

test("recorded threads are taken once on the next launch", async () => {
  const userData = await dir();
  const sessions = [
    { workspaceId: "w1", sessionId: "s1" },
    { workspaceId: "w2", sessionId: "s2" },
  ];
  await recordInterruptedSessions(userData, sessions, now);
  expect(await takeInterruptedSessions(userData, now)).toEqual(sessions);
  expect(await takeInterruptedSessions(userData, now)).toEqual([]);
});

test("no running threads records nothing, and a stale or malformed record resumes nothing", async () => {
  const userData = await dir();
  await recordInterruptedSessions(userData, [], now);
  await expect(readFile(join(userData, RESUME_AFTER_RESTART_FILE))).rejects.toThrow();

  await recordInterruptedSessions(userData, [{ workspaceId: "w", sessionId: "s" }], now);
  expect(await takeInterruptedSessions(userData, new Date(now.getTime() + 60 * 60_000))).toEqual(
    [],
  );

  await writeFile(
    join(userData, RESUME_AFTER_RESTART_FILE),
    JSON.stringify({
      version: 1,
      recordedAt: now.toISOString(),
      sessions: [{ workspaceId: "w", sessionId: 3 }, null, { workspaceId: "w", sessionId: "ok" }],
    }),
  );
  expect(await takeInterruptedSessions(userData, now)).toEqual([
    { workspaceId: "w", sessionId: "ok" },
  ]);
});
