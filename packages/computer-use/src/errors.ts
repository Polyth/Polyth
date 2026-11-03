export type ComputerUseErrorCode =
  | "invalid-input"
  | "forbidden"
  | "unsupported"
  | "missing-helper"
  | "permission-required"
  | "driver-failed"
  | "not-found"
  | "timeout"
  | "aborted";

export class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode;

  constructor(code: ComputerUseErrorCode, message: string) {
    super(message);
    this.name = "ComputerUseError";
    this.code = code;
  }
}

export const invalid = (message: string): ComputerUseError => new ComputerUseError("invalid-input", message);
