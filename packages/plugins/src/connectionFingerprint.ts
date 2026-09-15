import { createHash } from "node:crypto";
import type { PackageConnectionReviewDto, PackageConnectionSecurityDto } from "@polyth/contracts";
import type { PackageConnectionContribution } from "@polyth/package-sdk/manifest";

export function connectionFingerprint(spec: PackageConnectionContribution): string {
  return createHash("sha256").update(JSON.stringify(connectionSecurityView(spec))).digest("hex");
}

export function fingerprintsOf(
  specs: readonly PackageConnectionContribution[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.id] = connectionFingerprint(spec);
  return out;
}

export function fingerprintsStale(
  approved: Record<string, string> | undefined,
  specs: readonly PackageConnectionContribution[],
): boolean {
  if (specs.length === 0) return false;
  if (!approved) return true;
  for (const spec of specs) {
    if (approved[spec.id] !== connectionFingerprint(spec)) return true;
  }
  return false;
}

export function connectionSecurityView(spec: PackageConnectionContribution): PackageConnectionSecurityDto {
  const oauth = spec.kind === "oauth" ? spec.oauth : undefined;
  return {
    kind: spec.kind,
    origins: [...(spec.origins ?? [])].sort(),
    ...(oauth?.authorizeUrl ? { authorizeUrl: oauth.authorizeUrl } : {}),
    ...(oauth?.tokenUrl ? { tokenUrl: oauth.tokenUrl } : {}),
    ...(oauth?.clientId ? { clientId: oauth.clientId } : {}),
    ...(oauth?.scopes?.length ? { scopes: [...oauth.scopes].sort() } : {}),
  };
}

/** Browser-safe review rows. Approved unchanged connections are omitted.
 * A target id absent from the active manifest is always new, even if stale
 * approval bytes for that id somehow survived an older version. */
export function connectionReviewItems(
  active: readonly PackageConnectionContribution[],
  target: readonly PackageConnectionContribution[],
  approved: Record<string, string>,
): PackageConnectionReviewDto[] {
  const byId = new Map(active.map((spec) => [spec.id, spec]));
  const out: PackageConnectionReviewDto[] = [];
  for (const spec of target) {
    const previous = byId.get(spec.id);
    if (previous && approved[spec.id] === connectionFingerprint(spec)) continue;
    out.push({
      id: spec.id,
      label: spec.label,
      kind: previous ? "changed" : "new",
      ...(previous ? { current: connectionSecurityView(previous) } : {}),
      next: connectionSecurityView(spec),
    });
  }
  return out;
}
