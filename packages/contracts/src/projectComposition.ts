/** Project-specific discovery preferences. This module is browser-safe and pure.
 * Package enablement and authorization are independent, stronger boundaries. */
export const PROJECT_DIRECTIONS = [
  "engineering", "research", "wellbeing", "finance", "home", "operations",
] as const;
export type ProjectDirection = typeof PROJECT_DIRECTIONS[number];
export const PACKAGE_CATEGORIES = ["workspace", ...PROJECT_DIRECTIONS, "system"] as const;
export type PackageCategory = typeof PACKAGE_CATEGORIES[number];
export interface ProjectAffinity {
  /** Empty/absent directions apply to every project. */
  directions?: readonly ProjectDirection[];
  recommended?: boolean;
}
export interface ProjectComposition {
  version: 1;
  /** Multiple directions are a union, not competing project types. */
  directions: ProjectDirection[];
  /** Unknown package IDs are retained so uninstall/reinstall preserves intent. */
  packageOverrides: Record<string, "include" | "exclude">;
}
export interface CompositionPackage {
  id: string;
  enabled: boolean;
  category?: PackageCategory;
  projectAffinity?: ProjectAffinity;
}
export type ProjectRelevanceReason =
  | "disabled" | "excluded" | "included" | "legacy" | "general" | "universal" | "direction" | "unrelated";
export interface ProjectPackageDecision {
  id: string;
  relevant: boolean;
  recommended: boolean;
  reason: ProjectRelevanceReason;
}

const own = (object: object, key: PropertyKey): boolean => Object.hasOwn(object, key);
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid-input" });
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains an unknown field`);
}
function directions(value: unknown, label: string): ProjectDirection[] {
  if (!Array.isArray(value) || value.length > PROJECT_DIRECTIONS.length) invalid(`${label} must be a direction list`);
  for (const direction of value) {
    if (typeof direction !== "string" || !(PROJECT_DIRECTIONS as readonly string[]).includes(direction)) {
      invalid(`${label} contains an unknown direction`);
    }
  }
  // Canonical ordering makes the result independent of selection/registration order.
  return PROJECT_DIRECTIONS.filter((direction) => value.includes(direction));
}
export function parseProjectAffinity(value: unknown): ProjectAffinity {
  const input = record(value, "projectAffinity");
  keys(input, ["directions", "recommended"], "projectAffinity");
  if (own(input, "recommended") && typeof input.recommended !== "boolean") invalid("projectAffinity.recommended must be boolean");
  return {
    ...(own(input, "directions") ? { directions: directions(input.directions, "projectAffinity.directions") } : {}),
    ...(own(input, "recommended") ? { recommended: input.recommended as boolean } : {}),
  };
}
export function parseProjectComposition(value: unknown): ProjectComposition {
  const input = record(value, "composition");
  keys(input, ["version", "directions", "packageOverrides"], "composition");
  if (input.version !== 1) invalid("unsupported project composition version");
  const selected = directions(input.directions, "composition.directions");
  const overrides = input.packageOverrides === undefined ? {} : record(input.packageOverrides, "composition.packageOverrides");
  if (Object.keys(overrides).length > 512) invalid("too many project package overrides");
  const entries = Object.entries(overrides).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [id, preference] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || ["__proto__", "prototype", "constructor"].includes(id)) {
      invalid("invalid project package id");
    }
    if (preference !== "include" && preference !== "exclude") invalid("project package override must be include or exclude");
  }
  return { version: 1, directions: selected, packageOverrides: Object.fromEntries(entries) as ProjectComposition["packageOverrides"] };
}

export function matchesProjectAffinity(composition: ProjectComposition | undefined, affinity?: ProjectAffinity): boolean {
  return !composition || composition.version !== 1 || !composition.directions.length
    || !affinity?.directions?.length
    || affinity.directions.some((direction) => composition.directions.includes(direction));
}
export function projectPackageDecision(composition: ProjectComposition | undefined, pkg: CompositionPackage): ProjectPackageDecision {
  let reason: ProjectRelevanceReason;
  const preference = composition?.version === 1 && own(composition.packageOverrides, pkg.id)
    ? composition.packageOverrides[pkg.id] : undefined;
  if (!pkg.enabled) reason = "disabled";
  else if (preference === "exclude") reason = "excluded";
  else if (preference === "include") reason = "included";
  else if (!composition || composition.version !== 1) reason = "legacy";
  else if (!composition.directions.length) reason = "general";
  else if (!pkg.projectAffinity?.directions?.length) reason = "universal";
  else reason = matchesProjectAffinity(composition, pkg.projectAffinity) ? "direction" : "unrelated";
  const relevant = !["disabled", "excluded", "unrelated"].includes(reason);
  const inferredRecommendation = reason === "direction" || reason === "universal";
  return {
    id: pkg.id,
    relevant,
    recommended: inferredRecommendation && pkg.projectAffinity?.recommended === true,
    reason,
  };
}
/** A contribution cannot reopen an irrelevant/disabled owner. Explicit inclusion
 * intentionally exposes the owner's tools even outside their recommended use. */
export function isProjectContributionRelevant(
  composition: ProjectComposition | undefined, pkg: CompositionPackage, affinity?: ProjectAffinity,
): boolean {
  const decision = projectPackageDecision(composition, pkg);
  return decision.relevant && (decision.reason === "included" || matchesProjectAffinity(composition, affinity));
}
export function resolveProjectComposition(composition: ProjectComposition | undefined, packages: readonly CompositionPackage[]) {
  const decisions = packages.map((pkg) => projectPackageDecision(composition, pkg))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    decisions,
    relevantPackageIds: decisions.filter((item) => item.relevant).map((item) => item.id),
    recommendedPackageIds: decisions.filter((item) => item.recommended).map((item) => item.id),
  };
}
