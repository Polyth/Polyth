import type {
  CreateSessionInput,
  JsonObject,
  ProjectService,
  RouteHandler,
  SessionEvent,
  SessionProjection,
  SessionRef,
  UserTurnInput,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { GitService } from "@polyth/git";
import {
  buildConflictResolutionPrompt,
  createGithubService,
  summarizeChecks,
  type GithubService,
  type MergeStrategy,
  type ReviewCommentInput,
} from "./index.ts";

const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;

export function githubRoutes(deps: {
  projects: ProjectService;
  github: GithubService;
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  /** Session handoff seam for conflict resolution; optional in minimal deployments. */
  sessions?: {
    create: (input: CreateSessionInput) => Promise<SessionRef>;
    snapshot: (sessionId: string) => Promise<SessionProjection>;
    send: (sessionId: string, input: UserTurnInput & { githubConflictResolution?: boolean }) => Promise<unknown>;
  };
  describe?: (root: string, base?: string) => Promise<{ title: string; body: string }>;
}): RouteHandler {
  const rootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };

  return async ({ path, method, url, json, body }) => {
    if (!path.startsWith("/api/github")) return false;
    let match = path.match(/^\/api\/github\/(issue|pr)\/(\d+)\/comments$/);
    if (match && method === "POST") {
      const kind = match[1] as "issue" | "pr";
      const number = Number(match[2]);
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const comment = String(input.body ?? "").trim();
      if (!comment) {
        json(400, { ok: false, reason: "comment body is required" });
        return true;
      }
      const result = kind === "issue"
        ? await deps.github.addIssueComment(root, number, comment)
        : await deps.github.addPrComment(root, number, comment);
      // Agent-generated text and the external write become durable before the
      // success is exposed to the panel that initiated the publish.
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), `${kind}/commented`, {
          number, body: comment, url: result.data.url,
        });
      }
      json(200, result);
      return true;
    }
    match = path.match(/^\/api\/github\/pr\/(\d+)\/reviews$/);
    if (match && method === "POST") {
      const number = Number(match[1]);
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const event = String(input.event ?? "COMMENT") as
        | "COMMENT"
        | "APPROVE"
        | "REQUEST_CHANGES";
      if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) {
        json(400, {
          ok: false,
          reason: "event must be COMMENT, APPROVE, or REQUEST_CHANGES",
        });
        return true;
      }
      if (event !== "COMMENT" && input.confirm !== true) {
        json(400, { ok: false, reason: `${event} requires confirm:true` });
        return true;
      }
      const comments = Array.isArray(input.comments)
        ? input.comments as ReviewCommentInput[]
        : [];
      const result = await deps.github.submitReview(root, {
        number,
        event,
        body: String(input.body ?? ""),
        comments,
        ...(input.commitSha ? { commitSha: String(input.commitSha) } : {}),
      });
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), "review/submitted", {
          prNumber: number,
          reviewId: result.data.id,
          event,
          ...(input.commitSha ? { commitSha: String(input.commitSha) } : {}),
          commentCount: comments.length,
          body: String(input.body ?? ""),
        });
      }
      json(200, result);
      return true;
    }
    match = path.match(/^\/api\/github\/pr\/(\d+)\/labels$/);
    if (match && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
      json(200, await deps.github.addLabels(root, Number(match[1]), labels));
      return true;
    }
    if (path === "/api/github/pr/conflict-agent" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const root = await rootOf(projectId || null);
      const number = Number(input.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const target = String(input.target ?? "");
      if (target !== "new-session" && target !== "current-session") {
        json(400, { ok: false, reason: "target must be new-session or current-session" });
        return true;
      }
      if (!deps.sessions || !deps.append) {
        json(503, { ok: false, reason: "conflict resolution agent handoff is not available on this server" });
        return true;
      }
      const detailResult = await deps.github.prDetail(root, number);
      if (!detailResult.ok) {
        json(200, detailResult);
        return true;
      }
      const detail = detailResult.data;
      if (detail.mergeable !== "CONFLICTING") {
        json(409, { ok: false, reason: `pull request #${number} is not currently conflicting` });
        return true;
      }

      let sessionId: string;
      if (target === "new-session") {
        sessionId = (await deps.sessions.create({
          projectId,
          title: `PR #${number} conflicts`,
        })).id;
      } else {
        sessionId = String(input.sessionId ?? "").trim();
        if (!sessionId) {
          json(400, { ok: false, reason: "sessionId is required for current-session" });
          return true;
        }
        let session: SessionProjection;
        try {
          session = await deps.sessions.snapshot(sessionId);
        } catch {
          json(404, { ok: false, reason: "target session not found" });
          return true;
        }
        if (session.projectId !== projectId) {
          json(400, { ok: false, reason: "target session belongs to another project" });
          return true;
        }
      }

      const prompt = buildConflictResolutionPrompt(detail, String(input.prompt ?? ""));
      await deps.append(sessionId, "github/conflict-resolution-started", {
        prNumber: detail.number,
        title: detail.title,
        url: detail.url,
        baseRefName: detail.baseRefName,
        headRefName: detail.headRefName,
      });
      await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
      json(200, { ok: true, data: { sessionId } });
      return true;
    }

    if (path === "/api/github/pr/create" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const title = String(input.title ?? "").trim();
      if (!title) {
        json(400, { ok: false, reason: "title is required" });
        return true;
      }
      const result = await deps.github.prCreate(root, {
        title,
        body: String(input.body ?? ""),
        ...(input.base ? { base: String(input.base) } : {}),
        ...(input.head ? { head: String(input.head) } : {}),
        ...(input.draft === true ? { draft: true } : {}),
      });
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), "pr/created", {
          prNumber: result.data.number,
          url: result.data.url,
          title,
          ...(input.base ? { base: String(input.base) } : {}),
          ...(input.draft === true ? { draft: true } : {}),
        });
      }
      json(200, result);
      return true;
    }
    if (path === "/api/github/pr/update" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const number = Number(input.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const result = await deps.github.prUpdate(root, number, {
        ...(input.title !== undefined ? { title: String(input.title) } : {}),
        ...(input.body !== undefined ? { body: String(input.body) } : {}),
        ...(input.base !== undefined ? { base: String(input.base) } : {}),
      });
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), "pr/updated", {
          prNumber: number,
          fields: ["title", "body", "base"].filter(
            (field) => input[field] !== undefined,
          ),
        });
      }
      json(200, result);
      return true;
    }
    if (path === "/api/github/pr/merge" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const number = Number(input.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const strategy = String(input.strategy ?? "") as MergeStrategy;
      if (!MERGE_STRATEGIES.includes(strategy)) {
        json(400, { ok: false, reason: "strategy must be squash, merge, or rebase" });
        return true;
      }
      if (input.confirm !== true) {
        json(400, { ok: false, reason: "merge requires confirm:true" });
        return true;
      }
      const result = await deps.github.prMerge(root, number, strategy);
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), "pr/merged", {
          prNumber: number,
          strategy,
        });
      }
      json(200, result);
      return true;
    }
    if (path === "/api/github/pr/describe" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      if (!deps.describe) {
        json(200, { ok: false, reason: "AI describe is not available on this server" });
        return true;
      }
      try {
        json(200, {
          ok: true,
          data: await deps.describe(root, input.base ? String(input.base) : undefined),
        });
      } catch (error) {
        json(200, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (method !== "GET") return false;
    const root = await rootOf(url.searchParams.get("projectId"));
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const number = Number(url.searchParams.get("number") ?? 0);
    if (path === "/api/github/status") {
      json(200, await deps.github.status(root));
      return true;
    }
    if (path === "/api/github/repo") {
      json(200, await deps.github.repo(root));
      return true;
    }
    if (path === "/api/github/issues") {
      json(200, await deps.github.issues(root, limit));
      return true;
    }
    if (path === "/api/github/issue") {
      json(200, await deps.github.getIssue(root, number));
      return true;
    }
    if (path === "/api/github/issue/comments") {
      json(200, await deps.github.getIssueComments(root, number));
      return true;
    }
    if (path === "/api/github/prs") {
      json(200, await deps.github.prs(root, limit));
      return true;
    }
    if (path === "/api/github/pr/current") {
      json(200, await deps.github.currentPrSummary(root));
      return true;
    }
    if (path === "/api/github/pr") {
      json(200, await deps.github.prDetail(root, number));
      return true;
    }
    if (path === "/api/github/pr/files") {
      json(200, await deps.github.prFiles(root, number));
      return true;
    }
    if (path === "/api/github/pr/checks") {
      const result = await deps.github.prChecks(root, number);
      json(200, result.ok
        ? { ok: true, data: { checks: result.data, summary: summarizeChecks(result.data) } }
        : result);
      return true;
    }
    if (path === "/api/github/pr/comments") {
      json(200, await deps.github.prComments(root, number));
      return true;
    }
    if (path === "/api/github/pr/diff") {
      json(200, await deps.github.prDiff(root, number));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared with the walkthrough package (PR diff capture) — published at load
  // time under the well-known key.
  const github = createGithubService();
  host.services.provide(serverServiceKey<GithubService>("github"), github);
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const git = host.services.require(serverServiceKey<GitService>("git"));
      routes ??= githubRoutes({
        projects: host.projects,
        github,
        append: (sessionId, type, data) => host.events.append(
          sessionId,
          type,
          data,
          { ignorable: true, producerPlugin: "review" },
        ),
        sessions: {
          create: (input) => host.sessions.create(input),
          snapshot: (sessionId) => host.sessions.snapshot(sessionId),
          send: (sessionId, input) => host.sessions.send(sessionId, input),
        },
        describe: async (root, base) => {
          let baseRef = base;
          if (!baseRef) {
            const repository = await github.repo(root);
            baseRef = (repository.ok && repository.data.defaultBranch) || "main";
          }
          const diff = await git.diffRange(root, baseRef, "HEAD");
          if (!diff.trim()) {
            throw Object.assign(
              new Error(`no commits to describe against ${baseRef}`),
              { code: "invalid-input" },
            );
          }
          const project = (await host.projects.list()).find(
            (candidate) => candidate.path === root,
          );
          const runtime = await host.runtimes.forProject(project?.id ?? "__default__");
          const text = await host.oneShot(runtime, {
            cwd: root,
            ...(host.smallModel() ? { model: host.smallModel()! } : {}),
            prompt: [
              "Write a pull request title and description for the diff below.",
              "Line 1: a <=72 character imperative title. Then a blank line, then a concise",
              "markdown description (what changed and why; a short bullet list is fine).",
              "Do not use tools. Do not wrap the answer in code fences. Output nothing else.",
              "", "<diff>", diff.slice(0, 24_000), "</diff>",
            ].join("\n"),
          });
          const clean = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
          const newline = clean.indexOf("\n");
          return newline === -1
            ? { title: clean.slice(0, 72), body: "" }
            : {
                title: clean.slice(0, newline).trim().slice(0, 200),
                body: clean.slice(newline + 1).trim(),
              };
        },
      });
    },
  };
}
