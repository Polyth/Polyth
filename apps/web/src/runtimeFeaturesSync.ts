import type { SessionProjection } from "@polyth/contracts";

const sameContextWindow = (
  left: SessionProjection["contextWindow"],
  right: SessionProjection["contextWindow"],
): boolean => left?.source === right?.source
  && left?.updatedAt === right?.updatedAt
  && left?.usedTokens === right?.usedTokens
  && left?.limitTokens === right?.limitTokens
  && left?.remainingTokens === right?.remainingTokens
  && left?.fraction === right?.fraction
  && left?.harnessId === right?.harnessId
  && left?.generation === right?.generation
  && left?.compaction?.active === right?.compaction?.active
  && left?.compaction?.lastAt === right?.compaction?.lastAt;

/** True when a loaded runtime-features payload should be refreshed after a
 *  projection update (commands, live context telemetry, or harness binding). */
export function shouldRefreshRuntimeFeatures(
  prev: SessionProjection | undefined,
  next: SessionProjection,
  hasLoadedFeatures: boolean,
): boolean {
  if (!hasLoadedFeatures) return false;
  if ((prev?.nativeCommandsRevision ?? 0) !== (next.nativeCommandsRevision ?? 0)) return true;
  if (!sameContextWindow(prev?.contextWindow, next.contextWindow)) return true;
  if (prev?.resolvedHarnessId !== next.resolvedHarnessId) return true;
  if ((prev?.runtimeBinding?.generation ?? 0) !== (next.runtimeBinding?.generation ?? 0)) return true;
  return false;
}
