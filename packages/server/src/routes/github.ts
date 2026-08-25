// HTTP face of the GitHub plugin. Reads go through the gh CLI and fail soft
// (ok/reason) so missing binary/auth renders honestly. The two write
// operations (submit review, publish labels) are explicit, confirmed actions —
// nothing else on the server may write to GitHub.
import type { JsonObject, ProjectService, SessionEvent } from "@polyth/contracts";
import { summarizeChecks, type GithubService, type MergeStrategy, type ReviewCommentInput } from "@polyth/github";
import type { RouteHandler } from "../http.ts";

const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;

export function githubRoutes(deps: {
  projects: ProjectService;
  github: GithubService;
  /** logs review/submitted and pr/* lifecycle events to the originating session before responding */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  /** F7: small-model PR title+body from `git diff base...HEAD` — wired in boot,
   *  absent in minimal deployments. Never submits anything itself. */
  describe?: (root: string, base?: string) => Promise<{ title: string; body: string }>;
}): RouteHandler {
  const rootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };

  return async ({ path, method, url, json, body }) => {
    if (!path.startsWith("/api/github")) return false;

    // ---- writes: explicit and guarded ---------------------------------------
    let w = path.match(/^\/api\/github\/(issue|pr)\/(\d+)\/comments$/);
    if (w && method === "POST") {
      const kind = w[1] as "issue" | "pr";
      const number = Number(w[2]);
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const comment = String(b.body ?? "").trim();
      if (!comment) {
        json(400, { ok: false, reason: "comment body is required" });
        return true;
      }
      const result = kind === "issue"
        ? await deps.github.addIssueComment(root, number, comment)
        : await deps.github.addPrComment(root, number, comment);
      // Agent-generated text and the external write become durable before the
      // success is exposed to the panel that initiated the publish.
      if (result.ok && b.sessionId && deps.append) {
        await deps.append(String(b.sessionId), `${kind}/commented`, {
          number, body: comment, url: result.data.url,
        });
      }
      json(200, result);
      return true;
    }

    // ---- review writes: explicit, guarded, idempotent -----------------------
    w = path.match(/^\/api\/github\/pr\/(\d+)\/reviews$/);
    if (w && method === "POST") {
      const number = Number(w[1]);
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const event = String(b.event ?? "COMMENT") as "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) {
        json(400, { ok: false, reason: "event must be COMMENT, APPROVE, or REQUEST_CHANGES" });
        return true;
      }
      // approving or requesting changes needs explicit confirmation from the UI
      if (event !== "COMMENT" && b.confirm !== true) {
        json(400, { ok: false, reason: `${event} requires confirm:true` });
        return true;
      }
      const comments = Array.isArray(b.comments) ? (b.comments as ReviewCommentInput[]) : [];
      const result = await deps.github.submitReview(root, {
        number, event, body: String(b.body ?? ""),
        comments,
        ...(b.commitSha ? { commitSha: String(b.commitSha) } : {}),
      });
      // log to the originating session BEFORE the UI (or any agent) sees the result
      if (result.ok && b.sessionId && deps.append) {
        await deps.append(String(b.sessionId), "review/submitted", {
          prNumber: number, reviewId: result.data.id, event,
          ...(b.commitSha ? { commitSha: String(b.commitSha) } : {}),
          commentCount: comments.length,
          body: String(b.body ?? ""),
        });
      }
      json(200, result);
      return true;
    }
    w = path.match(/^\/api\/github\/pr\/(\d+)\/labels$/);
    if (w && method === "POST") {
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const labels = Array.isArray(b.labels) ? (b.labels as string[]).map(String) : [];
      json(200, await deps.github.addLabels(root, Number(w[1]), labels));
      return true;
    }

    // ---- PR lifecycle (F7): create / update / merge / describe ---------------
    if (path === "/api/github/pr/create" && method === "POST") {
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const title = String(b.title ?? "").trim();
      if (!title) { json(400, { ok: false, reason: "title is required" }); return true; }
      const result = await deps.github.prCreate(root, {
        title,
        body: String(b.body ?? ""),
        ...(b.base ? { base: String(b.base) } : {}),
        ...(b.head ? { head: String(b.head) } : {}),
        ...(b.draft === true ? { draft: true } : {}),
      });
      // durable log first: the originating session records the external write
      if (result.ok && b.sessionId && deps.append) {
        await deps.append(String(b.sessionId), "pr/created", {
          prNumber: result.data.number, url: result.data.url, title,
          ...(b.base ? { base: String(b.base) } : {}),
          ...(b.draft === true ? { draft: true } : {}),
        });
      }
      json(200, result);
      return true;
    }

    if (path === "/api/github/pr/update" && method === "POST") {
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const number = Number(b.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const result = await deps.github.prUpdate(root, number, {
        ...(b.title !== undefined ? { title: String(b.title) } : {}),
        ...(b.body !== undefined ? { body: String(b.body) } : {}),
        ...(b.base !== undefined ? { base: String(b.base) } : {}),
      });
      if (result.ok && b.sessionId && deps.append) {
        await deps.append(String(b.sessionId), "pr/updated", {
          prNumber: number,
          fields: ["title", "body", "base"].filter((f) => (b as Record<string, unknown>)[f] !== undefined),
        });
      }
      json(200, result);
      return true;
    }

    if (path === "/api/github/pr/merge" && method === "POST") {
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      const number = Number(b.number ?? 0);
      if (!Number.isSafeInteger(number) || number <= 0) {
        json(400, { ok: false, reason: "a positive PR number is required" });
        return true;
      }
      const strategy = String(b.strategy ?? "") as MergeStrategy;
      if (!MERGE_STRATEGIES.includes(strategy)) {
        json(400, { ok: false, reason: "strategy must be squash, merge, or rebase" });
        return true;
      }
      // destructive remote action — the UI must send an explicit confirmation
      if (b.confirm !== true) {
        json(400, { ok: false, reason: "merge requires confirm:true" });
        return true;
      }
      const result = await deps.github.prMerge(root, number, strategy);
      if (result.ok && b.sessionId && deps.append) {
        await deps.append(String(b.sessionId), "pr/merged", { prNumber: number, strategy });
      }
      json(200, result);
      return true;
    }

    if (path === "/api/github/pr/describe" && method === "POST") {
      const b = await body();
      const root = await rootOf(b.projectId ? String(b.projectId) : null);
      if (!deps.describe) {
        json(200, { ok: false, reason: "AI describe is not available on this server" });
        return true;
      }
      try {
        const draft = await deps.describe(root, b.base ? String(b.base) : undefined);
        json(200, { ok: true, data: draft });
      } catch (e) {
        json(200, { ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    if (method !== "GET") return false;
    const root = await rootOf(url.searchParams.get("projectId"));
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const number = Number(url.searchParams.get("number") ?? 0);

    if (path === "/api/github/status") { json(200, await deps.github.status(root)); return true; }
    if (path === "/api/github/repo") { json(200, await deps.github.repo(root)); return true; }
    if (path === "/api/github/issues") { json(200, await deps.github.issues(root, limit)); return true; }
    if (path === "/api/github/issue") { json(200, await deps.github.getIssue(root, number)); return true; }
    if (path === "/api/github/issue/comments") { json(200, await deps.github.getIssueComments(root, number)); return true; }
    if (path === "/api/github/prs") { json(200, await deps.github.prs(root, limit)); return true; }
    if (path === "/api/github/pr/current") {
      json(200, await deps.github.currentPrSummary(root));
      return true;
    }

    // ---- PR detail surfaces (WP11) ------------------------------------------
    if (path === "/api/github/pr") { json(200, await deps.github.prDetail(root, number)); return true; }
    if (path === "/api/github/pr/files") { json(200, await deps.github.prFiles(root, number)); return true; }
    if (path === "/api/github/pr/checks") {
      const r = await deps.github.prChecks(root, number);
      json(200, r.ok ? { ok: true, data: { checks: r.data, summary: summarizeChecks(r.data) } } : r);
      return true;
    }
    if (path === "/api/github/pr/comments") { json(200, await deps.github.prComments(root, number)); return true; }
    if (path === "/api/github/pr/diff") { json(200, await deps.github.prDiff(root, number)); return true; }

    return false;
  };
}
