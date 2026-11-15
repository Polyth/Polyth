// Host side of `SESSION_START_STEPS`: package-owned steps of a chat's start,
// keyed by `SessionStartRequest.extensions` id. One owner per id; the session
// service looks a step up per start, so a disabled package's id is unknown.
import type { SessionStartStep, SessionStartStepRegistry } from "@polyth/plugins";

export function createSessionStartStepRegistry(): SessionStartStepRegistry & {
  get(id: string): SessionStartStep | undefined;
} {
  const steps = new Map<string, SessionStartStep>();
  return {
    register(id, step) {
      if (typeof id !== "string" || !id.trim()) {
        throw Object.assign(new Error("start step id must be a non-empty string"), { code: "invalid-input" });
      }
      if (steps.has(id)) {
        throw Object.assign(new Error(`start step already registered: ${id}`), { code: "conflict" });
      }
      steps.set(id, step);
      return {
        dispose: () => {
          if (steps.get(id) === step) steps.delete(id);
        },
      };
    },
    get: (id) => steps.get(id),
  };
}
