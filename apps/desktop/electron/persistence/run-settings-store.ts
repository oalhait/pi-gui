import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

/**
 * Run settings that main applies to every model request, kept apart from ui-state so that an
 * older build reading ui-state never meets a field it does not know.
 *
 * `modelStallTimeoutSeconds`: how long a model request may go without output before pi-gui
 * ends it as stalled and Pi retries it once (see the driver's model-request-monitor.ts).
 * 0 turns the detector off.
 */
export interface RunSettings {
  readonly modelStallTimeoutSeconds: number;
}

export const RUN_SETTINGS_FILE = "run-settings.json";
export const DEFAULT_RUN_SETTINGS: RunSettings = { modelStallTimeoutSeconds: 120 };
/** The choices Settings offers; any whole number in range is accepted from the file. */
export const MODEL_STALL_TIMEOUT_CHOICES = [0, 60, 120, 180, 300] as const;
const MAX_STALL_SECONDS = 3_600;

interface PersistedRunSettings {
  readonly version: 1;
  readonly modelStallTimeoutSeconds: number;
}

export function isValidStallTimeoutSeconds(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_STALL_SECONDS
  );
}

export function decodeRunSettings(value: unknown): RunSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("run settings: not an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "modelStallTimeoutSeconds") {
      throw new Error(`run settings: unsupported field ${key}`);
    }
  }
  if (record.version !== 1) throw new Error("run settings: unsupported version");
  if (!isValidStallTimeoutSeconds(record.modelStallTimeoutSeconds)) {
    throw new Error("run settings: invalid modelStallTimeoutSeconds");
  }
  return { modelStallTimeoutSeconds: record.modelStallTimeoutSeconds };
}

/**
 * Read the saved settings. Missing means defaults; an invalid file also yields defaults for
 * this launch, and is left in place: a later write refuses to replace it without a backup.
 */
export async function readRunSettings(userDataDir: string): Promise<RunSettings> {
  const result = await readJsonWithBackup(join(userDataDir, RUN_SETTINGS_FILE));
  if (result.value === undefined) return DEFAULT_RUN_SETTINGS;
  try {
    return decodeRunSettings(result.value);
  } catch (error) {
    console.error("[run-settings]", error instanceof Error ? error.message : error);
    return DEFAULT_RUN_SETTINGS;
  }
}

export async function writeRunSettings(userDataDir: string, settings: RunSettings): Promise<void> {
  const persisted: PersistedRunSettings = {
    version: 1,
    modelStallTimeoutSeconds: settings.modelStallTimeoutSeconds,
  };
  await writeFileAtomicQueued(
    join(userDataDir, RUN_SETTINGS_FILE),
    `${JSON.stringify(persisted, null, 2)}\n`,
    decodeRunSettings,
  );
}
