import type { PackageDescriptorDto } from "@polyth/contracts";
import {
  isProjectContributionRelevant as contractContributionRelevant,
  type ProjectAffinity,
  type ProjectComposition,
} from "@polyth/contracts/project-composition";
import { autoPlacesContribution, type ContributionPresence } from "../projectCompositionPlan.ts";
import { isSharedProjectInterface, subscribeProjectInterfaceMode } from "../projectInterfaceScope.ts";

const catalog = new Map<string, PackageDescriptorDto>();
const listeners = new Set<() => void>();
let activeProjectId: string | null = null;
let projectComposition: ProjectComposition | undefined;
/** The active project is its owner's Personal project (`Project.personal`). */
let personalProject = false;
/** A shared interface is the same in every project, so no project's directions
 * or per-package choices may shape it: every project then reads as General. */
const SHARED_INTERFACE_COMPOSITION: ProjectComposition = Object.freeze({
  version: 1,
  directions: [],
  packageOverrides: {},
}) as ProjectComposition;
const effectiveComposition = (): ProjectComposition | undefined =>
  isSharedProjectInterface() ? SHARED_INTERFACE_COMPOSITION : projectComposition;
let version = 0;
let catalogSignature = "";
let catalogLoaded = false;
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
  setCatalog(items, true);
}

function setCatalog(items: readonly PackageDescriptorDto[], complete: boolean): void {
  const nextSignature = packageSignature(items);
  const loaded = catalogLoaded || complete;
  if (nextSignature === catalogSignature && loaded === catalogLoaded) return;
  catalogLoaded = loaded;
  catalog.clear();
  for (const item of items) catalog.set(item.id, item);
  catalogSignature = nextSignature;
  notify();
}

export function updateProjectPackageDescriptor(item: PackageDescriptorDto): void {
  const next = [...catalog.values()].filter((candidate) => candidate.id !== item.id);
  next.push(item);
  setCatalog(next, false);
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
  options: { personal?: boolean } = {},
): void {
  const personal = options.personal === true;
  const nextSignature = JSON.stringify([projectId, nextComposition ?? null, personal]);
  if (nextSignature === contextSignature) return;
  activeProjectId = projectId;
  projectComposition = nextComposition === undefined ? undefined : structuredClone(nextComposition);
  personalProject = personal;
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
  return contractContributionRelevant(effectiveComposition(), {
    id: pkg.id,
    enabled: pkg.enabled,
    category: pkg.category,
    projectAffinity: pkg.projectAffinity,
  }, contributionAffinity);
}

/** Whether a contribution may place itself in `projectId`'s visible chrome
 * without the user asking (see `autoPlacesContribution`). `null` while that
 * project's composition or the package catalog is not known yet: callers must
 * defer the decision instead of guessing, since a guess is persisted. */
export function projectContributionAutoPlacement(
  projectId: string | null,
  ownerPackageId?: string,
  contributionAffinity?: ProjectAffinity,
  presence: ContributionPresence = "chrome",
): boolean | null {
  if (!ownerPackageId || ownerPackageId === "host" || ownerPackageId === "polyth") return true;
  if (projectId === null || projectId !== activeProjectId || !catalogLoaded) return null;
  const pkg = catalog.get(ownerPackageId);
  // Unknown owners stay visible for legacy/external extension compatibility.
  if (!pkg) return true;
  return autoPlacesContribution(effectiveComposition(), pkg.id, pkg.projectAffinity, contributionAffinity, presence);
}

export interface RailPlanContext {
  composition: ProjectComposition | undefined;
  /** Plan as the `personal` project kind (see `projectKinds`). */
  personal: boolean;
}

/** The composition `projectId`'s default navigation is planned from, or
 * `null` while that project's composition or the package catalog is not
 * known yet (a plan made from a guess would be persisted). `composition` is
 * undefined for a legacy project without one. */
export function projectRailPlanContext(projectId: string | null): RailPlanContext | null {
  if (projectId === null || projectId !== activeProjectId || !catalogLoaded) return null;
  const composition = effectiveComposition();
  return {
    composition: composition === undefined ? undefined : structuredClone(composition),
    // A shared interface is one arrangement for every project: the Personal
    // project then reads as General like the rest.
    personal: personalProject && !isSharedProjectInterface(),
  };
}

export function currentProjectComposition(): ProjectComposition | undefined {
  const composition = effectiveComposition();
  return composition === undefined ? undefined : structuredClone(composition);
}

export function currentCompositionProjectId(): string | null {
  return activeProjectId;
}

subscribeProjectInterfaceMode(notify);

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
  projectComposition = undefined;
  personalProject = false;
  catalogSignature = "";
  catalogLoaded = false;
  contextSignature = "";
  notify();
}
