import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessContext, PackageDescriptorDto, ProjectComposition } from "@polyth/contracts";
import {
  isProjectContributionRelevant,
  parseProjectAffinity,
  parseProjectComposition,
} from "@polyth/contracts/project-composition";

type CatalogRow = Pick<PackageDescriptorDto, "category" | "projectAffinity">;

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

function projectComposition(dataDir: string, projectId: string): ProjectComposition | undefined {
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

function catalogRow(dataDir: string, owner: string): CatalogRow | undefined {
  const raw = readJson(join(dataDir, "package-composition.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = (raw as Record<string, unknown>)[owner];
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

/** Project relevance for agent contributions. Global package lifecycle and
 * authorization are checked elsewhere and always win. Missing/legacy metadata
 * stays visible for backward compatibility; explicit overrides still apply to
 * unclassified or managed package owners. */
export function isAgentPackageRelevant(dataDir: string, owner: string, context: Pick<HarnessContext, "projectId">): boolean {
  if (owner === "polyth") return true;
  const composition = projectComposition(dataDir, context.projectId);
  const descriptor = catalogRow(dataDir, owner);
  return isProjectContributionRelevant(composition, {
    id: owner,
    enabled: true,
    ...(descriptor?.category ? { category: descriptor.category } : {}),
    ...(descriptor?.projectAffinity ? { projectAffinity: descriptor.projectAffinity } : {}),
  });
}
