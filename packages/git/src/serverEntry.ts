import { posix } from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentRuntime,
  CreateIsolatedSessionInput,
  JsonObject,
  ModelRef,
  ProjectCloneInput,
  RemoteAccessPolicy,
  RemoteHost,
  SessionProjection,
} from "@polyth/contracts";
import type { ProjectService, RouteHandler, SessionService } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  buildLocalConflictResolutionPrompt,
  createGitService,
  cloneRepository,
  pathsUnder,
  type GitService,
} from "./index.ts";
import { createIsolationService, type IsolationService } from "./sessionIntegration.ts";

const COMMIT_PROMPT_VERSION = 2;
const COMMIT_OUTPUT_TOKENS = 120;
const COMMIT_CACHE_TTL_MS = 60_000;
// Commit-message generation runs on the session transport (create throwaway
// session → reconcile → turn), and a free/rate-limited or subscription-auth
// model (e.g. Haiku over OAuth) legitimately needs far longer than the old 30s
// cap, which surfaced as a spurious "timed out". Match the oneShot default.
const COMMIT_TIMEOUT_MS = 90_000;

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Keep both ends of a large diff: file headers and the final change are often
 * the most useful identity signals. The caller supplies a model-aware global
 * budget, so this is never a per-file arbitrary limit. */
export function buildCommitMessagePrompt(diff: string, inputBudget: number): string {
  const prefix = [
    "Write a git commit message. Output only the message.",
    "Use one imperative subject of at most 72 characters; add a short body only when necessary.",
    "Do not use markdown fences.",
    "<diff>",
  ].join("\n");
  const suffix = "\n</diff>";
  const available = Math.max(0, inputBudget - prefix.length - suffix.length);
  const marker = "\n… diff truncated …\n";
  const compact = diff.length <= available ? diff : available < 256
    ? diff.slice(0, available)
    : `${diff.slice(0, Math.floor((available - marker.length) * 0.7))}${marker}${diff.slice(-Math.floor((available - marker.length) * 0.3))}`;
  return `${prefix}\n${compact}${suffix}`;
}

export interface CommitMessageGeneratorDeps {
  diff(root: string, opts?: { staged?: boolean }): Promise<{ diff: string }>;
  runtime(root: string): Promise<AgentRuntime>;
  model?: ModelRef;
  inputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
  complete(runtime: AgentRuntime, options: {
    cwd: string; prompt: string; model?: ModelRef; maxOutputTokens: number; timeoutMs?: number;
  }): Promise<{ text: string }>;
  now?: () => number;
}

/** Content-addressed, short-lived commit utility cache with single-flight
 * coalescing. It intentionally stores only generated text, never secrets. */
export function createCommitMessageGenerator(deps: CommitMessageGeneratorDeps): (root: string) => Promise<string> {
  const cache = new Map<string, { text: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  return async (root) => {
    const staged = await deps.diff(root, { staged: true });
    const stagedSelected = !!staged.diff.trim();
    const diff = stagedSelected ? staged.diff : (await deps.diff(root)).diff;
    if (!diff.trim()) throw Object.assign(new Error("nothing to describe"), { code: "invalid-input" });
    const modelKey = deps.model ? `${deps.model.providerID}/${deps.model.modelID}` : "default";
    const key = `${digest(diff)}:${stagedSelected ? "staged" : "unstaged"}:${modelKey}:v${COMMIT_PROMPT_VERSION}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.text;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
      const runtime = await deps.runtime(root);
      const budget = await deps.inputBudget(runtime, deps.model, COMMIT_OUTPUT_TOKENS);
      const result = await deps.complete(runtime, {
        cwd: root,
        model: deps.model,
        maxOutputTokens: COMMIT_OUTPUT_TOKENS,
        timeoutMs: COMMIT_TIMEOUT_MS,
        prompt: buildCommitMessagePrompt(diff, budget),
      });
      const text = result.text.replace(/^```[a-z]*\n?|```$/g, "").trim();
      if (!text) throw new Error("small model returned an empty commit message");
      cache.set(key, { text, expiresAt: now() + COMMIT_CACHE_TTL_MS });
      return text;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
  };
}

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
  /** Session-log append seam for the conflict-resolution handoff. Optional so
   *  minimal deployments and existing test fakes stay valid; when absent the
   *  handoff still sends the prompt, it just skips the marker event. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  remote?: { host(connectionId: string): RemoteHost };
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
    const query = (key: string) => url.searchParams.get(key);

    if (path === "/api/projects/clone" && method === "POST") {
      const input = await body() as Partial<ProjectCloneInput>;
      if (typeof input.repository !== "string" || typeof input.parentPath !== "string") {
        throw Object.assign(new Error("repository and parentPath are required"), { code: "invalid-input" });
      }
      const remote = input.remote;
      if (remote && (remote.kind !== "ssh" || typeof remote.connectionId !== "string" || !remote.connectionId)) {
        throw Object.assign(new Error("remote must contain an SSH connectionId"), { code: "invalid-input" });
      }
      const host = remote ? deps.remote?.host(remote.connectionId) : undefined;
      if (remote && !host) {
        throw Object.assign(new Error("SSH support unavailable"), { code: "unavailable" });
      }
      const result = await cloneRepository(
        { repository: input.repository, parentPath: input.parentPath, ...(typeof input.name === "string" ? { name: input.name } : {}), ...(remote ? { remote } : {}) },
        host,
      );
      if (remote) {
        if (!deps.projects.addRemote) throw Object.assign(new Error("remote projects are not supported"), { code: "unsupported" });
        json(200, await deps.projects.addRemote(result.path, remote, result.name));
      } else {
        json(200, await deps.projects.add(result.path, result.name));
      }
      return true;
    }

    if (!path.startsWith("/api/git") && !path.startsWith("/api/worktrees")) return false;

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

    // Hand a local conflict (diverged fast-forward pull, or an in-progress
    // merge/rebase with markers) to an agent session with a default prompt.
    // Sibling of /api/github/pr/conflict-agent, minus the PR context.
    if (path === "/api/git/resolve-conflict-agent" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const projectRoot = await projectRootOf(projectId);
      const target = String(input.target ?? "");
      if (target !== "new-session" && target !== "current-session") {
        json(400, { ok: false, reason: "target must be new-session or current-session" });
        return true;
      }
      const givenSessionId = input.sessionId ? String(input.sessionId) : "";

      let root = projectRoot;
      if (target === "current-session") {
        if (!givenSessionId) {
          json(400, { ok: false, reason: "sessionId is required for current-session" });
          return true;
        }
        let session: SessionProjection;
        try {
          session = await deps.sessions.snapshot(givenSessionId);
        } catch {
          json(404, { ok: false, reason: "target session not found" });
          return true;
        }
        if (session.projectId !== projectId) {
          json(400, { ok: false, reason: "target session belongs to another project" });
          return true;
        }
        if (session.worktreeState === "missing") {
          json(409, { ok: false, reason: "the target session's worktree is missing" });
          return true;
        }
        root = session.worktreePath ?? projectRoot;
      }

      if (!(await git.isRepo(root))) {
        json(409, { ok: false, reason: "this project is not a git repository" });
        return true;
      }
      const status = await git.status(root);
      const conflictedPaths = status.conflicted.map((file) => file.path);
      const diverged = status.ahead > 0 && status.behind > 0;
      if (conflictedPaths.length === 0 && !diverged) {
        json(409, { ok: false, reason: "there is no git conflict to resolve in this repository" });
        return true;
      }

      let sessionId = givenSessionId;
      if (target === "new-session") {
        sessionId = (await deps.sessions.create({
          projectId,
          title: "Resolve git conflicts",
        })).id;
      }

      const prompt = buildLocalConflictResolutionPrompt(
        {
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          conflictedPaths,
          diverged,
        },
        String(input.prompt ?? ""),
      );
      await deps.append?.(sessionId, "git/conflict-resolution-started", {
        branch: status.branch ?? "",
        ahead: status.ahead,
        behind: status.behind,
        conflictedCount: conflictedPaths.length,
        diverged,
      });
      await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
      json(200, { ok: true, data: { sessionId } });
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

export function isolationRoutes(deps: {
  isolation: IsolationService;
}): RouteHandler {
  const { isolation } = deps;
  return async ({ path, method, body, json }) => {
    if (!path.startsWith("/api/isolation")) return false;

    if (path === "/api/isolation/sessions" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input" });
      json(200, await isolation.createIsolatedSession({
        projectId,
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(input.model && typeof input.model === "object" ? { model: input.model as CreateIsolatedSessionInput["model"] } : {}),
        ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
        ...(typeof input.sourceSessionId === "string" ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(typeof input.targetBranch === "string" ? { targetBranch: input.targetBranch } : {}),
      }));
      return true;
    }

    const match = /^\/api\/isolation\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!match) return false;
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2];

    if (!action && method === "GET") {
      json(200, await isolation.getStatus(sessionId));
      return true;
    }
    if (method !== "POST") return false;
    if (action === "merge") {
      json(200, await isolation.mergeBack(sessionId));
      return true;
    }
    if (action === "keep") {
      json(200, await isolation.keepIsolated(sessionId));
      return true;
    }
    if (action === "discard") {
      json(200, await isolation.discard(sessionId));
      return true;
    }
    if (action === "resolve") {
      json(200, await isolation.resolveWithAgent(sessionId));
      return true;
    }
    return false;
  };
}

export const GIT_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["git", "worktrees", "isolation"],
  http: [
    { methods: ["GET"], path: "/api/git/status", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/diff", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/show", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/log", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/graph", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/branches", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/stashes", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/identity", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/worktrees", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/isolation/:sessionId", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["POST"], path: "/api/git/resolve-conflict-agent", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/unstage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/folder", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/commit", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/commit-message", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/branch", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/checkout", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash/apply", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash/drop", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/fetch", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/pull", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/push", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/identity", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees/remove", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/sessions", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/merge", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/keep", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/resolve", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared with the session service (worktree validation), tracks, github, and
  // walkthrough capture — published at load time under the well-known key.
  const git = createGitService();
  host.services.provide(serverServiceKey<GitService>("git"), git);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: GIT_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const commitMessage = createCommitMessageGenerator({
        diff: (root, opts) => git.diff(root, opts),
        runtime: async (root) => {
          const project = (await host.projects.list()).find((candidate) => candidate.path === root);
          return host.runtimes.forProject(project?.id ?? "__default__");
        },
        model: host.smallModel(),
        inputBudget: (runtime, model, maxOutputTokens) => host.smallModelInputBudget(runtime, model, maxOutputTokens),
        // Keep commit-message generation on the proven session transport. The
        // direct provider transport is optional and can turn provider hiccups
        // into a hard 500 before the fallback runtime is able to recover.
        complete: (runtime, options) => host.oneShot(runtime, {
          cwd: options.cwd,
          prompt: options.prompt,
          ...(options.model ? { model: options.model } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        }).then((text) => ({ text })),
      });
      const append = (sessionId: string, type: string, data: JsonObject) => host.events.append(
        sessionId,
        type,
        data,
        { ignorable: true, producerPlugin: "git" },
      );
      const isolation = createIsolationService({
        git,
        sessions: host.sessions,
        projects: host.projects,
        append,
        commitMessage,
        closeWorkspaceProcesses: async (cwd) => {
          const terminals = host.services.get<{ closeByCwd(path: string): Promise<void> }>(
            serverServiceKey("terminal"),
          );
          await terminals?.closeByCwd(cwd);
        },
      });
      host.services.provide(serverServiceKey<IsolationService>("isolation"), isolation);
      const gitHandler = gitRoutes({
        projects: host.projects,
        sessions: host.sessions,
        git,
        remote: { host: (connectionId) => host.services.require<{ host(id: string): RemoteHost }>(serverServiceKey("ssh")).host(connectionId) },
        commitMessage,
        append,
      });
      const isolationHandler = isolationRoutes({ isolation });
      routes ??= async (request) => (await isolationHandler(request)) || (await gitHandler(request));
      void isolation.recoverAll().catch((error: unknown) => {
        console.error("[polyth] isolation recovery failed", error);
      });
    },
  };
}
