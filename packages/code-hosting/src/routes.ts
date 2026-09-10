import type { ServerPackageHost } from "@polyth/plugins";
import type { CreateSessionInput, JsonObject, ProjectService, RouteHandler, SessionEvent, SessionProjection, SessionRef, UserTurnInput } from "@polyth/contracts";
import type { HostingService, MergeStrategy, ReviewCommentInput } from "./types.ts";
import { summarizeChecks } from "./checks.ts";
import { buildConflictResolutionPrompt } from "./conflicts.ts";

export function hostingRoutes(deps: {
  projects: ProjectService;
  prefix: string;
  presentation: { changeRequest: string; abbreviation: string; numberPrefix: string; conflictEvent: string };
  mergeStrategies: readonly MergeStrategy[];
  provider: HostingService;
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
    if (path !== deps.prefix && !path.startsWith(`${deps.prefix}/`)) return false;
    // Keep the mature endpoint suffixes as a wire compatibility detail.
    path = `/api/hosting${path.slice(deps.prefix.length)}`;
    const extension = path.match(/^\/api\/hosting\/pr\/(\d+)\/(ready|unapprove|discussions)(?:\/([a-zA-Z0-9_-]+)\/(reply|resolve))?$/);
    if (extension) {
      const number = Number(extension[1]);
      const input = method === "POST" ? await body() : {};
      const root = await rootOf(method === "POST" ? String(input.projectId ?? "") : url.searchParams.get("projectId"));
      if (!Number.isSafeInteger(number) || number <= 0) { json(400, { ok: false, reason: "A positive resource number is required." }); return true; }
      const operation = extension[4] ?? extension[2];
      let result;
      if (method === "GET" && operation === "discussions" && deps.provider.discussions) result = await deps.provider.discussions(root, number);
      else if (method === "POST" && operation === "ready" && deps.provider.ready) result = await deps.provider.ready(root, number);
      else if (method === "POST" && operation === "unapprove" && deps.provider.unapprove && input.confirm === true) result = await deps.provider.unapprove(root, number);
      else if (method === "POST" && operation === "reply" && deps.provider.reply) result = await deps.provider.reply(root, number, extension[3]!, String(input.body ?? ""));
      else if (method === "POST" && operation === "resolve" && deps.provider.resolve && typeof input.resolved === "boolean") result = await deps.provider.resolve(root, number, extension[3]!, input.resolved);
      else { json(400, { ok: false, code: "unsupported-operation", reason: "Operation is unavailable or requires confirmation." }); return true; }
      if (method === "POST" && result.ok && input.sessionId && deps.append) await deps.append(String(input.sessionId), `hosting/${operation}`, { number });
      json(200, result);
      return true;
    }
    let match = path.match(/^\/api\/hosting\/(issue|pr)\/(\d+)\/comments$/);
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
        ? await deps.provider.addIssueComment(root, number, comment)
        : await deps.provider.addPrComment(root, number, comment);
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
    match = path.match(/^\/api\/hosting\/pr\/(\d+)\/reviews$/);
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
      const result = await deps.provider.submitReview(root, {
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
    match = path.match(/^\/api\/hosting\/pr\/(\d+)\/labels$/);
    if (match && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
      json(200, await deps.provider.addLabels(root, Number(match[1]), labels));
      return true;
    }
    if (path === "/api/hosting/pr/conflict-agent" && method === "POST") {
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
      const detailResult = await deps.provider.prDetail(root, number);
      if (!detailResult.ok) {
        json(200, detailResult);
        return true;
      }
      const detail = detailResult.data;
      if (detail.mergeable !== "CONFLICTING") {
        json(409, { ok: false, reason: `${deps.presentation.changeRequest} ${deps.presentation.numberPrefix}${number} is not currently conflicting` });
        return true;
      }

      let sessionId: string;
      if (target === "new-session") {
        sessionId = (await deps.sessions.create({
          projectId,
          title: `${deps.presentation.abbreviation} ${deps.presentation.numberPrefix}${number} conflicts`,
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

      const prompt = buildConflictResolutionPrompt(detail, String(input.prompt ?? ""), deps.presentation);
      await deps.append(sessionId, deps.presentation.conflictEvent, {
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

    if (path === "/api/hosting/pr/create" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const title = String(input.title ?? "").trim();
      if (!title) {
        json(400, { ok: false, reason: "title is required" });
        return true;
      }
      const result = await deps.provider.prCreate(root, {
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
    if (path === "/api/hosting/pr/update" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const number = Number(input.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const result = await deps.provider.prUpdate(root, number, {
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
    if (path === "/api/hosting/pr/merge" && method === "POST") {
      const input = await body();
      const root = await rootOf(input.projectId ? String(input.projectId) : null);
      const number = Number(input.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const strategy = String(input.strategy ?? "") as MergeStrategy;
      if (!deps.mergeStrategies.includes(strategy)) {
        json(400, { ok: false, reason: `strategy must be ${deps.mergeStrategies.length > 2 ? `${deps.mergeStrategies.slice(0, -1).join(", ")}, or ${deps.mergeStrategies.at(-1)}` : deps.mergeStrategies.join(" or ")}` });
        return true;
      }
      if (input.confirm !== true) {
        json(400, { ok: false, reason: "merge requires confirm:true" });
        return true;
      }
      const result = await deps.provider.prMerge(root, number, strategy, typeof input.headSha === "string" ? input.headSha : undefined);
      if (result.ok && input.sessionId && deps.append) {
        await deps.append(String(input.sessionId), "pr/merged", {
          prNumber: number,
          strategy,
        });
      }
      json(200, result);
      return true;
    }
    if (path === "/api/hosting/pr/describe" && method === "POST") {
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
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
    const filter = { search: url.searchParams.get("search") ?? undefined, state: url.searchParams.get("state") ?? undefined };
    const number = Number(url.searchParams.get("number") ?? 0);
    if (path === "/api/hosting/status") {
      json(200, await deps.provider.status(root));
      return true;
    }
    if (path === "/api/hosting/repo") {
      json(200, await deps.provider.repo(root));
      return true;
    }
    if (path === "/api/hosting/issues") {
      json(200, await deps.provider.issues(root, limit, filter));
      return true;
    }
    if (path === "/api/hosting/issue") {
      json(200, await deps.provider.getIssue(root, number));
      return true;
    }
    if (path === "/api/hosting/issue/comments") {
      json(200, await deps.provider.getIssueComments(root, number));
      return true;
    }
    if (path === "/api/hosting/prs") {
      json(200, await deps.provider.prs(root, limit, filter));
      return true;
    }
    if (path === "/api/hosting/pr/current") {
      json(200, await deps.provider.currentPrSummary(root));
      return true;
    }
    if (path === "/api/hosting/pr") {
      json(200, await deps.provider.prDetail(root, number));
      return true;
    }
    if (path === "/api/hosting/pr/files") {
      json(200, await deps.provider.prFiles(root, number));
      return true;
    }
    if (path === "/api/hosting/pr/checks") {
      const result = await deps.provider.prChecks(root, number);
      json(200, result.ok
        ? { ok: true, data: { checks: result.data, summary: summarizeChecks(result.data) } }
        : result);
      return true;
    }
    if (path === "/api/hosting/pr/comments") {
      json(200, await deps.provider.prComments(root, number));
      return true;
    }
    if (path === "/api/hosting/pr/diff") {
      json(200, await deps.provider.prDiff(root, number));
      return true;
    }
    return false;
  };
}



/** Both providers use the existing bounded one-shot runtime for user-requested descriptions. */
export async function describeChangeRequest(host: ServerPackageHost, projectId: string, root: string, diff: string, label: string) {
  if (!diff.trim()) throw Object.assign(new Error("No commits to describe against the target branch."), { code: "invalid-input" });
  const model = host.smallModel();
  const runtime = await host.runtimes.forProject(projectId, root, model?.harnessId);
  const text = await host.oneShot(runtime, {
    cwd: root, ...(model ? { model } : {}),
    prompt: [
      `Write a ${label} title and description for the diff below.`,
      "Line 1: a <=72 character imperative title. Then a blank line, then a concise",
      "markdown description (what changed and why; a short bullet list is fine).",
      "Do not use tools. Do not wrap the answer in code fences. Output nothing else.",
      "", "<diff>", diff.slice(0, 24_000), "</diff>",
    ].join("\n"),
  });
  const clean = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const newline = clean.indexOf("\n");
  return newline === -1 ? { title: clean.slice(0, 72), body: "" }
    : { title: clean.slice(0, newline).trim().slice(0, 200), body: clean.slice(newline + 1).trim() };
}
