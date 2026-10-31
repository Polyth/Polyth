import {
  matchesProjectAffinity,
  projectKinds,
  type DefaultRail,
  type DefaultRails,
  type ProjectAffinity,
  type ProjectComposition,
} from "@polyth/contracts/project-composition";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";
import { uniquePackageLaunchers } from "./packageLaunchers.ts";

export type PackageAffinityResolver = (ownerPackageId: string) => ProjectAffinity | undefined;

/** Where a contribution shows itself: project `chrome` (rail launchers,
 *  dashboard and header widgets) or a `session` control beside the chat. */
export type ContributionPresence = "chrome" | "session";

export interface ProjectCapabilitySeedInput {
  id: string;
  ownerPackageId?: string;
  projectAffinity?: ProjectAffinity;
  defaultRails?: DefaultRails;
  standardTier: "primary" | "more" | "technical";
  standardRank: number;
  rail?: boolean;
  kind?: "destination" | "command";
  /** False when the right rail could not draw it (no right-pane destination):
   * it then waits under More instead of taking a right-rail slot. */
  rightRailDestination?: boolean;
}

export interface ProjectCapabilityPlacement {
  tier: "primary" | "more" | "technical";
  rank: number;
}

/**
 * May a package contribution place itself in a project's visible chrome (a rail
 * icon, a default-visible widget) without the user asking? Only where its
 * directions match the project: Home Assistant appears on its own in a Home
 * project, never in an Engineering one — the user can still add it anywhere.
 *
 * - Host/core navigation and explicitly included packages always may.
 * - Universal packages (no directions) may in an untyped project; in a typed
 *   project they need an explicit recommendation, matching the initial seed.
 * - Direction-scoped packages need a project direction they share, so an
 *   untyped (General/legacy) project never receives them automatically.
 * - A `session` control (a session header action or composer button such as
 *   Goal, Auto-approve or Dictation) is not project chrome: it acts on the
 *   chat itself, so a universal package keeps it in every project. Only the
 *   direction match applies to it; rails and dashboards keep their budget.
 */
export function autoPlacesContribution(
  composition: ProjectComposition | undefined,
  ownerPackageId: string | undefined,
  ownerAffinity: ProjectAffinity | undefined,
  contributionAffinity: ProjectAffinity | undefined,
  presence: ContributionPresence = "chrome",
): boolean {
  if (!ownerPackageId || ownerPackageId === "host" || ownerPackageId === "polyth") return true;
  const typed = composition?.version === 1;
  if (typed && composition.packageOverrides[ownerPackageId] === "include") return true;
  const directionScoped = (ownerAffinity?.directions?.length ?? 0) > 0
    || (contributionAffinity?.directions?.length ?? 0) > 0;
  const directions = typed ? composition.directions : [];
  if (directions.length === 0) return !directionScoped;
  if (presence === "session" && !directionScoped) return true;
  const matches = matchesProjectAffinity(composition, ownerAffinity)
    && matchesProjectAffinity(composition, contributionAffinity);
  const recommended = (contributionAffinity?.recommended ?? ownerAffinity?.recommended) === true;
  // An explicit direction match is enough to keep the package in its normal
  // place. Universal packages need an explicit recommendation to occupy the
  // visible rails of every typed project; otherwise they remain discoverable
  // under Technical instead of adding permanent chrome.
  return matches && (directionScoped || recommended);
}

/** A freshly arranged project shows at most this many launchers per rail.
 * The rest stay one click away under More. */
export const DEFAULT_TOP_RAIL_LIMIT = 5;
export const DEFAULT_RIGHT_RAIL_LIMIT = 6;

const RAIL_TIER: Record<DefaultRail, "primary" | "more"> = { top: "primary", right: "more" };
const TIER_RAIL: Partial<Record<ProjectCapabilitySeedInput["standardTier"], DefaultRail>> = {
  primary: "top",
  more: "right",
};

/** What else a rail plan needs to know about the project. */
export interface RailPlanOptions {
  /** The person's Personal project (`Project.personal`): planned as the
   * `personal` kind, whatever its composition says. */
  personal?: boolean;
}

/**
 * The rail one capability starts on in a project, before rail limits apply,
 * or null for More.
 *
 * - A package that declares `defaultRails` chooses per project kind (each
 *   direction, or `general`); several directions take the most prominent
 *   rail any of them asks for.
 * - A Personal project keeps its rails to the launchers that ask for the
 *   `personal` kind: it is the first screen of someone who has not set up a
 *   project, so nothing else places itself there.
 * - Without `defaultRails` the standard tier applies wherever the package may
 *   place itself (`autoPlacesContribution`).
 * - An explicitly included package always gets a visible rail.
 */
export function defaultRailFor(
  composition: ProjectComposition | undefined,
  capability: ProjectCapabilitySeedInput,
  packageAffinity: PackageAffinityResolver = () => undefined,
  options: RailPlanOptions = {},
): DefaultRail | null {
  if (capability.rail === false) return null;
  if (options.personal) return capability.defaultRails?.personal ?? null;
  const owner = capability.ownerPackageId;
  const included = owner !== undefined && composition?.version === 1
    && composition.packageOverrides[owner] === "include";
  const standard = TIER_RAIL[capability.standardTier] ?? null;
  if (capability.defaultRails) {
    let chosen: DefaultRail | null = null;
    for (const kind of projectKinds(composition)) {
      const rail = capability.defaultRails[kind];
      if (rail === "top") return "top";
      if (rail === "right") chosen = "right";
    }
    return chosen ?? (included && capability.kind !== "command" ? standard ?? "right" : null);
  }
  if (standard === null) return included && capability.kind !== "command" ? "right" : null;
  const ownerAffinity = owner ? packageAffinity(owner) : undefined;
  return autoPlacesContribution(composition, owner, ownerAffinity, capability.projectAffinity) ? standard : null;
}

/**
 * The complete starting navigation of a project: every capability gets an
 * explicit placement so nothing falls back to an implicit default later.
 * Each rail holds at most one launcher per package; the top rail keeps its
 * `DEFAULT_TOP_RAIL_LIMIT` best-ranked launchers and moves the rest to the
 * right rail, which keeps `DEFAULT_RIGHT_RAIL_LIMIT`. Everything else starts
 * under More (Technical) — placed, never made unavailable.
 */
export function defaultCapabilityPlacements(
  composition: ProjectComposition | undefined,
  capabilities: readonly ProjectCapabilitySeedInput[],
  packageAffinity: PackageAffinityResolver = () => undefined,
  options: RailPlanOptions = {},
): Record<string, ProjectCapabilityPlacement> {
  const placements: Record<string, ProjectCapabilityPlacement> = {};
  const technical = (entry: ProjectCapabilitySeedInput): void => {
    placements[entry.id] = { tier: "technical", rank: entry.standardRank };
  };
  const byRank = (a: ProjectCapabilitySeedInput, b: ProjectCapabilitySeedInput): number =>
    a.standardRank - b.standardRank || a.id.localeCompare(b.id);
  const top: ProjectCapabilitySeedInput[] = [];
  const right: ProjectCapabilitySeedInput[] = [];
  for (const capability of capabilities) {
    const rail = defaultRailFor(composition, capability, packageAffinity, options);
    if (rail === "top") top.push(capability);
    else if (rail === "right") right.push(capability);
    else technical(capability);
  }
  const keepTop = uniquePackageLaunchers(top.toSorted(byRank), (entry) => entry);
  for (const entry of top) if (!keepTop.includes(entry)) technical(entry);
  keepTop.slice(DEFAULT_TOP_RAIL_LIMIT).forEach((entry) => right.push(entry));
  keepTop.slice(0, DEFAULT_TOP_RAIL_LIMIT).forEach((entry) => {
    placements[entry.id] = { tier: RAIL_TIER.top, rank: entry.standardRank };
  });
  const drawable = right.filter((entry) => entry.rightRailDestination !== false);
  for (const entry of right) if (!drawable.includes(entry)) technical(entry);
  const keepRight = uniquePackageLaunchers(drawable.toSorted(byRank), (entry) => entry)
    .slice(0, DEFAULT_RIGHT_RAIL_LIMIT);
  for (const entry of drawable) {
    if (keepRight.includes(entry)) placements[entry.id] = { tier: RAIL_TIER.right, rank: entry.standardRank };
    else technical(entry);
  }
  return placements;
}

/** Pure, deterministic initial-profile planner. Explicit profile affinity wins;
 * otherwise a profile may inherit its owning package's discovery affinity.
 * No profile or package ids are hardcoded here. */
export function selectInitialWorkbenchProfile(
  composition: ProjectComposition,
  profiles: readonly WorkbenchProfileDefinition[],
  packageAffinity: PackageAffinityResolver = () => undefined,
): string | null {
  if (composition.directions.length === 0) return null;
  const selected = new Set(composition.directions);
  return profiles
    .filter((profile) => profile.id !== "conversation")
    .map((profile) => ({
      profile,
      affinity: profile.projectAffinity
        ?? (profile.ownerPackageId ? packageAffinity(profile.ownerPackageId) : undefined),
    }))
    .filter(({ affinity }) => affinity?.recommended === true)
    .filter(({ affinity }) => matchesProjectAffinity(composition, affinity))
    .map(({ profile, affinity }) => ({
      profile,
      overlap: affinity?.directions?.filter((direction) => selected.has(direction)).length ?? 0,
    }))
    .sort((left, right) => right.overlap - left.overlap
      || left.profile.order - right.profile.order
      || left.profile.id.localeCompare(right.profile.id))[0]?.profile.id ?? null;
}

export interface ProjectSetupRecovery {
  canExit: boolean;
  canRetry: boolean;
  exitKind: "open-anyway" | "close" | null;
}

/** Recovery after a source mutation/finalization failure.
 *
 * - A known project with composition not yet durable must stay in Retry so the
 *   flow cannot silently abandon a half-configured project and create another.
 * - Once composition is durable, opening anyway is safe if workspace seeding
 *   fails.
 * - If the source reported success but the shell cannot resolve a project id,
 *   there is no safe retry target; Close is the only non-dead-end action and a
 *   later registry refresh can reveal the already-created project. */
export function projectSetupRecovery(
  compositionPersisted: boolean,
  projectKnown: boolean,
): ProjectSetupRecovery {
  if (compositionPersisted) return { canExit: true, canRetry: projectKnown, exitKind: "open-anyway" };
  if (!projectKnown) return { canExit: true, canRetry: false, exitKind: "close" };
  return { canExit: false, canRetry: true, exitKind: null };
}
