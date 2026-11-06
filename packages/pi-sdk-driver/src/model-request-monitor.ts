/**
 * Watching a run's model requests from the outside.
 *
 * Pi's agent loop asks the session's stream function for each model request and the provider
 * SDK sends it with the `fetch` in the request options. Wrapping that stream function lets
 * pi-gui pass its own `fetch`, which sees exactly what a request did on the wire: when it was
 * sent, the response status and request id, the SSE events (pings included) and the first
 * output. That is what the runs log records and what the waiting line shows.
 *
 * It also detects a request the provider accepted but never answers. Anthropic can hold a
 * long-context request open for minutes, sending only keep-alive pings, so neither the SDK's
 * header timeout nor the body idle timeout ever fires and the run waits forever. When no
 * output arrives within the stall timeout, the attempt is ended with a stall error. The first
 * stall's error reads as a timeout, so Pi retries the same request (the failed attempt is left
 * out of the context, so the prompt cache prefix is unchanged); a second stall in a row ends
 * the run with an error that neither Pi nor connection-resume retries.
 *
 * Nothing here reads prompt or response content: only sizes, statuses, ids and SSE event names.
 */

/** The wire phase of a model request, as the waiting line shows it. */
export type ModelRequestPhase = "sending" | "accepted";

/** What one request has done so far, before its first output. */
export interface ModelRequestProgress {
  readonly phase: ModelRequestPhase;
  /** HTTP status, once the response headers arrived. */
  readonly status?: number;
  /** Keep-alive pings received before the first output. */
  readonly pings: number;
  /** When the stall detector ends this attempt if nothing arrives; absent when it is off. */
  readonly stallAt?: number;
}

/** Content-free metadata about one model request, for the runs log. */
export type ModelRequestDiagnostic =
  | {
      readonly kind: "request_start";
      readonly attempt: number;
      readonly provider: string;
      readonly model: string;
      readonly api: string;
      /** A cache-warming replay of an earlier request, not a run attempt. */
      readonly cacheWarm: boolean;
      readonly bodyBytes?: number;
      /** Rough prompt size: request body bytes / 4. */
      readonly contextTokensEstimate?: number;
      readonly stallTimeoutMs?: number;
    }
  | {
      readonly kind: "response_headers";
      readonly attempt: number;
      readonly cacheWarm: boolean;
      readonly status: number;
      readonly requestId?: string;
      readonly contentType?: string;
      readonly afterMs: number;
    }
  | {
      readonly kind: "first_event";
      readonly attempt: number;
      readonly event: string;
      readonly afterMs: number;
    }
  | {
      readonly kind: "first_output";
      readonly attempt: number;
      readonly afterMs: number;
      readonly pings: number;
    }
  | {
      readonly kind: "stall";
      readonly attempt: number;
      readonly afterMs: number;
      readonly phase: ModelRequestPhase;
      readonly pings: number;
      readonly timeoutMs: number;
      /** "retry": the error lets Pi retry; "fail": the second stall in a row ends the run. */
      readonly action: "retry" | "fail";
    }
  | {
      readonly kind: "request_end";
      readonly attempt: number;
      readonly cacheWarm: boolean;
      readonly outcome: "done" | "error" | "aborted";
      readonly stopReason?: string;
      readonly error?: string;
      readonly afterMs: number;
      readonly pings: number;
      readonly bytesIn: number;
    };

export interface ModelRequestMonitorHooks {
  /** Milliseconds without output before an attempt counts as stalled; 0 or less turns it off. */
  readonly stallTimeoutMs: () => number;
  /**
   * Consecutive stalled attempts without any output in between, including the one now ending.
   * Owned by the caller so that it survives Pi's retries and resets on output.
   */
  readonly recordStall: () => number;
  readonly resetStalls: () => void;
  readonly onProgress: (progress: ModelRequestProgress) => void;
  readonly onFirstOutput: () => void;
  readonly onDiagnostic: (diagnostic: ModelRequestDiagnostic) => void;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Minimal view of pi's stream function, so this module needs no runtime import from Pi. */
type StreamFunction = (model: never, context: never, options?: never) => unknown;

interface StreamEventLike {
  readonly type: string;
  readonly error?: { errorMessage?: string; stopReason?: string };
  readonly message?: { stopReason?: string };
}

interface PushableStream {
  push(event: StreamEventLike): void;
}

/** The text of a stalled attempt's error. The first is retryable ("timed out"); the second is not. */
export function stallErrorMessage(timeoutMs: number, final: boolean): string {
  const seconds = Math.round(timeoutMs / 1000);
  return final
    ? `The model stalled again: no output for ${seconds}s after the request was sent. Send the message again to start over.`
    : `The model stalled: no output for ${seconds}s after the request was sent. Request timed out.`;
}

/** Whether an error message is one of this module's stall errors. */
export function isModelStallError(message: string | undefined): boolean {
  return typeof message === "string" && /^The model stalled(?: again)?: no output/.test(message);
}

let attemptCounter = 0;

/**
 * Wrap pi's stream function so every model request it makes goes through a monitored fetch.
 * The returned function has the same shape and passes everything else through unchanged.
 */
export function monitorStreamFunction<T extends StreamFunction>(
  original: T,
  hooks: ModelRequestMonitorHooks,
): T {
  const wrapped = (model: unknown, context: unknown, options?: unknown) => {
    const attempt = new ModelRequestAttempt(++attemptCounter, model, hooks);
    const opts = (options ?? {}) as Record<string, unknown>;
    const baseFetch = (opts.fetch as typeof globalThis.fetch | undefined) ?? hooks.fetch;
    const nextOptions = { ...opts, fetch: attempt.fetchFor(baseFetch) };
    const result = (original as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(
      model,
      context,
      nextOptions,
    );
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((stream) => attempt.observe(stream));
    }
    return attempt.observe(result);
  };
  return wrapped as unknown as T;
}

class ModelRequestAttempt {
  private readonly now: () => number;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly api: string;
  /** The stream reported done or error: later fetches through this options object are cache warms. */
  private ended = false;
  private startedAt = 0;
  private phase: ModelRequestPhase = "sending";
  private status: number | undefined;
  private pings = 0;
  private bytesIn = 0;
  private sawFirstEvent = false;
  private sawOutput = false;
  private stallAt: number | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the stall detector ended this attempt; the error is rewritten to say so. */
  private stallMessage: string | undefined;
  private abortCurrent: ((reason: Error) => void) | undefined;

  constructor(
    private readonly id: number,
    model: unknown,
    private readonly hooks: ModelRequestMonitorHooks,
  ) {
    this.now = hooks.now ?? Date.now;
    const record = isRecord(model) ? model : {};
    this.provider = typeof record.provider === "string" ? record.provider : "unknown";
    this.modelId = typeof record.id === "string" ? record.id : "unknown";
    this.api = typeof record.api === "string" ? record.api : "unknown";
  }

  fetchFor(baseFetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
    return (input, init) => {
      const base = baseFetch ?? globalThis.fetch;
      if (this.ended) return this.cacheWarmFetch(base, input, init);
      return this.attemptFetch(base, input, init);
    };
  }

  /** Watch pi's event stream: the first output clears the stall timer; the end is logged. */
  observe(stream: unknown): unknown {
    if (!isRecord(stream) || typeof stream.push !== "function") return stream;
    const pushable = stream as unknown as PushableStream;
    const push = pushable.push.bind(pushable);
    // Pi's provider pushes every event through this method, after this wrapper returns; the
    // stall error can only be pushed seconds later, once the timer has fired.
    pushable.push = (event: StreamEventLike) => {
      this.onStreamEvent(event);
      push(event);
    };
    return stream;
  }

  private onStreamEvent(event: StreamEventLike): void {
    if (event.type === "done" || event.type === "error") {
      if (event.type === "error" && event.error && this.stallMessage) {
        event.error.errorMessage = this.stallMessage;
        event.error.stopReason = "error";
      }
      this.finish(event);
      return;
    }
    if (event.type !== "start") this.markOutput();
  }

  private async attemptFetch(
    base: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    this.startedAt = this.now();
    this.phase = "sending";
    this.status = undefined;
    const bodyBytes = bodySize(init?.body);
    const timeoutMs = Math.max(0, this.hooks.stallTimeoutMs());
    this.hooks.onDiagnostic({
      kind: "request_start",
      attempt: this.id,
      provider: this.provider,
      model: this.modelId,
      api: this.api,
      cacheWarm: false,
      ...(bodyBytes !== undefined
        ? { bodyBytes, contextTokensEstimate: Math.round(bodyBytes / 4) }
        : {}),
      ...(timeoutMs > 0 ? { stallTimeoutMs: timeoutMs } : {}),
    });

    const controller = new AbortController();
    const outer = init?.signal ?? undefined;
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", onOuterAbort, { once: true });
    let errorTap: ((reason: Error) => void) | undefined;
    this.abortCurrent = (reason) => {
      errorTap?.(reason);
      controller.abort(reason);
    };
    this.armStall(timeoutMs);
    this.publish();

    let response: Response;
    try {
      response = await base(input, { ...init, signal: controller.signal });
    } catch (error) {
      outer?.removeEventListener("abort", onOuterAbort);
      throw error;
    }
    this.phase = "accepted";
    this.status = response.status;
    const contentType = response.headers.get("content-type") ?? undefined;
    const requestId =
      response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
    this.hooks.onDiagnostic({
      kind: "response_headers",
      attempt: this.id,
      cacheWarm: false,
      status: response.status,
      ...(requestId ? { requestId } : {}),
      ...(contentType ? { contentType } : {}),
      afterMs: this.now() - this.startedAt,
    });
    this.publish();
    if (!response.body || !response.ok) {
      outer?.removeEventListener("abort", onOuterAbort);
      return response;
    }
    const scanner = new SseEventScanner();
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      start: (tapController) => {
        errorTap = (reason) => tapController.error(reason);
      },
      transform: (chunk, tapController) => {
        this.bytesIn += chunk.byteLength;
        if (!this.sawOutput) {
          for (const name of scanner.push(chunk)) this.onSseEvent(name);
        }
        tapController.enqueue(chunk);
      },
      flush: () => {
        outer?.removeEventListener("abort", onOuterAbort);
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** A cache-warming replay reuses the request options; log it, but never stall-check it. */
  private async cacheWarmFetch(
    base: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const startedAt = this.now();
    const bodyBytes = bodySize(init?.body);
    this.hooks.onDiagnostic({
      kind: "request_start",
      attempt: this.id,
      provider: this.provider,
      model: this.modelId,
      api: this.api,
      cacheWarm: true,
      ...(bodyBytes !== undefined
        ? { bodyBytes, contextTokensEstimate: Math.round(bodyBytes / 4) }
        : {}),
    });
    try {
      const response = await base(input, init);
      const requestId =
        response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
      this.hooks.onDiagnostic({
        kind: "response_headers",
        attempt: this.id,
        cacheWarm: true,
        status: response.status,
        ...(requestId ? { requestId } : {}),
        afterMs: this.now() - startedAt,
      });
      return response;
    } catch (error) {
      this.hooks.onDiagnostic({
        kind: "request_end",
        attempt: this.id,
        cacheWarm: true,
        outcome: "error",
        error: shortError(error),
        afterMs: this.now() - startedAt,
        pings: 0,
        bytesIn: 0,
      });
      throw error;
    }
  }

  private onSseEvent(name: string): void {
    if (name === "ping") {
      this.pings += 1;
      this.publish();
      return;
    }
    if (!this.sawFirstEvent) {
      this.sawFirstEvent = true;
      this.hooks.onDiagnostic({
        kind: "first_event",
        attempt: this.id,
        event: name,
        afterMs: this.now() - this.startedAt,
      });
    }
    if (!ACCEPTANCE_EVENTS.has(name)) this.markOutput();
  }

  private markOutput(): void {
    if (this.sawOutput || this.ended) return;
    this.sawOutput = true;
    this.clearStall();
    this.hooks.resetStalls();
    this.hooks.onDiagnostic({
      kind: "first_output",
      attempt: this.id,
      afterMs: this.startedAt ? this.now() - this.startedAt : 0,
      pings: this.pings,
    });
    this.hooks.onFirstOutput();
  }

  private armStall(timeoutMs: number): void {
    this.clearStall();
    if (timeoutMs <= 0 || this.sawOutput) return;
    this.stallAt = this.now() + timeoutMs;
    this.stallTimer = setTimeout(() => this.onStall(timeoutMs), timeoutMs);
    this.stallTimer.unref?.();
  }

  private clearStall(): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallAt = undefined;
  }

  private onStall(timeoutMs: number): void {
    this.stallTimer = undefined;
    this.stallAt = undefined;
    if (this.sawOutput || this.ended) return;
    const stalls = this.hooks.recordStall();
    const final = stalls >= 2;
    this.stallMessage = stallErrorMessage(timeoutMs, final);
    this.hooks.onDiagnostic({
      kind: "stall",
      attempt: this.id,
      afterMs: this.now() - this.startedAt,
      phase: this.phase,
      pings: this.pings,
      timeoutMs,
      action: final ? "fail" : "retry",
    });
    this.abortCurrent?.(new Error(this.stallMessage));
  }

  private finish(event: StreamEventLike): void {
    if (this.ended) return;
    this.ended = true;
    this.clearStall();
    this.abortCurrent = undefined;
    const stopReason = event.type === "error" ? event.error?.stopReason : event.message?.stopReason;
    const outcome = event.type === "done" ? "done" : stopReason === "aborted" ? "aborted" : "error";
    const error = event.type === "error" ? event.error?.errorMessage : undefined;
    this.hooks.onDiagnostic({
      kind: "request_end",
      attempt: this.id,
      cacheWarm: false,
      outcome,
      ...(stopReason ? { stopReason } : {}),
      ...(error ? { error: shortError(error) } : {}),
      afterMs: this.startedAt ? this.now() - this.startedAt : 0,
      pings: this.pings,
      bytesIn: this.bytesIn,
    });
  }

  private publish(): void {
    if (this.sawOutput || this.ended) return;
    this.hooks.onProgress({
      phase: this.phase,
      ...(this.status !== undefined ? { status: this.status } : {}),
      pings: this.pings,
      ...(this.stallAt !== undefined ? { stallAt: this.stallAt } : {}),
    });
  }
}

/**
 * SSE events that say the provider accepted the request, not that the model has answered.
 * Anthropic sends `message_start` first; OpenAI Responses sends `response.created` and
 * `response.in_progress`.
 */
const ACCEPTANCE_EVENTS = new Set([
  "message_start",
  "response.created",
  "response.in_progress",
  "response.queued",
]);

/** Longest partial line kept between chunks; only `event:` names are needed. */
const MAX_PENDING_LINE = 4_096;

/**
 * Reads SSE event names from raw response bytes. An event with only `data:` lines is named
 * "message", as SSE specifies. Comment lines (": keep-alive") count as pings. Data is never kept.
 */
export class SseEventScanner {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private eventName: string | undefined;
  private hasData = false;

  push(chunk: Uint8Array): string[] {
    const names: string[] = [];
    const text = this.pending + this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      const line = text.slice(start, newline).replace(/\r$/, "");
      start = newline + 1;
      const name = this.line(line);
      if (name) names.push(name);
    }
    const rest = text.slice(start);
    // A long data line is cut; its start is all that matters ("data:" or "event:").
    this.pending = rest.length > MAX_PENDING_LINE ? rest.slice(0, 64) : rest;
    return names;
  }

  private line(line: string): string | undefined {
    if (line === "") {
      const name = this.eventName ?? (this.hasData ? "message" : undefined);
      this.eventName = undefined;
      this.hasData = false;
      return name;
    }
    if (line.startsWith(":")) return "ping";
    if (line.startsWith("event:")) this.eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) this.hasData = true;
    return undefined;
  }
}

function bodySize(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}

/** A provider error, cut to its first line and 300 characters; never prompt text. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 300 ? `${firstLine.slice(0, 299)}…` : firstLine;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
