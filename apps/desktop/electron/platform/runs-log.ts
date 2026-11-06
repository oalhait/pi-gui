import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunDiagnostic } from "@pi-gui/pi-sdk-driver";

/**
 * The runs log: one JSON line per run event and model request event (see
 * packages/pi-sdk-driver/src/run-diagnostics.ts), so a run that sat on "Waiting for the model"
 * can be explained afterwards: was the request sent, did the provider accept it, did pings
 * arrive, did Pi retry, did connection-resume wait, was it stopped.
 *
 * It holds ids, sizes, statuses, timings and provider error lines, never prompt or reply
 * text. Main writes it in the background; a failed write is dropped, never surfaced to a run.
 * When the file passes `maxBytes` it rotates to runs.1.log … runs.<keep>.log.
 */
export interface RunsLogOptions {
  readonly directory: string;
  readonly maxBytes?: number;
  readonly keep?: number;
  readonly now?: () => Date;
}

export const RUNS_LOG_FILE = "runs.log";

export class RunsLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private size: number | undefined;

  constructor(private readonly options: RunsLogOptions) {
    this.file = join(options.directory, RUNS_LOG_FILE);
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, options.keep ?? 3);
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.file;
  }

  /** Queue one entry; `flush()` resolves once it is written (or dropped). */
  record(diagnostic: RunDiagnostic): void {
    const line = `${JSON.stringify({ time: this.now().toISOString(), ...diagnostic })}\n`;
    this.queue = this.queue.then(() => this.write(line)).catch(() => undefined);
  }

  /** Resolves once every queued entry is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  private async write(line: string): Promise<void> {
    if (this.size === undefined) {
      await mkdir(this.options.directory, { recursive: true });
      this.size = await stat(this.file).then(
        (info) => info.size,
        () => 0,
      );
    }
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
    await appendFile(this.file, line, { mode: 0o600 });
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    const rotated = (index: number) => join(this.options.directory, `runs.${index}.log`);
    await rm(rotated(this.keep), { force: true });
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      await rename(rotated(index), rotated(index + 1)).catch(() => undefined);
    }
    await rename(this.file, rotated(1)).catch(() => undefined);
    this.size = 0;
  }
}
