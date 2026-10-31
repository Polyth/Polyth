import type { HostingResult, HostingService, HostingStatus, ChangeRequestDetail } from "@polyth/code-hosting/types";
import { mapRepository, mapIssue, mapChangeRequest, mapNote, mapThread, mapDiffFiles, mapDiffText, mapPipelineJob } from "./mappers.ts";

/** Account and repository are already bound by the scoped route owner. */
export interface GitlabResourceClient {
  request<T = unknown>(path: string, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: Record<string, unknown> }): Promise<T>;
}
const invalid = (reason: string) => Object.assign(new Error(reason), { code: "invalid-input" });
const id = (n: number) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw invalid("A positive resource number is required.");
  return String(n);
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("GitLab returned an invalid object.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max = 100_000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw invalid(`${label} is required and must be valid text.`);
  return value;
};
const ref = (value: string): string => {
  if (value.length > 255 || !/^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u.test(value) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)/.test(value)) throw invalid("Invalid branch name.");
  return value;
};
const thread = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid("Invalid discussion identifier.");
  return value;
};
const DRAFT = /^\s*(?:draft:|\[draft\]|\(draft\)|wip:)\s*/i;
export const GITLAB_CAPABILITIES: NonNullable<HostingStatus["capabilities"]> = {
  mergeStrategies: ["merge", "squash"], reviewEvents: ["COMMENT", "APPROVE"],
  ready: true, unapprove: true, discussions: true, reply: true, resolve: true,
};

export function createGitlabService(deps: {
  client: GitlabResourceClient;
  projectPath: string;
  instance: string;
  user: { login: string; avatarUrl: string };
  currentBranch?: (cwd: string) => Promise<string>;
}): HostingService {
  if (deps.projectPath.split("/").length < 2 || deps.projectPath.split("/").some(p => !p || p === "." || p === "..") || /[\0?#\\]/.test(deps.projectPath)) throw invalid("Invalid project path.");
  const project = `projects/${encodeURIComponent(deps.projectPath)}`;
  const mr = (number: number) => `${project}/merge_requests/${id(number)}`;
  const issue = (number: number) => `${project}/issues/${id(number)}`;
  const web = `${deps.instance}/${deps.projectPath}`;
  const api = deps.client;
  const safe = async <T>(operation: () => Promise<T>): Promise<HostingResult<T>> => {
    try { return { ok: true, data: await operation() }; }
    catch (error) {
      // Client diagnostics are deliberately sanitized; do not serialize raw responses.
      const e = error as { code?: string; outcome?: "unknown"; message?: string };
      return { ok: false, reason: e.message ?? "GitLab request failed.", ...(e.code ? { code: e.code } : {}), ...(e.outcome ? { outcome: e.outcome } : {}) };
    }
  };
  const list = async (path: string, limit = 100): Promise<unknown[]> => {
    const rows: unknown[] = [];
    const count = Math.min(1000, Math.max(1, Math.floor(limit) || 30));
    const size = Math.min(100, count);
    for (let page = 1; rows.length < count; page++) {
      const batch = await api.request<unknown>(`${path}${path.includes("?") ? "&" : "?"}per_page=${size}&page=${page}`);
      if (!Array.isArray(batch)) throw invalid("GitLab returned an invalid list.");
      rows.push(...batch.slice(0, count - rows.length));
      if (batch.length < size) break;
    }
    return rows;
  };
  const detail = async (number: number) => mapChangeRequest(await api.request(mr(number)));
  const diffs = (number: number) => list(`${mr(number)}/diffs`, 1000);
  const filters = (value?: { state?: string; search?: string }) => {
    const state = value?.state === "open" ? "opened" : value?.state ?? "opened";
    if (!["opened", "closed", "merged", "all"].includes(state)) throw invalid("Invalid issue or merge request state.");
    const params = new URLSearchParams({ state, scope: "all", order_by: "updated_at", sort: "desc" });
    if (value?.search) params.set("search", text(value.search, "Search", 500));
    return params.toString();
  };
  const comment = async (path: string, body: string, fallback: string) => {
    const note = mapNote(await api.request(`${path}/notes`, { method: "POST", body: { body: text(body, "Comment") } }), fallback);
    return { url: note.url };
  };
  const changeDetail = async (number: number): Promise<ChangeRequestDetail> => {
    const result = await detail(number);
    // Diff limits or an unavailable enrichment must not hide the authoritative MR.
    try {
      const files = mapDiffFiles(await diffs(number));
      result.changedFiles = Math.max(result.changedFiles, files.length);
      result.additions = files.reduce((n, f) => n + f.additions, 0);
      result.deletions = files.reduce((n, f) => n + f.deletions, 0);
    } catch { /* detail remains usable */ }
    return result;
  };
  return {
    status: async () => {
      const repository = await safe(async () => mapRepository(await api.request(project)));
      return { installed: true, authenticated: repository.ok, user: deps.user, repo: repository.ok ? repository.data : null, capabilities: GITLAB_CAPABILITIES, access: { readRepository: "git-transport", pushRepository: "git-transport", readApi: repository.ok ? "available" : "denied", writeIssues: "unknown", writeChanges: "unknown", review: "unknown" }, ...(!repository.ok ? { reason: repository.reason } : {}) };
    },
    repo: () => safe(async () => mapRepository(await api.request(project))),
    issues: (_cwd, limit, filter) => safe(async () => (await list(`${project}/issues?${filters(filter)}`, limit)).map(mapIssue)),
    getIssue: (_cwd, number) => safe(async () => mapIssue(await api.request(issue(number)))),
    getIssueComments: (_cwd, number) => safe(async () => (await list(`${issue(number)}/notes?sort=asc`, 1000)).filter(n => record(n).system !== true).map(n => mapNote(n, `${web}/-/issues/${number}`))),
    addIssueComment: (_cwd, number, body) => safe(() => comment(issue(number), body, `${web}/-/issues/${number}`)),
    prs: (_cwd, limit, filter) => safe(async () => (await list(`${project}/merge_requests?${filters(filter)}`, limit)).map(mapChangeRequest)),
    prDetail: (_cwd, number) => safe(() => changeDetail(number)),
    currentPrSummary: cwd => safe(async () => {
      if (!deps.currentBranch) throw invalid("Current branch is unavailable.");
      const branch = ref((await deps.currentBranch(cwd)).trim());
      const rows = await list(`${project}/merge_requests?state=opened&scope=all&source_branch=${encodeURIComponent(branch)}`, 100);
      const match = rows.map(mapChangeRequest).find(row => row.headRefName === branch);
      if (!match) throw Object.assign(new Error("No merge request for the current branch."), { code: "not-found" });
      return changeDetail(match.number);
    }),
    prFiles: (_cwd, number) => safe(async () => mapDiffFiles(await diffs(number))),
    prDiff: (_cwd, number) => safe(async () => {
      const rows = await diffs(number);
      if (rows.length === 1000 || rows.some(row => record(row).too_large === true || record(row).collapsed === true)) {
        throw Object.assign(new Error("GitLab limited this patch. Open the merge request on GitLab to inspect all changes."), { code: "diff-limited" });
      }
      return mapDiffText(rows);
    }),
    prChecks: (_cwd, number) => safe(async () => {
      const raw = record(await api.request(mr(number)));
      if (!raw.head_pipeline) return [];
      const pipeline = record(raw.head_pipeline);
      const pipelineId = id(Number(pipeline.id));
      const pipelineProject = id(Number(pipeline.project_id ?? raw.target_project_id));
      const summary = mapPipelineJob({ ...pipeline, name: `Pipeline #${pipelineId}` });
      try { return (await list(`projects/${pipelineProject}/pipelines/${pipelineId}/jobs`, 1000)).map(job => mapPipelineJob(job, summary.name)); }
      catch { return [{ ...summary, summary: `${summary.summary ?? ""} · Job details unavailable` }]; }
    }),
    prComments: (_cwd, number) => safe(async () => (await list(`${mr(number)}/discussions`, 1000)).flatMap(raw => mapThread(raw, `${web}/-/merge_requests/${number}`).comments)),
    discussions: (_cwd, number) => safe(async () => (await list(`${mr(number)}/discussions`, 1000)).map(raw => mapThread(raw, `${web}/-/merge_requests/${number}`))),
    addPrComment: (_cwd, number, body) => safe(() => comment(mr(number), body, `${web}/-/merge_requests/${number}`)),
    reply: (_cwd, number, threadId, body) => safe(() => comment(`${mr(number)}/discussions/${thread(threadId)}`, body, `${web}/-/merge_requests/${number}`)),
    resolve: (_cwd, number, threadId, resolved) => safe(async () => {
      if (typeof resolved !== "boolean") throw invalid("Resolved state must be boolean.");
      await api.request(`${mr(number)}/discussions/${thread(threadId)}`, { method: "PUT", body: { resolved } });
      return { resolved };
    }),
    ready: (_cwd, number) => safe(async () => {
      // GitLab's documented quick action marks the current MR ready without a
      // stale read/modify/write of its title.
      await api.request(`${mr(number)}/notes`, { method: "POST", body: { body: "/ready" } });
      try {
        if ((await detail(number)).isDraft) throw new Error();
      } catch {
        throw Object.assign(new Error("GitLab did not confirm that this merge request is ready. Refresh it before another action."), { code: "ready-unconfirmed", outcome: "unknown" });
      }
      return { number };
    }),
    unapprove: (_cwd, number) => safe(async () => {
      await api.request(`${mr(number)}/unapprove`, { method: "POST" });
      return { number };
    }),
    submitReview: (_cwd, input) => safe(async () => {
      if (!["COMMENT", "APPROVE"].includes(input.event)) throw Object.assign(new Error("GitLab does not support this review operation."), { code: "unsupported-operation" });
      const current = await detail(input.number);
      if (!input.commitSha || input.commitSha !== current.headRefOid) throw Object.assign(new Error("Merge request changed. Refresh before reviewing."), { code: "stale-state" });
      const comments = input.comments ?? [];
      // Validate every comment before publishing any of the batch.
      const positions = comments.map(c => {
        text(c.body, "Comment"); text(c.path, "File path", 4096);
        if (!Number.isSafeInteger(c.line) || c.line < 1 || c.path.startsWith("/") || c.path.split("/").includes("..") || (c.side !== undefined && !["LEFT", "RIGHT"].includes(c.side))) throw invalid("Invalid review position.");
        if (c.startLine !== undefined) throw Object.assign(new Error("Multi-line review comments are not supported."), { code: "unsupported-operation" });
        const refs = current.diffRefs;
        if (!refs?.base || !refs.start || !refs.head) throw invalid("Merge request diff references are unavailable.");
        return { position_type: "text", base_sha: refs.base, start_sha: refs.start, head_sha: refs.head, old_path: c.oldPath ?? c.path, new_path: c.path, [c.side === "LEFT" ? "old_line" : "new_line"]: c.line };
      });
      if (input.event === "COMMENT" && !comments.length && !input.body.trim()) throw invalid("A review comment is required.");
      let published = false;
      try {
        for (let i = 0; i < comments.length; i++) {
          await api.request(`${mr(input.number)}/discussions`, { method: "POST", body: { body: comments[i]!.body, position: positions[i] } });
          published = true;
        }
        if (input.body.trim()) { await comment(mr(input.number), input.body, current.url); published = true; }
        if (input.event === "APPROVE") await api.request(`${mr(input.number)}/approve`, { method: "POST", body: { sha: input.commitSha } });
      } catch (error) {
        if (published) throw Object.assign(new Error("Part of the review was published. Inspect GitLab before continuing."), { code: "partial-review", outcome: "unknown" });
        throw error;
      }
      return { id: `${input.number}:${input.commitSha}:${input.event}`, url: current.url };
    }),
    addLabels: (_cwd, number, labels) => safe(async () => {
      if (!labels.length || labels.length > 30 || labels.some(v => typeof v !== "string" || !v.trim() || v.length > 255 || /[,\0]/.test(v))) throw invalid("Invalid labels.");
      const result = record(await api.request(mr(number), { method: "PUT", body: { add_labels: labels.join(",") } }));
      return { labels: Array.isArray(result.labels) ? result.labels.map(String) : labels };
    }),
    prCreate: (cwd, input) => safe(async () => {
      const title = text(input.title, "Title", 255);
      const head = ref(input.head ?? (deps.currentBranch ? (await deps.currentBranch(cwd)).trim() : ""));
      const repository = record(await api.request(project));
      const upstream = repository.forked_from_project ? record(repository.forked_from_project) : undefined;
      const targetProject = upstream ? id(Number(upstream.id)) : undefined;
      const target = targetProject ? record(await api.request(`projects/${targetProject}`)) : repository;
      const base = ref(input.base ?? String(target.default_branch ?? ""));
      const result = mapChangeRequest(await api.request(`${project}/merge_requests`, { method: "POST", body: { title: input.draft && !DRAFT.test(title) ? `Draft: ${title}` : title, description: input.body, source_branch: head, target_branch: base, ...(targetProject ? { target_project_id: Number(targetProject) } : {}) } }));
      return { number: result.number, url: result.url };
    }),
    prUpdate: (_cwd, number, patch) => safe(async () => {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = text(patch.title, "Title", 255);
      if (patch.body !== undefined) { if (patch.body.length > 100_000) throw invalid("Description is too long."); body.description = patch.body; }
      if (patch.base !== undefined) body.target_branch = ref(patch.base);
      if (!Object.keys(body).length) throw invalid("No fields to update.");
      await api.request(mr(number), { method: "PUT", body });
      return { number };
    }),
    prMerge: (_cwd, number, strategy, expectedHead) => safe(async () => {
      if (strategy !== "merge" && strategy !== "squash") throw Object.assign(new Error("GitLab supports merge and squash, not atomic rebase merge."), { code: "unsupported-operation" });
      const current = await detail(number);
      if (!expectedHead || expectedHead !== current.headRefOid) throw Object.assign(new Error("Merge request changed. Refresh before merging."), { code: "stale-state" });
      if (current.isDraft || current.state !== "OPEN" || current.mergeable === "CONFLICTING") throw invalid("Merge request is not ready to merge.");
      await api.request(`${mr(number)}/merge`, { method: "PUT", body: { sha: text(current.headRefOid, "Head SHA", 64), squash: strategy === "squash", should_remove_source_branch: false } });
      return { number, strategy };
    }),
  };
}
