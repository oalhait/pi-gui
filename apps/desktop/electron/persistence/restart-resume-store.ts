import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";

/*
 * Continuing the threads a rebuild cut off. `pnpm app:restart` writes the request file just
 * before it quits the installed app; a quit that finds a fresh request records the threads
 * still running, and the next launch sends each one a message to continue. Both files are
 * removed once read, so a crash on relaunch never resends anything.
 */

/** Written by `apps/desktop/scripts/restart-installed-app.mjs`; keep the name in sync. */
export const RESTART_REQUEST_FILE = "restart-request.json";
export const RESUME_AFTER_RESTART_FILE = "resume-after-restart.json";

/** A request older than this is left over from a restart that never quit the app. */
const REQUEST_MAX_AGE_MS = 10 * 60_000;
/** A relaunch later than this is not the restart that recorded the threads. */
const RESUME_MAX_AGE_MS = 30 * 60_000;

export const RESUME_AFTER_RESTART_MESSAGE =
  "pi-gui was restarted to install a new build while this thread was running, so the run " +
  "was cut off. Any command or tool call that was in progress did not return a result. " +
  "Check what had finished, then continue where you left off.";

interface RestartRequest {
  readonly version: 1;
  readonly requestedAt: string;
}

interface ResumeRecord {
  readonly version: 1;
  readonly recordedAt: string;
  readonly sessions: readonly SessionRef[];
}

/** Reads and removes the restart request; true when one was made within the last minutes. */
export async function takeRestartRequest(userDataDir: string, now = new Date()): Promise<boolean> {
  const file = path.join(userDataDir, RESTART_REQUEST_FILE);
  const raw = await readOptional(file);
  if (raw === undefined) return false;
  await rm(file, { force: true });
  const request = parse(raw) as Partial<RestartRequest> | undefined;
  return (
    request?.version === 1 &&
    typeof request.requestedAt === "string" &&
    isRecent(request.requestedAt, now, REQUEST_MAX_AGE_MS)
  );
}

export async function recordInterruptedSessions(
  userDataDir: string,
  sessions: readonly SessionRef[],
  now = new Date(),
): Promise<void> {
  const file = path.join(userDataDir, RESUME_AFTER_RESTART_FILE);
  if (sessions.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const record: ResumeRecord = {
    version: 1,
    recordedAt: now.toISOString(),
    sessions: sessions.map(({ workspaceId, sessionId }) => ({ workspaceId, sessionId })),
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/** Reads and removes the recorded threads; none when the record is stale or malformed. */
export async function takeInterruptedSessions(
  userDataDir: string,
  now = new Date(),
): Promise<SessionRef[]> {
  const file = path.join(userDataDir, RESUME_AFTER_RESTART_FILE);
  const raw = await readOptional(file);
  if (raw === undefined) return [];
  await rm(file, { force: true });
  const record = parse(raw) as Partial<ResumeRecord> | undefined;
  if (
    record?.version !== 1 ||
    typeof record.recordedAt !== "string" ||
    !isRecent(record.recordedAt, now, RESUME_MAX_AGE_MS) ||
    !Array.isArray(record.sessions)
  ) {
    return [];
  }
  return record.sessions.flatMap((session: unknown) => {
    if (typeof session !== "object" || session === null) return [];
    const { workspaceId, sessionId } = session as Record<string, unknown>;
    return typeof workspaceId === "string" && typeof sessionId === "string"
      ? [{ workspaceId, sessionId }]
      : [];
  });
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecent(timestamp: string, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -60_000 && age <= maxAgeMs;
}
