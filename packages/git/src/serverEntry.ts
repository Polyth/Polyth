import { posix } from "node:path";
import type { ProjectService, RouteHandler, SessionService } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { pathsUnder, type GitService } from "./index.ts";

export function assertGitRelativePath(value: string, allowEmpty = false): string {
  if (value.length === 0 && allowEmpty) return value;
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    value.length === 0
    || value.includes("\0")
    || posix.isAbsolute(portable)
    || /^[a-z]:\//i.test(portable)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw Object.assign(new Error("Git path must stay within the project workspace."), {
      code: "invalid-path",
    });
  }
  return value;
}

export function gitRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  git: GitService;
  commitMessage(root: string): Promise<string>;
}): RouteHandler {
  const { git } = deps;
  const projectRootOf = async (projectId: string | null | undefined): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };
  const rootOf = async (
    projectId: string | null | undefined,
    sessionId?: string | null,
  ): Promise<string> => {
    const projectRoot = await projectRootOf(projectId);
    if (!sessionId) return projectRoot;
    const session = await deps.sessions.snapshot(sessionId);
    if (session.projectId !== projectId) {
      throw Object.assign(new Error("session does not belong to this project"), { code: "invalid-input" });
    }
    if (session.worktreeState === "missing") {
      throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
    }
    return session.worktreePath ?? projectRoot;
  };
  const paths = (body: Record<string, unknown>): string[] =>
    Array.isArray(body.paths) ? body.paths.map((path) => assertGitRelativePath(String(path))) : [];

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/git") && !path.startsWith("/api/worktrees")) return false;
    const query = (key: string) => url.searchParams.get(key);

    if (path === "/api/git/status" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"));
      if (!(await git.isRepo(root))) {
        json(200, { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false });
        return true;
      }
      json(200, { ...(await git.status(root)), isRepo: true });
      return true;
    }
    if (path === "/api/git/diff" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"));
      json(200, await git.diff(root, {
        ...(query("path") ? { path: assertGitRelativePath(query("path")!) } : {}),
        staged: query("staged") === "true",
        ignoreWhitespace: query("ignoreWhitespace") === "true",
      }));
      return true;
    }
    if (path === "/api/git/show" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"));
      const sha = query("sha");
      if (!sha) throw Object.assign(new Error("sha required"), { code: "invalid-input" });
      json(200, await git.show(root, sha, { ignoreWhitespace: query("ignoreWhitespace") === "true" }));
      return true;
    }
    if (path === "/api/git/log" && method === "GET") {
      json(200, await git.log(
        await rootOf(query("projectId"), query("sessionId")),
        Number(query("limit") ?? 20),
      ));
      return true;
    }
    if (path === "/api/git/graph" && method === "GET") {
      json(200, await git.graph(await rootOf(query("projectId"), query("sessionId")), {
        limit: Number(query("limit") ?? 40),
        skip: Number(query("skip") ?? 0),
      }));
      return true;
    }
    if (path === "/api/git/branches" && method === "GET") {
      json(200, await git.branches(await rootOf(query("projectId"), query("sessionId"))));
      return true;
    }
    if (path === "/api/git/stashes" && method === "GET") {
      json(200, await git.stashList(await rootOf(query("projectId"), query("sessionId"))));
      return true;
    }
    if (path === "/api/git/identity" && method === "GET") {
      json(200, await git.identity(await projectRootOf(query("projectId"))));
      return true;
    }
    if (path === "/api/worktrees" && method === "GET") {
      const root = await projectRootOf(query("projectId"));
      json(200, (await git.isRepo(root)) ? await git.worktrees.list(root) : []);
      return true;
    }

    if (method !== "POST") return false;
    const input = await body();
    const projectId = String(input.projectId ?? "");
    const root = path.startsWith("/api/worktrees")
      ? await projectRootOf(projectId)
      : await rootOf(projectId, input.sessionId ? String(input.sessionId) : undefined);

    switch (path) {
      case "/api/git/stage": await git.stage(root, paths(input)); break;
      case "/api/git/unstage": await git.unstage(root, paths(input)); break;
      case "/api/git/discard": await git.discard(root, paths(input)); break;
      case "/api/git/folder": {
        const operation = String(input.op ?? "");
        const folder = assertGitRelativePath(String(input.folder ?? ""), true);
        const expanded = pathsUnder(await git.status(root), folder);
        if (operation === "stage") await git.stage(root, [...expanded.unstaged, ...expanded.untracked, ...expanded.conflicted]);
        else if (operation === "unstage") await git.unstage(root, expanded.staged);
        else if (operation === "discard") await git.discard(root, [...expanded.unstaged, ...expanded.untracked]);
        else {
          json(400, { error: "invalid-input", message: "op must be stage|unstage|discard" });
          return true;
        }
        break;
      }
      case "/api/git/commit":
        json(200, await git.commit(root, String(input.message ?? "")));
        return true;
      case "/api/git/commit-message":
        json(200, { message: await deps.commitMessage(root) });
        return true;
      case "/api/git/branch":
        await git.createBranch(root, String(input.name ?? ""), input.from ? String(input.from) : undefined);
        break;
      case "/api/git/checkout": await git.checkout(root, String(input.name ?? "")); break;
      case "/api/git/stash":
        json(200, await git.stashPush(root, input.message ? String(input.message) : undefined));
        return true;
      case "/api/git/stash/apply": await git.stashApply(root, input.ref ? String(input.ref) : undefined); break;
      case "/api/git/stash/drop": await git.stashDrop(root, input.ref ? String(input.ref) : undefined); break;
      case "/api/git/fetch": await git.fetch(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/pull": await git.pull(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/push": await git.push(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/identity":
        await git.setIdentity(root, { name: String(input.name ?? ""), email: String(input.email ?? "") });
        json(200, await git.identity(root));
        return true;
      case "/api/worktrees":
        json(200, await git.worktrees.create(root, {
          branch: String(input.branch ?? ""),
          ...(input.path ? { path: String(input.path) } : {}),
          ...(input.base ? { base: String(input.base) } : {}),
        }));
        return true;
      case "/api/worktrees/remove":
        await git.worktrees.remove(root, {
          path: String(input.path ?? ""),
          deleteBranch: input.deleteBranch === true,
        });
        await deps.sessions.markWorktreeMissing?.(projectId, String(input.path ?? ""));
        break;
      default:
        return false;
    }
    json(200, { ok: true });
    return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const git = host.services.require(serverServiceKey<GitService>("git"));
      routes ??= gitRoutes({
        projects: host.projects,
        sessions: host.sessions,
        git,
        commitMessage: async (root) => {
          const staged = await git.diff(root, { staged: true });
          const diff = staged.diff.trim() || (await git.diff(root)).diff;
          if (!diff.trim()) {
            throw Object.assign(new Error("nothing to describe"), { code: "invalid-input" });
          }
          const project = (await host.projects.list()).find((candidate) => candidate.path === root);
          const runtime = await host.runtimes.forProject(project?.id ?? "__default__");
          const text = await host.oneShot(runtime, {
            cwd: root,
            ...(host.smallModel() ? { model: host.smallModel()! } : {}),
            prompt: [
              "Write a git commit message for the diff below. Output ONLY the message.",
              "Format: a <=72 character imperative subject line; add a short body only if the change is non-obvious.",
              "Do not use tools. Do not wrap the answer in code fences.",
              "", "<diff>", diff.slice(0, 24_000), "</diff>",
            ].join("\n"),
          });
          return text.replace(/^```[a-z]*\n?|```$/g, "").trim();
        },
      });
    },
  };
}
