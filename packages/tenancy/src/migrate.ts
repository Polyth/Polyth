// One-time migration from single-user Polyth to Spaces.
//
// Rules, in order of importance:
//  1. nothing on disk moves — projects keep their paths, sessions keep their
//     rows, configuration keeps its files. Only OWNERSHIP is written;
//  2. it is idempotent: a second boot finds the bootstrap user and Personal
//     Space already present and only backfills records that still lack an
//     owner (rollback = delete tenancy.json, restart, get the same result);
//  3. no wizard: existing installations come up already inside Personal.
import type { Project, SpaceDto, UserDto } from "@polyth/contracts";
import type { TenancyStore } from "./store.ts";

/** Stable id for the single pre-tenancy operator, so re-running the migration
 *  after tenancy.json is deleted re-creates the SAME owner. */
export const BOOTSTRAP_USER_ID = "usr_owner";
export const DEFAULT_SPACE_NAME = "Personal";

export interface MigrationResult {
  user: UserDto;
  space: SpaceDto;
  /** True on the boot that actually created the Space. */
  created: boolean;
  /** Projects stamped with the default space on this run. */
  projectsAdopted: number;
  /** Session projections stamped with the default space on this run. */
  sessionsAdopted: number;
}

export interface MigrationTargets {
  /** Projects without a spaceId; the callback assigns one. */
  adoptProjects(spaceId: string): Promise<number> | number;
  /** Session projections without a spaceId; the callback assigns one. */
  adoptSessions(spaceId: string): Promise<number> | number;
}

/** Ensure the bootstrap user and default Space exist, then adopt every
 *  un-owned resource into that Space. Safe to call on every boot. */
export async function migrateToSpaces(opts: {
  store: TenancyStore;
  targets: MigrationTargets;
  ownerName?: string;
  spaceName?: string;
}): Promise<MigrationResult> {
  const { store, targets } = opts;

  const user = store.user(BOOTSTRAP_USER_ID)
    ?? store.createUser(opts.ownerName?.trim() || "Owner", BOOTSTRAP_USER_ID);

  const existing = store.defaultSpaceFor(user.id);
  const created = !existing;
  const space = existing ?? store.createSpace({
    name: opts.spaceName?.trim() || DEFAULT_SPACE_NAME,
    ownerId: user.id,
    isDefault: true,
  });

  const projectsAdopted = await targets.adoptProjects(space.id);
  const sessionsAdopted = await targets.adoptSessions(space.id);

  return { user, space, created, projectsAdopted, sessionsAdopted };
}

/** Projects written before tenancy have no owner. Used by the project service
 *  and by tests that assert the migration is total. */
export const unownedProjects = (projects: readonly Project[]): Project[] =>
  projects.filter((p) => !p.spaceId);
