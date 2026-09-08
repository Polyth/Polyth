import type { UserTurnInput } from "@polyth/contracts";

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

/** Parse a turn `command` body. Absent key → undefined; present but malformed → throw. */
export const parseTurnCommand = (value: unknown): UserTurnInput["command"] | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("command must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    throw invalid("command.id is required");
  }
  if (raw.owner !== undefined && raw.owner !== "native") {
    throw invalid("command.owner must be native when present");
  }
  if (raw.args !== undefined && typeof raw.args !== "string") {
    throw invalid("command.args must be a string");
  }
  return {
    id: raw.id.trim(),
    ...(typeof raw.args === "string" ? { args: raw.args } : {}),
  };
};
