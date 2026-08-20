// HTTP face of the git + worktrees plugin (PLAN §12).
import type { ProjectService } from "@polyth/contracts";
import { pathsUnder, type GitService } from "@polyth/git";
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
        ignoreWhitespace: q("ignoreWhitespace") === "true",
      }));
      return true;
    }
    if (path === "/api/git/show" && method === "GET") {
      const root = await rootOf(q("projectId"));
      const sha = q("sha");
      if (!sha) throw Object.assign(new Error("sha required"), { code: "invalid-input" });
      json(200, await git.show(root, sha, { ignoreWhitespace: q("ignoreWhitespace") === "true" }));
      return true;
    }
    if (path === "/api/git/log" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.log(root, Number(q("limit") ?? 20)));
      return true;
    }
    if (path === "/api/git/graph" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.graph(root, {
        limit: Number(q("limit") ?? 40),
        skip: Number(q("skip") ?? 0),
      }));
      return true;
    }
    if (path === "/api/git/branches" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.branches(root));
      return true;
    }
    if (path === "/api/git/stashes" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await git.stashList(root));
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
      case "/api/git/folder": {
        // Folder actions expand against the *fresh* status, never a glob.
        const op = String(b.op ?? "");
        const folder = String(b.folder ?? "");
        const expanded = pathsUnder(await git.status(root), folder);
        if (op === "stage") await git.stage(root, [...expanded.unstaged, ...expanded.untracked, ...expanded.conflicted]);
        else if (op === "unstage") await git.unstage(root, expanded.staged);
        else if (op === "discard") await git.discard(root, [...expanded.unstaged, ...expanded.untracked]);
        else { json(400, { error: "invalid-input", message: "op must be stage|unstage|discard" }); return true; }
        break;
      }
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
      case "/api/git/stash": {
        json(200, await git.stashPush(root, b.message ? String(b.message) : undefined));
        return true;
      }
      case "/api/git/stash/apply": await git.stashApply(root, b.ref ? String(b.ref) : undefined); break;
      case "/api/git/stash/drop": await git.stashDrop(root, b.ref ? String(b.ref) : undefined); break;
      case "/api/git/fetch": await git.fetch(root, b.remote ? String(b.remote) : undefined); break;
      case "/api/git/pull": await git.pull(root, b.remote ? String(b.remote) : undefined); break;
      case "/api/git/push": await git.push(root, b.remote ? String(b.remote) : undefined); break;
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
