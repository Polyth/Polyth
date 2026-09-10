import { basename, dirname, join, resolve } from "node:path";
import type { ProjectService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { CoachStore } from "./index.ts";
import { createCoachStore } from "./index.ts";

export interface PersonalCoachService {
  forSpace(space: SpaceContext): CoachStore;
  forWorkspaceProject(projectId: string, expectedSpaceId?: string): Promise<CoachStore>;
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

  const open = (file: string): CoachStore => {
    const key = resolve(file);
    let store = stores.get(key);
    if (!store) {
      store = createCoachStore(key);
      stores.set(key, store);
    }
    return store;
  };

  return {
    forSpace(space) {
      return open(join(input.storageFor(space).packageDir("personal-coach"), "coach.db"));
    },
    async forWorkspaceProject(projectId, expectedSpaceId) {
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
      return open(join(packageDir, "coach.db"));
    },
    close() {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}
