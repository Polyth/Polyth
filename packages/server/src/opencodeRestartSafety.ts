import type { SessionProjection } from "@polyth/contracts";
import type { RuntimeRestartFingerprint } from "./sessions.ts";

/**
 * Returns true if the session should be skipped during OpenCode config-restart assessment.
 *
 * Sessions resolved or pinned to another harness (e.g. Claude, Codex, Antigravity)
 * are skipped even without a runtime binding. Sessions bound to a different authority
 * or generation are also skipped. Sessions with no known harness and no binding are
 * not skipped (conservative assessment).
 */
export function restartAssessmentSkips(
  projection: Pick<SessionProjection, "resolvedHarnessId" | "harness" | "runtimeBinding">,
  fingerprint: RuntimeRestartFingerprint,
): boolean {
  const harnessId = projection.resolvedHarnessId
    ?? (projection.harness?.mode === "pinned" ? projection.harness.harnessId : undefined);
  if (harnessId && harnessId !== "opencode") {
    return true;
  }
  const binding = projection.runtimeBinding;
  if (
    binding
    && (binding.authorityId !== fingerprint.authorityId || binding.generation !== fingerprint.generation)
  ) {
    return true;
  }
  return false;
}
