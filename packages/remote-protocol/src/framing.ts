/**
 * JSONL framing: one JSON value per line, terminated by LF.
 *
 * Records are split only on the LF byte. JSON.stringify escapes LF inside strings, so it can never
 * appear inside a record, but U+2028/U+2029 are emitted raw and must not end a record (Node's
 * `readline` would split on them). A CR before the LF is tolerated.
 */

export const DEFAULT_MAX_RECORD_BYTES = 128 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export class RecordTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Remote record exceeds ${limitBytes} bytes`);
    this.name = "RecordTooLargeError";
  }
}

export function encodeRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Splits a byte stream into complete UTF-8 lines. Partial lines are buffered until their LF. */
export class JsonlDecoder {
  private readonly maxRecordBytes: number;
  private readonly decoder = new TextDecoder("utf-8");
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(options: { readonly maxRecordBytes?: number } = {}) {
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  }

  /** Returns the complete lines in `chunk` (without terminators). Empty lines are skipped. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = chunk.indexOf(LF); index !== -1; index = chunk.indexOf(LF, start)) {
      this.append(chunk.subarray(start, index));
      const line = this.takeLine();
      if (line) {
        lines.push(line);
      }
      start = index + 1;
    }
    if (start < chunk.length) {
      this.append(chunk.subarray(start));
    }
    return lines;
  }

  /** Bytes buffered after the last LF. */
  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    if (this.pendingBytes + bytes.length > this.maxRecordBytes) {
      this.pending = [];
      this.pendingBytes = 0;
      throw new RecordTooLargeError(this.maxRecordBytes);
    }
    // Copy: callers may reuse the chunk's buffer after push returns.
    this.pending.push(bytes.slice());
    this.pendingBytes += bytes.length;
  }

  private takeLine(): string {
    let bytes: Uint8Array;
    if (this.pending.length === 1) {
      bytes = this.pending[0]!;
    } else {
      bytes = new Uint8Array(this.pendingBytes);
      let offset = 0;
      for (const part of this.pending) {
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    this.pending = [];
    this.pendingBytes = 0;
    const end =
      bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
    return this.decoder.decode(bytes.subarray(0, end));
  }
}
