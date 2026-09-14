import { readManagedMarker, isManagedBranch } from "./managedWorktrees.ts";
import { posix, resolve } from "node:path";
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
import { registerGitHandoffSources } from "./handoffSources.ts";
import { createWorktreeTopologyWatch } from "./worktreeTopology.ts";
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
  runtime(root: string, model: (ModelRef & { harnessId?: string }) | undefined): Promise<AgentRuntime>;
  model?: (userId?: string) => (ModelRef & { harnessId?: string }) | undefined;
  inputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
  complete(runtime: AgentRuntime, options: {
    cwd: string; prompt: string; model?: ModelRef; maxOutputTokens: number; timeoutMs?: number;
  }): Promise<{ text: string }>;
  now?: () => number;
}

/** Content-addressed, short-lived commit utility cache with single-flight
 * coalescing. It intentionally stores only generated text, never secrets. */
export function createCommitMessageGenerator(deps: CommitMessageGeneratorDeps): (root: string, userId?: string) => Promise<string> {
  const cache = new Map<string, { text: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  return async (root, userId) => {
    const staged = await deps.diff(root, { staged: true });
    const stagedSelected = !!staged.diff.trim();
    const diff = stagedSelected ? staged.diff : (await deps.diff(root)).diff;
    if (!diff.trim()) throw Object.assign(new Error("nothing to describe"), { code: "invalid-input" });
    const model = deps.model?.(userId);
    const modelKey = model ? `${model.harnessId ?? "auto"}/${model.providerID}/${model.modelID}` : "default";
    const key = `${digest(diff)}:${stagedSelected ? "staged" : "unstaged"}:${modelKey}:v${COMMIT_PROMPT_VERSION}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.text;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
      const runtime = await deps.runtime(root, model);
      const budget = await deps.inputBudget(runtime, model, COMMIT_OUTPUT_TOKENS);
      const result = await deps.complete(runtime, {
        cwd: root,
        model,
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

async function ownedBranchForWorktree(
  sessions: SessionService,
  projectId: string,
  worktreePath: string,
): Promise<string | null> {
  let listed: SessionProjection[];
  try {
    listed = await sessions.list(projectId);
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const session of listed) {
    if (!session.worktreePath || !session.branch) continue;
    if (resolve(session.worktreePath) !== resolve(worktreePath)) continue;
    names.add(session.branch);
  }
  return names.size === 1 ? [...names][0]! : null;
}

export function gitRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  git: GitService;
  commitMessage(root: string, userId?: string): Promise<string>;
  /** Session-log append seam for the conflict-resolution handoff. Optional so
   *  minimal deployments and existing test fakes stay valid; when absent the
   *  handoff still sends the prompt, it just skips the marker event. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  remote?: { host(connectionId: string): RemoteHost };
  /** Announce that one project's worktree topology changed. Optional so
   *  minimal deployments and existing test fakes stay valid. */
  worktreesChanged?: (projectId: string) => void;
}): RouteHandler {
  const { git } = deps;
  const topology = createWorktreeTopologyWatch((projectId) => deps.worktreesChanged?.(projectId));
  /** Announce a topology change this server just made, and record it so the
   *  next observation does not announce the same change a second time. */
  const announceTopology = async (projectId: string, root: string): Promise<void> => {
    await topology.settle(projectId, root);
    deps.worktreesChanged?.(projectId);
  };
  const projectRootOf = async (projectId: string | null | undefined): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };
  /** Resolve a client-named checkout to a root Git itself vouches for. The
   *  supplied path is only ever a selector: it must match a row of this
   *  project's live `git worktree list`, so a traversal, a symlink hop or
   *  another project's checkout can never become an operating root. */
  const worktreeRootOf = async (projectRoot: string, worktreePath: string): Promise<string> => {
    if (!(await git.isRepo(projectRoot))) {
      throw Object.assign(new Error("this project is not a git repository"), { code: "conflict" });
    }
    const wanted = resolve(worktreePath);
    const match = (await git.worktrees.list(projectRoot))
      .find((worktree) => resolve(worktree.path) === wanted);
    if (!match) {
      throw Object.assign(new Error("unknown worktree for this project"), { code: "not-found" });
    }
    return match.path;
  };
  const rootOf = async (
    projectId: string | null | undefined,
    sessionId?: string | null,
    worktreePath?: string | null,
  ): Promise<string> => {
    const projectRoot = await projectRootOf(projectId);
    if (sessionId) {
      const session = await deps.sessions.snapshot(sessionId);
      if (session.projectId !== projectId) {
        throw Object.assign(new Error("session does not belong to this project"), { code: "invalid-input" });
      }
      if (session.worktreeState === "missing") {
        throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
      }
      return session.worktreePath ?? projectRoot;
    }
    if (worktreePath) return worktreeRootOf(projectRoot, worktreePath);
    return projectRoot;
  };
  const conflictRootOf = async (
    projectId: string,
    target: string,
    givenSessionId: string,
  ): Promise<{ root: string } | { status: 400 | 404 | 409; reason: string }> => {
    const projectRoot = await projectRootOf(projectId);
    if (target !== "new-session" && target !== "current-session") {
      return { status: 400, reason: "target must be new-session or current-session" };
    }
    if (target === "new-session") return { root: projectRoot };
    if (!givenSessionId) return { status: 400, reason: "sessionId is required for current-session" };
    let session: SessionProjection;
    try {
      session = await deps.sessions.snapshot(givenSessionId);
    } catch {
      return { status: 404, reason: "target session not found" };
    }
    if (session.projectId !== projectId) return { status: 400, reason: "target session belongs to another project" };
    if (session.worktreeState === "missing") return { status: 409, reason: "the target session's worktree is missing" };
    return { root: session.worktreePath ?? projectRoot };
  };
  const paths = (body: Record<string, unknown>): string[] =>
    Array.isArray(body.paths) ? body.paths.map((path) => assertGitRelativePath(String(path))) : [];

  return async (rc) => {
    const { path, method, url, body, json } = rc;
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
      const root = await rootOf(query("projectId"), query("sessionId"), query("worktreePath"));
      // Status is the Git interaction the UI makes most often, so it is where
      // an externally created or removed worktree is cheapest to notice. The
      // fingerprint is always taken on the project checkout, never on `root`,
      // which may be a session's own worktree.
      if (query("projectId")) {
        void topology.observe(query("projectId")!, await projectRootOf(query("projectId")))
          .catch(() => undefined);
      }
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
      // Reading the list is also observing it: one client asking tells every
      // other open surface that the topology moved. The refetch that answer
      // provokes observes an unchanged fingerprint, so this cannot loop.
      await topology.observe(query("projectId")!, root);
      // A failed listing throws. It must never be flattened into "no
      // worktrees" — an empty list and an unreadable repository are different
      // answers, and only one of them is safe to act on.
      const worktrees = (await git.isRepo(root)) ? await git.worktrees.list(root) : [];
      // Per-checkout Git state is what makes push/merge meaningful, but it is
      // one `git status` per worktree — only read it when a caller asks.
      const withStatus = query("status") === "1";
      const visible = await Promise.all(worktrees.map(async (worktree) => {
        if (isManagedBranch(worktree.branch)) return null;
        const marker = await readManagedMarker(git, worktree.path);
        if (marker) return null;
        if (!withStatus) return worktree;
        try {
          const status = await git.status(worktree.path);
          return {
            ...worktree,
            ahead: status.ahead,
            behind: status.behind,
            changed: status.staged.length + status.unstaged.length
              + status.untracked.length + status.conflicted.length,
            conflicted: status.conflicted.length,
            ...(status.upstream ? { upstream: status.upstream } : {}),
          };
        } catch {
          // A checkout Git cannot describe right now is still a real worktree.
          // Omitting the counts says "unknown"; inventing zeros would not.
          return worktree;
        }
      }));
      json(200, visible.filter((worktree) => worktree !== null));
      return true;
    }

    // Build the live local-conflict prompt without creating a session or
    // sending anything. The browser opens it as an editable composer draft.
    if (path === "/api/git/conflict-prompt" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const target = String(input.target ?? "");
      const resolved = await conflictRootOf(projectId, target, input.sessionId ? String(input.sessionId) : "");
      if ("status" in resolved) {
        json(resolved.status, { ok: false, reason: resolved.reason });
        return true;
      }
      const root = resolved.root;
      if (!(await git.isRepo(root))) {
        json(409, { ok: false, reason: "this project is not a git repository" });
        return true;
      }
      const status = await git.status(root);
      const problem = typeof input.problem === "string" && input.problem.trim() ? input.problem.trim() : undefined;
      const prompt = buildLocalConflictResolutionPrompt({
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        conflictedPaths: status.conflicted.map((file) => file.path),
        diverged: status.ahead > 0 && status.behind > 0,
        ...(problem ? { problem } : {}),
      }, String(input.prompt ?? ""));
      json(200, { ok: true, data: { prompt } });
      return true;
    }

    // Backward-compatible server-side handoff for non-browser clients. The
    // GitView uses /api/git/conflict-prompt so the user can edit before send.
    if (path === "/api/git/resolve-conflict-agent" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const target = String(input.target ?? "");
      const givenSessionId = input.sessionId ? String(input.sessionId) : "";
      const resolved = await conflictRootOf(projectId, target, givenSessionId);
      if ("status" in resolved) {
        json(resolved.status, { ok: false, reason: resolved.reason });
        return true;
      }
      const root = resolved.root;

      if (!(await git.isRepo(root))) {
        json(409, { ok: false, reason: "this project is not a git repository" });
        return true;
      }
      const status = await git.status(root);
      const conflictedPaths = status.conflicted.map((file) => file.path);
      const diverged = status.ahead > 0 && status.behind > 0;
      const problem = typeof input.problem === "string" && input.problem.trim() ? input.problem.trim() : undefined;
      const hasConflict = conflictedPaths.length > 0 || diverged;

      let sessionId = givenSessionId;
      if (target === "new-session") {
        sessionId = (await deps.sessions.create({
          projectId,
          title: hasConflict ? "Resolve git conflicts" : "Resolve git problem",
        })).id;
      }

      const prompt = buildLocalConflictResolutionPrompt(
        {
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          conflictedPaths,
          diverged,
          ...(problem ? { problem } : {}),
        },
        String(input.prompt ?? ""),
      );
      await deps.append?.(sessionId, "git/conflict-resolution-started", {
        branch: status.branch ?? "",
        ahead: status.ahead,
        behind: status.behind,
        conflictedCount: conflictedPaths.length,
        diverged,
        ...(problem ? { problem } : {}),
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
      : await rootOf(
        projectId,
        input.sessionId ? String(input.sessionId) : undefined,
        input.worktreePath ? String(input.worktreePath) : undefined,
      );

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
        json(200, { message: await deps.commitMessage(root, rc.space.userId) });
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
      case "/api/git/rebase": await git.rebase(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/push": await git.push(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/sync": await git.sync(root, input.remote ? String(input.remote) : undefined); break;
      case "/api/git/merge": {
        const ref = String(input.ref ?? "").trim();
        if (!ref) throw Object.assign(new Error("ref required"), { code: "invalid-input" });
        // Managed isolation branches are published through the isolation
        // service, which owns snapshotting, compare-and-swap and rebind. A raw
        // merge would bypass every one of those guarantees.
        if (isManagedBranch(ref)) {
          throw Object.assign(new Error("isolated sessions are integrated from the session, not by a raw merge"), {
            code: "invalid-input",
          });
        }
        json(200, await git.merge(root, ref));
        return true;
      }
      case "/api/git/merge/abort":
        await git.abortMerge(root);
        break;
      case "/api/git/identity":
        await git.setIdentity(root, { name: String(input.name ?? ""), email: String(input.email ?? "") });
        json(200, await git.identity(root));
        return true;
      case "/api/worktrees": {
        const branch = String(input.branch ?? "");
        if (isManagedBranch(branch)) {
          throw Object.assign(new Error("managed isolation branches cannot be used for ordinary worktrees"), {
            code: "invalid-input",
          });
        }
        const created = await git.worktrees.create(root, {
          branch,
          ...(input.path ? { path: String(input.path) } : {}),
          ...(input.base ? { base: String(input.base) } : {}),
        });
        // Git has accepted the topology change and the checkout is complete —
        // `worktree add` does not return until it is. Announce before
        // responding so other open surfaces converge with the caller's.
        await announceTopology(projectId, root);
        json(200, created);
        return true;
      }
      case "/api/worktrees/remove": {
        const worktreePath = String(input.path ?? "");
        const activeIsolation = (await deps.sessions.list(projectId)).find((session) =>
          session.isolation?.kind === "git-worktree"
          && resolve(session.isolation.worktreePath) === resolve(worktreePath));
        if (activeIsolation) {
          throw Object.assign(new Error("merge or discard the isolated session before removing its workspace"), {
            code: "conflict",
          });
        }
        const deleteBranch = input.deleteBranch === true;
        const force = input.force === true;
        const ownedBranch = deleteBranch
          ? await ownedBranchForWorktree(deps.sessions, projectId, worktreePath)
          : null;
        // GitService owns physical removal and postcondition verification.
        // The route must not reinterpret Git state through the lossy public list.
        const cleanup = await git.worktrees.remove(root, {
          path: worktreePath,
          deleteBranch,
          force,
          ...(ownedBranch ? { ownedBranch } : {}),
        }) ?? {};
        await announceTopology(projectId, root);
        let metadataCleanupFailed = false;
        try {
          await deps.sessions.markWorktreeMissing?.(projectId, worktreePath);
        } catch (error) {
          metadataCleanupFailed = true;
          console.error("[polyth] worktree metadata cleanup failed after removal", error);
        }
        json(200, {
          ok: true,
          ...(metadataCleanupFailed ? { metadataCleanupFailed: true } : {}),
          ...(cleanup.branchCleanupFailed ? { branchCleanupFailed: true } : {}),
        });
        return true;
      }
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
      const rawHarness = input.harness as { mode?: unknown; harnessId?: unknown } | undefined;
      const harness = rawHarness?.mode === "auto"
        ? { mode: "auto" as const }
        : rawHarness?.mode === "pinned" && typeof rawHarness.harnessId === "string" && /^[a-z][a-z0-9-]*$/.test(rawHarness.harnessId)
          ? { mode: "pinned" as const, harnessId: rawHarness.harnessId }
          : undefined;
      if (input.harness !== undefined && !harness) throw Object.assign(new Error("invalid harness selection"), { code: "invalid-input" });
      json(200, await isolation.createIsolatedSession({
        projectId,
        ...(harness ? { harness } : {}),
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
    if (action === "recover") {
      json(200, await isolation.recover(sessionId));
      return true;
    }
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
    if (action === "abandon") {
      json(200, await isolation.abandonCleanup(sessionId));
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
    { methods: ["POST"], path: "/api/git/conflict-prompt", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
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
    { methods: ["POST"], path: "/api/git/rebase", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/push", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/sync", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/merge", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/merge/abort", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/identity", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees/remove", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/sessions", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/merge", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/keep", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/abandon", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
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
    async onEnable() {
      const commitMessage = createCommitMessageGenerator({
        diff: (root, opts) => git.diff(root, opts),
        runtime: async (root, model) => {
          const project = (await host.projects.list()).find((candidate) => candidate.path === root);
          return host.runtimes.forProject(project?.id ?? "__default__", root, model?.harnessId);
        },
        model: (userId) => host.smallModel(userId),
        inputBudget: (runtime, model, maxOutputTokens) => host.smallModelInputBudget(runtime, model, maxOutputTokens),
        complete: (runtime, options) => host.smallModelComplete(runtime, {
          ...options,
          purpose: "commit-message-generation",
        }),
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
        readEvents: (sessionId) => host.sessions.events(sessionId),
        closeWorkspaceProcesses: async (cwd) => {
          const terminals = host.services.get<{ closeByCwd(path: string): Promise<void> }>(
            serverServiceKey("terminal"),
          );
          await terminals?.closeByCwd(cwd);
        },
      });
      host.services.provide(serverServiceKey<IsolationService>("isolation"), isolation);
      const handoffRegistry = host.services.get(serverServiceKey<import("@polyth/handoff").ContextSourceRegistry>("handoff.sources"));
      if (handoffRegistry) {
        registerGitHandoffSources({ registry: handoffRegistry, git, projects: host.projects });
      }
      const gitHandler = gitRoutes({
        projects: host.projects,
        sessions: host.sessions,
        git,
        remote: { host: (connectionId) => host.services.require<{ host(id: string): RemoteHost }>(serverServiceKey("ssh")).host(connectionId) },
        commitMessage,
        append,
        worktreesChanged: (projectId) => host.broadcast.worktreesChanged?.(projectId),
      });
      const isolationHandler = isolationRoutes({ isolation });
      await isolation.recoverAll();
      routes ??= async (request) => (await isolationHandler(request)) || (await gitHandler(request));
    },
  };
}
