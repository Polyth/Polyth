import type { OpenCodeRuntimePolicyDto } from "@polyth/contracts";

export const OPENCODE_MAX_IDLE_TTL_MINUTES = 1_440;
export const OPENCODE_MAX_WARM_WORKSPACES = 16;

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function parseOpenCodeRuntimePolicy(value: unknown): OpenCodeRuntimePolicyDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("settings must be an object");
  const input = value as Record<string, unknown>;
  if (input.mode !== "default" && input.mode !== "keep-warm" && input.mode !== "off") {
    return invalid("mode must be default, keep-warm or off");
  }
  if (!Number.isSafeInteger(input.idleTtlMinutes) || Number(input.idleTtlMinutes) < 1 || Number(input.idleTtlMinutes) > OPENCODE_MAX_IDLE_TTL_MINUTES) {
    return invalid(`idle timeout must be between 1 and ${OPENCODE_MAX_IDLE_TTL_MINUTES} minutes`);
  }
  if (!Number.isSafeInteger(input.maxWarmWorkspaces) || Number(input.maxWarmWorkspaces) < 1 || Number(input.maxWarmWorkspaces) > OPENCODE_MAX_WARM_WORKSPACES) {
    return invalid(`warm workspace limit must be between 1 and ${OPENCODE_MAX_WARM_WORKSPACES}`);
  }
  return { mode: input.mode, idleTtlMinutes: Number(input.idleTtlMinutes), maxWarmWorkspaces: Number(input.maxWarmWorkspaces) };
}
