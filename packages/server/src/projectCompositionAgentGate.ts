import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessContext, PackageDescriptorDto, ProjectComposition } from "@polyth/contracts";
import {
  isProjectContributionRelevant,
  parseProjectAffinity,
  parseProjectComposition,
} from "@polyth/contracts/project-composition";

type CatalogRow = Pick<PackageDescriptorDto, "category" | "projectAffinity">;
type ProjectContext = Pick<HarnessContext, "projectId">;

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

type CompositionRow = { internal: unknown; composition: unknown };
type CompositionLookup = { stamp: string; rows: Map<string, CompositionRow> };

/** One parsed lookup per data dir, valid while the file's identity is
 *  unchanged (ino, size, mtime and ctime in ns). Only id -> row is kept, not
 *  the whole registry. Any stat or parse failure caches nothing. */
const lookups = new Map<string, CompositionLookup>();

function compositionLookup(dataDir: string): Map<string, CompositionRow> | undefined {
  const path = join(dataDir, "projects.json");
  let stamp: string;
  try {
    const st = statSync(path, { bigint: true });
    stamp = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch { return undefined; }
  const hit = lookups.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.rows;
  const raw = readJson(path);
  if (!Array.isArray(raw)) return undefined;
  const rows = new Map<string, CompositionRow>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { id, internal, composition } = row as { id?: unknown; internal?: unknown; composition?: unknown };
    if (typeof id === "string" && !rows.has(id)) rows.set(id, { internal, composition });
  }
  lookups.set(dataDir, { stamp, rows });
  return rows;
}

function readProjectComposition(dataDir: string, projectId: string): ProjectComposition | undefined {
  const project = compositionLookup(dataDir)?.get(projectId);
  // Package workspaces and malformed/legacy rows are intentionally general:
  // relevance is presentation, never an authorization boundary.
  if (!project || project.internal !== undefined || project.composition === undefined) return undefined;
  try { return parseProjectComposition(project.composition); } catch { return undefined; }
}

function parseCatalogRow(row: unknown): CatalogRow | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const candidate = row as { category?: unknown; projectAffinity?: unknown };
  let projectAffinity: CatalogRow["projectAffinity"];
  if (candidate.projectAffinity !== undefined) {
    try { projectAffinity = parseProjectAffinity(candidate.projectAffinity); } catch { return undefined; }
  }
  const category = typeof candidate.category === "string"
    ? candidate.category as CatalogRow["category"]
    : undefined;
  return { ...(category ? { category } : {}), ...(projectAffinity ? { projectAffinity } : {}) };
}

/** Create one relevance gate for a provisioning controller.
 *
 * Capability resolution asks about many owners synchronously for the same
 * HarnessContext. Cache only for that JavaScript turn: one projects.json read
 * serves the complete batch, then the cache is cleared before later settings
 * writes/turns can observe stale composition. Package affinity metadata is
 * immutable for the lifetime of this boot, so its validated catalog is reused. */
export function createAgentPackageRelevanceGate(dataDir: string) {
  let catalog: Record<string, unknown> | undefined;
  let cachedContext: ProjectContext | undefined;
  let cachedComposition: ProjectComposition | undefined;
  let cacheToken = 0;

  const catalogRow = (owner: string): CatalogRow | undefined => {
    if (!catalog) {
      const raw = readJson(join(dataDir, "package-composition.json"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) catalog = raw as Record<string, unknown>;
    }
    return parseCatalogRow(catalog?.[owner]);
  };

  const compositionFor = (context: ProjectContext): ProjectComposition | undefined => {
    if (cachedContext === context) return cachedComposition;
    cachedContext = context;
    cachedComposition = readProjectComposition(dataDir, context.projectId);
    const token = ++cacheToken;
    queueMicrotask(() => {
      if (cacheToken !== token) return;
      cachedContext = undefined;
      cachedComposition = undefined;
    });
    return cachedComposition;
  };

  return (owner: string, context: ProjectContext): boolean => {
    if (owner === "polyth") return true;
    const composition = compositionFor(context);
    const descriptor = catalogRow(owner);
    return isProjectContributionRelevant(composition, {
      id: owner,
      enabled: true,
      ...(descriptor?.category ? { category: descriptor.category } : {}),
      ...(descriptor?.projectAffinity ? { projectAffinity: descriptor.projectAffinity } : {}),
    });
  };
}

/** One-shot compatibility helper used by focused tests and narrow callers. */
export function isAgentPackageRelevant(dataDir: string, owner: string, context: ProjectContext): boolean {
  return createAgentPackageRelevanceGate(dataDir)(owner, context);
}
