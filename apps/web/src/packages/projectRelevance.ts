import type { PackageDescriptorDto } from "@polyth/contracts";
import {
  isProjectContributionRelevant as contractContributionRelevant,
  type ProjectAffinity,
  type ProjectComposition,
} from "@polyth/contracts/project-composition";

const catalog = new Map<string, PackageDescriptorDto>();
const listeners = new Set<() => void>();
let activeProjectId: string | null = null;
let composition: ProjectComposition | undefined;
let version = 0;
let catalogSignature = "";
let contextSignature = "";

const notify = (): void => {
  version++;
  for (const listener of [...listeners]) listener();
};

const packageSignature = (items: readonly PackageDescriptorDto[]): string => JSON.stringify(
  [...items]
    .map((item) => [item.id, item.enabled, item.category ?? null, item.projectAffinity ?? null])
    .sort(([a], [b]) => String(a).localeCompare(String(b))),
);

export function replaceProjectPackageCatalog(items: readonly PackageDescriptorDto[]): void {
  const nextSignature = packageSignature(items);
  if (nextSignature === catalogSignature) return;
  catalog.clear();
  for (const item of items) catalog.set(item.id, item);
  catalogSignature = nextSignature;
  notify();
}

export function updateProjectPackageDescriptor(item: PackageDescriptorDto): void {
  const next = [...catalog.values()].filter((candidate) => candidate.id !== item.id);
  next.push(item);
  replaceProjectPackageCatalog(next);
}

/** Read-only discovery metadata for consumers that need package defaults rather
 * than relevance itself (for example one-time workbench recommendation seeding).
 * Return a detached value so consumers cannot mutate the canonical catalog. */
export function projectPackageAffinity(ownerPackageId: string): ProjectAffinity | undefined {
  const affinity = catalog.get(ownerPackageId)?.projectAffinity;
  return affinity === undefined ? undefined : structuredClone(affinity);
}

export function setProjectCompositionContext(
  projectId: string | null,
  nextComposition: ProjectComposition | undefined,
): void {
  const nextSignature = JSON.stringify([projectId, nextComposition ?? null]);
  if (nextSignature === contextSignature) return;
  activeProjectId = projectId;
  composition = nextComposition === undefined ? undefined : structuredClone(nextComposition);
  contextSignature = nextSignature;
  notify();
}

/** Project relevance is a presentation/discovery decision only. This function
 * never activates a package and never grants authority. Unknown package owners
 * remain visible for legacy/external extension compatibility. */
export function isProjectContributionRelevant(
  ownerPackageId?: string,
  contributionAffinity?: ProjectAffinity,
): boolean {
  if (!ownerPackageId || ownerPackageId === "host" || ownerPackageId === "polyth") return true;
  const pkg = catalog.get(ownerPackageId);
  if (!pkg) return true;
  return contractContributionRelevant(composition, {
    id: pkg.id,
    enabled: pkg.enabled,
    category: pkg.category,
    projectAffinity: pkg.projectAffinity,
  }, contributionAffinity);
}

export function currentProjectComposition(): ProjectComposition | undefined {
  return composition === undefined ? undefined : structuredClone(composition);
}

export function currentCompositionProjectId(): string | null {
  return activeProjectId;
}

export function projectRelevanceVersion(): number {
  return version;
}

export function subscribeProjectRelevance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam only; production ownership remains in package sync + active project state. */
export function resetProjectRelevanceForTest(): void {
  catalog.clear();
  activeProjectId = null;
  composition = undefined;
  catalogSignature = "";
  contextSignature = "";
  notify();
}
