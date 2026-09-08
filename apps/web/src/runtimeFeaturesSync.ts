import type { SessionProjection } from "@polyth/contracts";

/** True when a loaded runtime-features payload should be refreshed after a
 *  projection update (native command catalog revision or harness binding). */
export function shouldRefreshRuntimeFeatures(
  prev: SessionProjection | undefined,
  next: SessionProjection,
  hasLoadedFeatures: boolean,
): boolean {
  if (!hasLoadedFeatures) return false;
  if ((prev?.nativeCommandsRevision ?? 0) !== (next.nativeCommandsRevision ?? 0)) return true;
  if (prev?.resolvedHarnessId !== next.resolvedHarnessId) return true;
  if ((prev?.runtimeBinding?.generation ?? 0) !== (next.runtimeBinding?.generation ?? 0)) return true;
  return false;
}
