import { resolve } from "node:path";
import type { ProjectService, SessionService } from "@polyth/contracts";
import {
  isTemporaryWorktreeBranch,
  semanticWorktreeBranch,
} from "@polyth/session/worktree-names";
import type { GitService } from "./index.ts";

export interface TemporaryWorktreeBranchService {
  renameForSessionTitle(sessionId: string, title: string): Promise<string | null>;
}

export function createTemporaryWorktreeBranchService(deps: {
  git: GitService;
  projects: ProjectService;
  sessions: SessionService;
  worktreesChanged?: (projectId: string) => void;
}): TemporaryWorktreeBranchService {
  return {
    async renameForSessionTitle(sessionId, title) {
      const session = await deps.sessions.snapshot(sessionId);
      if (session.isolation || !session.worktreePath || !isTemporaryWorktreeBranch(session.branch)) return null;
      if (!deps.sessions.renameWorktreeBranch) return null;
      const project = await deps.projects.get(session.projectId);
      if (!project) return null;
      const worktrees = await deps.git.worktrees.list(project.path);
      const checkout = worktrees.find((item) =>
        resolve(item.path) === resolve(session.worktreePath!) && item.branch === session.branch);
      if (!checkout) return null;
      const branches = await deps.git.branches(project.path);
      const taken = [
        ...branches.branches.map((item) => item.name),
        ...worktrees.map((item) => item.branch).filter((item): item is string => !!item),
      ];
      const next = semanticWorktreeBranch(title, taken);
      await deps.git.renameBranch(checkout.path, session.branch, next);
      try {
        await deps.sessions.renameWorktreeBranch(sessionId, {
          worktreePath: checkout.path,
          from: session.branch,
          to: next,
        });
      } catch (error) {
        await deps.git.renameBranch(checkout.path, next, session.branch).catch(() => undefined);
        throw error;
      }
      deps.worktreesChanged?.(session.projectId);
      return next;
    },
  };
}
