import { readFileSync } from "node:fs";
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

function readProjectComposition(dataDir: string, projectId: string): ProjectComposition | undefined {
  const raw = readJson(join(dataDir, "projects.json"));
  if (!Array.isArray(raw)) return undefined;
  const project = raw.find((row) => row && typeof row === "object" && (row as { id?: unknown }).id === projectId) as
    | { composition?: unknown; internal?: unknown }
    | undefined;
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
