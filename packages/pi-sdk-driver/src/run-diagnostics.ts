import type { ModelRequestDiagnostic } from "./model-request-monitor.js";

/**
 * Content-free metadata about a run, for the desktop's runs log: what each model request did
 * on the wire (see model-request-monitor.ts) and what the run itself was doing around it
 * (Pi's retries and their backoff, connection-resume decisions, compaction, Stop, the end).
 * Ids, sizes, statuses, timings and provider error text only; never prompt or reply content.
 */
export type RunLifecycleDiagnostic =
  | { readonly kind: "prompt_start" }
  /** Pi's agent loop starts; its retries and continuations start it again in the same run. */
  | { readonly kind: "agent_start" }
  | { readonly kind: "turn_start" }
  | {
      readonly kind: "retry_backoff";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly error: string;
    }
  | {
      readonly kind: "retry_end";
      readonly attempt: number;
      readonly success: boolean;
      readonly error?: string;
    }
  | {
      readonly kind: "connection_resume_wait";
      readonly attempt: number;
      readonly delayMs: number;
      readonly error: string;
    }
  | {
      readonly kind: "connection_resume";
      readonly decision: "resume" | "give_up";
      readonly reason?: string;
    }
  | { readonly kind: "compaction_start"; readonly reason?: string }
  | { readonly kind: "compaction_end" }
  | { readonly kind: "stop_requested" }
  | { readonly kind: "run_end"; readonly outcome: string; readonly aborted: boolean };

export type RunDiagnostic = (ModelRequestDiagnostic | RunLifecycleDiagnostic) & {
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The desktop run this belongs to, when one is running. */
  readonly runId?: string;
};

/** A request with no model output for this long is ended as stalled; see model-request-monitor.ts. */
export const DEFAULT_MODEL_STALL_TIMEOUT_MS = 120_000;
