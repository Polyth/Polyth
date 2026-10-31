import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { PeopleHost } from "@polyth/plugins";
import type { CoachProfile, CoachStore } from "./index.ts";
import { createCoachStore } from "./index.ts";
import { resetCoachData } from "./maintenance.ts";
import {
  createCoachProposalReviewStore,
  type CoachProposalReviewStore,
} from "./proposals.ts";

/** The slice of a Space context that names a person: routes pass `rc.space`,
 * agent tools pass `host.personSpaceContext(actorUserId, spaceId)`. */
export type CoachPerson = Pick<SpaceContext, "spaceId" | "userId" | "role">;

/**
 * Coach data (health notes, check-ins, diary) belongs to ONE person in ONE
 * Space (Spaces §14.6): `people/<userId>/packages/personal-coach/spaces/<spaceId>/coach.db`.
 * The Space-level `coach.db` of earlier versions is moved, once, to the first
 * request made by a member whose role is `owner`; other members start empty.
 */
export interface PersonalCoachService {
  forSpace(person: CoachPerson): CoachStore;
  proposalReviewForSpace(person: CoachPerson): CoachProposalReviewStore;
  /** Validate that `projectId` is this package's workspace in the person's Space. */
  workspaceProject(projectId: string, expectedSpaceId?: string): Promise<void>;
  resetForSpace(person: CoachPerson): { revision: number; resetAt: number; profile: CoachProfile };
  close(): void;
}

const packageDirOfWorkspace = (path: string): string | undefined => {
  const workspace = resolve(path);
  const packageDir = dirname(workspace);
  const packagesDir = dirname(packageDir);
  if (
    basename(workspace) !== "workspace"
    || basename(packageDir) !== "personal-coach"
    || basename(packagesDir) !== "packages"
  ) return undefined;
  return packageDir;
};

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const SPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

/** True for a signed-in person; false for `system:*` principals and system authority. */
export const isCoachPerson = (space: Pick<SpaceContext, "userId">): boolean =>
  typeof space.userId === "string"
  && space.userId.length > 0
  && !space.userId.startsWith("system:")
  && (space as { authority?: { kind?: unknown } }).authority?.kind !== "system";

const SQLITE_SIDECARS = ["", "-wal", "-shm"] as const;

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "EXDEV") throw cause;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

export function createPersonalCoachService(input: {
  storageFor(space: SpaceContext): SpaceStorage;
  projects: ProjectService;
  /** Read lazily: the host may provide person storage only after registration. */
  people(): PeopleHost | undefined;
}): PersonalCoachService {
  const stores = new Map<string, CoachStore>();
  const reviews = new Map<string, CoachProposalReviewStore>();

  const open = (file: string): CoachStore => {
    const key = resolve(file);
    let store = stores.get(key);
    if (!store) {
      store = createCoachStore(key);
      stores.set(key, store);
    }
    return store;
  };

  const review = (file: string): CoachProposalReviewStore => {
    const key = resolve(file);
    open(key); // base Coach schema must exist before the additive review tables.
    let store = reviews.get(key);
    if (!store) {
      store = createCoachProposalReviewStore(key);
      reviews.set(key, store);
    }
    return store;
  };

  // Moves the pre-person Space database to the Space owner. Never overwrites a
  // database the owner already has, and never touches it for anyone else.
  const adoptLegacy = (person: CoachPerson, target: string): void => {
    if (person.role !== "owner" || existsSync(target)) return;
    const legacy = join(
      input.storageFor(person as SpaceContext).packageDir("personal-coach"),
      "coach.db",
    );
    if (!existsSync(legacy)) return;
    // A cached handle would keep writing to the moved inode.
    const legacyKey = resolve(legacy);
    reviews.get(legacyKey)?.close();
    reviews.delete(legacyKey);
    stores.get(legacyKey)?.close();
    stores.delete(legacyKey);
    mkdirSync(dirname(target), { recursive: true });
    // Sidecars first, database last: the target appears only when complete.
    for (const suffix of SQLITE_SIDECARS.toReversed()) {
      if (existsSync(legacy + suffix)) moveFile(legacy + suffix, target + suffix);
    }
  };

  const personFile = (person: CoachPerson): string => {
    if (!isCoachPerson(person)) {
      throw fail("forbidden", "Personal Coach data belongs to a signed-in person; system work cannot use it");
    }
    if (!SPACE_SEGMENT.test(person.spaceId)) throw fail("invalid-input", "invalid Space id");
    const people = input.people();
    if (!people) throw fail("unavailable", "Personal Coach needs person-owned storage, which this host does not provide");
    const storage = people.storage(person.userId, "personal-coach");
    const file = storage.path(join("spaces", person.spaceId, "coach.db"));
    adoptLegacy(person, file);
    return file;
  };

  const workspaceProject = async (projectId: string, expectedSpaceId?: string): Promise<void> => {
    if (!projectId.startsWith("__polyth_pkg_")) throw fail("not-found", "not a package workspace");
    const project = await input.projects.get(projectId);
    if (!project || !project.spaceId || (expectedSpaceId && project.spaceId !== expectedSpaceId)) {
      throw fail("not-found", "Coach workspace not found");
    }
    if (!packageDirOfWorkspace(project.path)) {
      throw fail("not-found", "project is not a Personal Coach workspace");
    }
  };

  return {
    forSpace(person) {
      const file = personFile(person);
      // The proposal tables must exist before the first proposal card renders.
      review(file);
      return open(file);
    },
    proposalReviewForSpace(person) {
      return review(personFile(person));
    },
    workspaceProject,
    resetForSpace(person) {
      const file = personFile(person);
      const store = open(file);
      review(file); // ensure optional plan tables exist before the reset walk.
      const result = resetCoachData(file);
      return { ...result, profile: store.profile() };
    },
    close() {
      for (const store of reviews.values()) store.close();
      reviews.clear();
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}
