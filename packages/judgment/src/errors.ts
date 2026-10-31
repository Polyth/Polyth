import type { JudgmentFailureReason } from "./types.ts";

/** Adapter errors carry only canonical codes. Native messages/bodies never cross this boundary. */
export class JudgmentExecutionError extends Error {
  readonly reason: JudgmentFailureReason;
  readonly retryable: boolean;
  constructor(reason: JudgmentFailureReason, retryable = false) {
    super(reason);
    this.name = "JudgmentExecutionError";
    this.reason = reason;
    this.retryable = retryable && (reason === "provider-error" || reason === "provider-unavailable");
  }
}
