// HTTP face of the GitHub plugin. Reads go through the gh CLI and fail soft
// (ok/reason) so missing binary/auth renders honestly. The two write
// operations (submit review, publish labels) are explicit, confirmed actions —
// nothing else on the server may write to GitHub.
import type { JsonObject, ProjectService, SessionEvent } from "@polyth/contracts";
import { summarizeChecks, type GithubService, type ReviewCommentInput } from "@polyth/github";
import type { RouteHandler } from "../http.ts";

export function githubRoutes(deps: {
  projects: ProjectService;
  github: GithubService;
  /** logs review/submitted to the originating session before responding */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
}): RouteHandler {
  const rootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };

  return async ({ path, method, url, json, body }) => {
    if (!path.startsWith("/api/github")) return false;

    // ---- writes: explicit, guarded, idempotent ------------------------------
    let w = path.match(/^\/api\/github\/pr\/(\d+)\/reviews$/);
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

    if (method !== "GET") return false;
    const root = await rootOf(url.searchParams.get("projectId"));
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const number = Number(url.searchParams.get("number") ?? 0);

    if (path === "/api/github/status") { json(200, await deps.github.status(root)); return true; }
    if (path === "/api/github/repo") { json(200, await deps.github.repo(root)); return true; }
    if (path === "/api/github/issues") { json(200, await deps.github.issues(root, limit)); return true; }
    if (path === "/api/github/prs") { json(200, await deps.github.prs(root, limit)); return true; }

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
