/** Wire records. Either side may send requests and notifications; responses answer requests. */

export const PROTOCOL_VERSION = 1;

export interface WireError {
  readonly message: string;
  /** Stable machine-readable code, e.g. `method_not_found`, `disconnected`, `unavailable`. */
  readonly code?: string;
  /** The original error's `name`, so the receiver can show or match it. */
  readonly name?: string;
}

export interface RequestRecord {
  readonly type: "request";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface ResultRecord {
  readonly type: "response";
  readonly id: number;
  readonly result?: unknown;
}

export interface ErrorRecord {
  readonly type: "response";
  readonly id: number;
  readonly error: WireError;
}

export interface NotificationRecord {
  readonly type: "notification";
  readonly method: string;
  readonly params?: unknown;
}

export type WireRecord = RequestRecord | ResultRecord | ErrorRecord | NotificationRecord;

/** Sent by a peer that no longer wants the answer to one of its requests. */
export const CANCEL_NOTIFICATION = "$/cancel";

export interface CancelParams {
  readonly id: number;
}

export const ErrorCodes = {
  /** The connection closed before the request was answered. */
  disconnected: "disconnected",
  /** No handler is registered for the method. */
  methodNotFound: "method_not_found",
  /** The record was malformed. */
  invalidRequest: "invalid_request",
  /** The request was cancelled by its sender, or timed out. */
  cancelled: "cancelled",
  /** The handler threw. */
  failed: "failed",
  /** The protocol versions are incompatible. */
  incompatible: "incompatible",
  /** The operation is not supported for remote workspaces (yet). */
  unavailable: "unavailable",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates the envelope of a decoded record. Params and results are validated by their owners. */
export function parseWireRecord(value: unknown): WireRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  switch (value.type) {
    case "request":
      return Number.isSafeInteger(value.id) && typeof value.method === "string"
        ? (value as unknown as RequestRecord)
        : undefined;
    case "response": {
      if (!Number.isSafeInteger(value.id)) {
        return undefined;
      }
      if ("error" in value) {
        const error = value.error;
        return isObject(error) && typeof error.message === "string"
          ? (value as unknown as ErrorRecord)
          : undefined;
      }
      return value as unknown as ResultRecord;
    }
    case "notification":
      return typeof value.method === "string"
        ? (value as unknown as NotificationRecord)
        : undefined;
    default:
      return undefined;
  }
}
