import { basename, dirname, join, resolve } from "node:path";
import type { ProjectService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { CoachProfile, CoachStore } from "./index.ts";
import { createCoachStore } from "./index.ts";
import { resetCoachData } from "./maintenance.ts";
import {
  createCoachProposalReviewStore,
  type CoachProposalReviewStore,
} from "./proposals.ts";

export interface PersonalCoachService {
  forSpace(space: SpaceContext): CoachStore;
  proposalReviewForSpace(space: SpaceContext): CoachProposalReviewStore;
  forWorkspaceProject(projectId: string, expectedSpaceId?: string): Promise<CoachStore>;
  proposalReviewForWorkspaceProject(projectId: string, expectedSpaceId?: string): Promise<CoachProposalReviewStore>;
  resetForSpace(space: SpaceContext): { revision: number; resetAt: number; profile: CoachProfile };
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

export function createPersonalCoachService(input: {
  storageFor(space: SpaceContext): SpaceStorage;
  projects: ProjectService;
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

  const workspaceFile = async (projectId: string, expectedSpaceId?: string): Promise<string> => {
    if (!projectId.startsWith("__polyth_pkg_")) {
      throw Object.assign(new Error("not a package workspace"), { code: "not-found" });
    }
    const project = await input.projects.get(projectId);
    if (!project || !project.spaceId || (expectedSpaceId && project.spaceId !== expectedSpaceId)) {
      throw Object.assign(new Error("Coach workspace not found"), { code: "not-found" });
    }
    const packageDir = packageDirOfWorkspace(project.path);
    if (!packageDir) {
      throw Object.assign(new Error("project is not a Personal Coach workspace"), { code: "not-found" });
    }
    return join(packageDir, "coach.db");
  };

  const spaceFile = (space: SpaceContext): string =>
    join(input.storageFor(space).packageDir("personal-coach"), "coach.db");

  return {
    forSpace(space) {
      return open(spaceFile(space));
    },
    proposalReviewForSpace(space) {
      return review(spaceFile(space));
    },
    async forWorkspaceProject(projectId, expectedSpaceId) {
      return open(await workspaceFile(projectId, expectedSpaceId));
    },
    async proposalReviewForWorkspaceProject(projectId, expectedSpaceId) {
      return review(await workspaceFile(projectId, expectedSpaceId));
    },
    resetForSpace(space) {
      const file = spaceFile(space);
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
