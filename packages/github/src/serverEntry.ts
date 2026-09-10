import type { RouteHandler } from "@polyth/contracts";
import { execFile } from "node:child_process";
import { detectGitRemotes } from "@polyth/code-hosting/remotes";
import { roleAtLeast } from "@polyth/contracts";
import { describeChangeRequest, hostingRoutes } from "@polyth/code-hosting/routes";

import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { GitService } from "@polyth/git";
import {
  createGithubService,
  type GithubService,
} from "./index.ts";

export function githubRoutes(deps: Omit<Parameters<typeof hostingRoutes>[0], "provider" | "prefix" | "presentation" | "mergeStrategies"> & { github: GithubService }): RouteHandler {
  return hostingRoutes({ ...deps, provider: deps.github, prefix: "/api/github", mergeStrategies: ["squash", "merge", "rebase"], presentation: { changeRequest: "pull request", abbreviation: "PR", numberPrefix: "#", conflictEvent: "github/conflict-resolution-started" } });
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared with the walkthrough package (PR diff capture) — published at load
  // time under the well-known key.
  const github = createGithubService();
  host.services.provide(serverServiceKey<GithubService>("github"), github);
  let routes: RouteHandler | null = null;
  const statusCache = new Map<string, Awaited<ReturnType<GithubService["status"]>>>();
  return {
    remoteAccess: localOnlyRemoteAccess(["github"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const git = host.services.require(serverServiceKey<GitService>("git"));
      routes = async request => {
        if (!request.path.startsWith("/api/github/")) return false;
        const scoped = host.forSpace(request.space);
        const input = request.method === "GET" ? {} : await request.body();
        const projectId = String(input.projectId ?? request.url.searchParams.get("projectId") ?? "");
        const project = await scoped.projects.get(projectId);
        if (!project) { request.json(404, { ok: false, reason: "Project not found." }); return true; }
        if (request.method !== "GET" && !roleAtLeast(request.space.role, "member")) { request.json(403, { ok: false, reason: "Your Space role cannot perform this operation." }); return true; }
        if (input.sessionId) {
          const session = await scoped.sessions.snapshot(String(input.sessionId));
          if (session.projectId !== projectId) { request.json(404, { ok: false, reason: "Session not found." }); return true; }
        }
        const key = `${request.space.spaceId}:${projectId}`;
        if (request.path === "/api/github/context" || request.path === "/api/github/status" && request.url.searchParams.get("passive") === "true") {
          const remotes = await detectGitRemotes(project.path, (bin, args, opts) => new Promise((resolve, reject) => {
            execFile(bin, args, { cwd: opts.cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error("Local Git inspection failed.")) : resolve({ stdout, stderr }));
          }));
          const status = statusCache.get(key) ?? { installed: false, authenticated: false, user: null, repo: null };
          request.json(200, request.path.endsWith("/context") ? { ok: true, data: { remotes, user: status.user } } : status);
          return true;
        }
        return githubRoutes({
        projects: scoped.projects,
        github,
        append: (sessionId, type, data) => host.events.append(
          sessionId,
          type,
          data,
          { ignorable: true, producerPlugin: "review" },
        ),
        sessions: {
          create: (input) => scoped.sessions.create(input),
          snapshot: (sessionId) => scoped.sessions.snapshot(sessionId),
          send: (sessionId, input) => scoped.sessions.send(sessionId, input),
        },
        describe: async (root, base) => {
          let baseRef = base;
          if (!baseRef) {
            const repository = await github.repo(root);
            baseRef = (repository.ok && repository.data.defaultBranch) || "main";
          }
          const diff = await git.diffRange(root, baseRef, "HEAD");
          return describeChangeRequest(host, projectId, root, diff, "pull request");
        },
      })({ ...request, body: async () => input, json: (status, payload) => {
        if (request.path === "/api/github/status") statusCache.set(key, payload as Awaited<ReturnType<GithubService["status"]>>);
        request.json(status, payload);
      } });
      };
    },
    onDisable() { routes = null; statusCache.clear(); },
  };
}
