import { encodeRecord } from "./framing.js";
import {
  CANCEL_NOTIFICATION,
  ErrorCodes,
  parseWireRecord,
  type CancelParams,
  type ErrorCode,
  type RequestRecord,
  type WireError,
  type WireRecord,
} from "./messages.js";

/** An error received from, or caused by, the other side of a connection. */
export class RemoteError extends Error {
  readonly code: ErrorCode | (string & {});
  readonly remoteName: string | undefined;

  constructor(message: string, code: ErrorCode | (string & {}), remoteName?: string) {
    super(message);
    this.name = remoteName ?? "RemoteError";
    this.code = code;
    this.remoteName = remoteName;
  }

  static fromWire(error: WireError): RemoteError {
    return new RemoteError(error.message, error.code ?? ErrorCodes.failed, error.name);
  }
}

export function isRemoteError(error: unknown, code?: ErrorCode): error is RemoteError {
  return error instanceof RemoteError && (code === undefined || error.code === code);
}

export function toWireError(error: unknown): WireError {
  if (error instanceof RemoteError) {
    return { message: error.message, code: error.code, name: error.name };
  }
  if (error instanceof Error) {
    return { message: error.message || String(error), code: ErrorCodes.failed, name: error.name };
  }
  return { message: String(error), code: ErrorCodes.failed };
}

export interface RequestContext {
  /** Aborted when the sender cancels the request or the connection closes. */
  readonly signal: AbortSignal;
}

export type RequestHandler = (params: unknown, context: RequestContext) => unknown;
export type NotificationHandler = (params: unknown) => void;

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Rejects with `cancelled` and tells the other side to stop. No timeout when omitted. */
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/**
 * One end of a connection. It correlates requests with responses, dispatches incoming requests
 * and notifications to handlers, and propagates cancellation in both directions.
 *
 * The transport writes each encoded line (`send`), feeds decoded values to `receive` and calls
 * `close` when the connection ends.
 */
export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly incoming = new Map<number, AbortController>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly closeListeners = new Set<(reason: Error) => void>();
  private closeReason: Error | undefined;

  constructor(private readonly sendLine: (line: string) => void) {}

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  handle(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closeReason) {
      listener(this.closeReason);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closeReason) {
      return Promise.reject(this.closeReason);
    }
    if (options.signal?.aborted) {
      return Promise.reject(new RemoteError(`${method} was cancelled`, ErrorCodes.cancelled));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (message: string) => {
        if (!this.pending.has(id)) {
          return;
        }
        this.settle(id);
        this.trySend({
          type: "notification",
          method: CANCEL_NOTIFICATION,
          params: { id } satisfies CancelParams,
        });
        reject(new RemoteError(message, ErrorCodes.cancelled));
      };
      const onAbort = () => cancel(`${method} was cancelled`);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => cancel(`${method} timed out after ${options.timeoutMs} ms`),
          options.timeoutMs,
        );
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          if (timer) {
            clearTimeout(timer);
          }
          options.signal?.removeEventListener("abort", onAbort);
        },
      });
      let sent: boolean;
      try {
        sent = this.trySend({
          type: "request",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.settle(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!sent) {
        this.settle(id);
        reject(this.closeReason ?? new RemoteError("Connection closed", ErrorCodes.disconnected));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.trySend({ type: "notification", method, ...(params === undefined ? {} : { params }) });
  }

  receive(value: unknown): void {
    if (this.closeReason) {
      return;
    }
    const record = parseWireRecord(value);
    if (!record) {
      this.close(new RemoteError("Received a malformed record", ErrorCodes.invalidRequest));
      return;
    }
    switch (record.type) {
      case "request":
        this.dispatchRequest(record);
        return;
      case "response": {
        const pending = this.settle(record.id);
        if (!pending) {
          return; // Late answer to a cancelled or timed-out request.
        }
        if ("error" in record) {
          pending.reject(RemoteError.fromWire(record.error));
        } else {
          pending.resolve(record.result);
        }
        return;
      }
      case "notification":
        if (record.method === CANCEL_NOTIFICATION) {
          const id = (record.params as Partial<CancelParams> | undefined)?.id;
          if (typeof id === "number") {
            this.incoming.get(id)?.abort();
          }
          return;
        }
        for (const handler of this.notificationHandlers.get(record.method) ?? []) {
          try {
            handler(record.params);
          } catch {
            // A failing listener must not stop the others or close the connection.
          }
        }
        return;
    }
  }

  /** Rejects outstanding requests, aborts incoming handlers and notifies close listeners. */
  close(reason: Error = new RemoteError("Connection closed", ErrorCodes.disconnected)): void {
    if (this.closeReason) {
      return;
    }
    this.closeReason =
      reason instanceof RemoteError
        ? reason
        : new RemoteError(reason.message, ErrorCodes.disconnected);
    for (const id of [...this.pending.keys()]) {
      this.settle(id)?.reject(this.closeReason);
    }
    for (const controller of this.incoming.values()) {
      controller.abort();
    }
    this.incoming.clear();
    for (const listener of this.closeListeners) {
      listener(this.closeReason);
    }
    this.closeListeners.clear();
  }

  private settle(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      pending.cleanup();
    }
    return pending;
  }

  private dispatchRequest(record: RequestRecord): void {
    const handler = this.requestHandlers.get(record.method);
    if (!handler) {
      this.trySend({
        type: "response",
        id: record.id,
        error: { message: `Unknown method ${record.method}`, code: ErrorCodes.methodNotFound },
      });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(record.id, controller);
    this.runRequest(record, handler, controller).catch(() => undefined);
  }

  private async runRequest(
    record: RequestRecord,
    handler: RequestHandler,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await handler(record.params, { signal: controller.signal });
      let line: string;
      try {
        line = encodeRecord({
          type: "response",
          id: record.id,
          ...(result === undefined ? {} : { result }),
        });
      } catch (error) {
        throw new RemoteError(
          `${record.method} returned a value that cannot be sent: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCodes.failed,
        );
      }
      this.trySendLine(line);
    } catch (error) {
      this.trySend({ type: "response", id: record.id, error: toWireError(error) });
    } finally {
      this.incoming.delete(record.id);
    }
  }

  /** Throws only when `record` cannot be encoded; a failed write closes the connection. */
  private trySend(record: WireRecord): boolean {
    return this.trySendLine(encodeRecord(record));
  }

  private trySendLine(line: string): boolean {
    if (this.closeReason) {
      return false;
    }
    try {
      this.sendLine(line);
      return true;
    } catch (error) {
      this.close(
        new RemoteError(
          `Could not send to the remote host: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCodes.disconnected,
        ),
      );
      return false;
    }
  }
}
