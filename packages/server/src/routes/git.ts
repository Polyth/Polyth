// HTTP face of the git + worktrees plugin (PLAN §12).
import type { ProjectService } from "@polyth/contracts";
import type { GitService } from "@polyth/git";
import type { RouteHandler } from "../http.ts";

export function gitRoutes(deps: {
  projects: ProjectService;
  git: GitService;
  /** small-model commit message (server owns the LLM seam, the git plugin does not) */
  commitMessage(root: string): Promise<string>;
}): RouteHandler {
  const { git } = deps;
  const rootOf = async (projectId: string | null | undefined): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };
  const paths = (b: Record<string, unknown>): string[] =>
    Array.isArray(b.paths) ? b.paths.map((p) => String(p)) : [];

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/git") && !path.startsWith("/api/worktrees")) return false;
    const q = (k: string) => url.searchParams.get(k);

    if (path === "/api/git/status" && method === "GET") {
      const root = await rootOf(q("projectId"));
      if (!(await git.isRepo(root))) {
        json(200, { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false });
        return true;
      }
      json(200, { ...(await git.status(root)), isRepo: true });
      return true;
    }
    if (path === "/api/git/diff" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.diff(root, {
        ...(q("path") ? { path: q("path")! } : {}),
        staged: q("staged") === "true",
      }));
      return true;
    }
    if (path === "/api/git/log" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.log(root, Number(q("limit") ?? 20)));
      return true;
    }
    if (path === "/api/git/branches" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.branches(root));
      return true;
    }
    if (path === "/api/worktrees" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, (await git.isRepo(root)) ? await git.worktrees.list(root) : []);
      return true;
    }

    if (method !== "POST") return false;
    const b = await body();
    const root = await rootOf(b.projectId as string | undefined);

    switch (path) {
      case "/api/git/stage": await git.stage(root, paths(b)); break;
      case "/api/git/unstage": await git.unstage(root, paths(b)); break;
      case "/api/git/discard": await git.discard(root, paths(b)); break;
      case "/api/git/commit": {
        json(200, await git.commit(root, String(b.message ?? "")));
        return true;
      }
      case "/api/git/commit-message": {
        json(200, { message: await deps.commitMessage(root) });
        return true;
      }
      case "/api/git/branch":
        await git.createBranch(root, String(b.name ?? ""), b.from ? String(b.from) : undefined);
        break;
      case "/api/git/checkout": await git.checkout(root, String(b.name ?? "")); break;
      case "/api/worktrees": {
        json(200, await git.worktrees.create(root, {
          branch: String(b.branch ?? ""),
          ...(b.path ? { path: String(b.path) } : {}),
          ...(b.base ? { base: String(b.base) } : {}),
        }));
        return true;
      }
      case "/api/worktrees/remove":
        await git.worktrees.remove(root, { path: String(b.path ?? ""), deleteBranch: b.deleteBranch === true });
        break;
      default:
        return false;
    }
    json(200, { ok: true });
    return true;
  };
}
