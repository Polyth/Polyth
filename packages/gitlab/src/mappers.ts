import type { PrCheck } from "@polyth/contracts";
import type {
  ChangeRequestComment,
  ChangeRequestDetail,
  ChangeRequestFile,
  HostingIssue,
  HostingIssueDetail,
  HostingRepository,
  ReviewThread,
} from "@polyth/code-hosting/types";

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const requiredNumber = (value: unknown, label: string): number => {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`GitLab response has an invalid ${label}.`);
  return result;
};
const safeUrl = (value: unknown, fallback = ""): string => {
  const result = string(value, fallback);
  if (!result) return "";
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
  } catch { throw new Error("GitLab response has an unsafe URL."); }
  return result;
};
const date = (value: unknown): string => string(value);
const user = (value: unknown): string => {
  const row = object(value);
  return string(row.username, string(row.name));
};
const listStrings = (value: unknown): string[] => Array.isArray(value)
  ? value.map((item) => typeof item === "string" ? item : string(object(item).name)).filter(Boolean)
  : [];
const users = (value: unknown): string[] => Array.isArray(value) ? value.map(user).filter(Boolean) : [];
const state = (value: unknown): string => {
  const raw = string(value).toLowerCase();
  return raw === "opened" ? "OPEN" : raw === "merged" ? "MERGED" : raw === "closed" ? "CLOSED" : raw.toUpperCase();
};

export function mapRepository(raw: unknown): HostingRepository {
  const row = object(raw);
  const namespace = object(row.namespace);
  const fullPath = string(row.path_with_namespace, string(namespace.full_path));
  const url = string(row.web_url);
  let instance: string | undefined;
  try { if (url) instance = new URL(url).origin; } catch { /* malformed optional URL stays absent */ }
  return {
    name: string(row.name, fullPath.split("/").pop() ?? ""),
    owner: string(namespace.full_path, fullPath.split("/")[0] ?? string(namespace.name)),
    url: safeUrl(url),
    description: string(row.description),
    defaultBranch: string(row.default_branch),
    isPrivate: string(row.visibility).toLowerCase() !== "public",
    ...(["public", "internal", "private"].includes(string(row.visibility)) ? { visibility: row.visibility as "public" | "internal" | "private" } : {}),
    provider: "gitlab",
    ...(instance ? { instance } : {}),
    ...(fullPath ? { fullPath } : {}),
    ...(safeUrl(object(row.forked_from_project).web_url) ? { upstream: safeUrl(object(row.forked_from_project).web_url) } : {}),
  };
}

function issueFields(row: JsonRecord): HostingIssue {
  const title = string(row.title);
  if (!title.trim()) throw new Error("GitLab response has an invalid title.");
  return {
    number: requiredNumber(row.iid, "IID"),
    title,
    state: state(row.state),
    author: user(row.author),
    updatedAt: date(row.updated_at),
    url: safeUrl(row.web_url),
    ...(typeof row.description === "string" ? { body: row.description } : {}),
    ...(listStrings(row.labels).length ? { labels: listStrings(row.labels) } : {}),
    ...(users(row.assignees).length ? { assignees: users(row.assignees) } : {}),
  };
}

export function mapIssue(raw: unknown): HostingIssueDetail {
  const row = object(raw);
  const base = issueFields(row);
  return { ...base, body: string(row.description), createdAt: date(row.created_at) };
}

export function mapChangeRequest(raw: unknown): ChangeRequestDetail {
  const row = object(raw);
  const diff = object(row.diff_refs);
  const sourceProject = row.source_project_id !== undefined ? String(row.source_project_id) : undefined;
  const targetProject = row.target_project_id !== undefined ? String(row.target_project_id) : undefined;
  const headRefOid = string(row.sha, string(diff.head_sha));
  const baseRefName = string(row.target_branch);
  const status = string(row.detailed_merge_status, string(row.merge_status));
  const mergeable = status === "conflict" || row.has_conflicts === true ? "CONFLICTING" : status === "mergeable" || status === "can_be_merged" ? "MERGEABLE" : status.toUpperCase() || "UNKNOWN";
  const base = issueFields(row);
  return {
    ...base,
    isDraft: row.draft === true || row.work_in_progress === true,
    headRefName: string(row.source_branch),
    ...(sourceProject ? { sourceProject } : {}),
    ...(targetProject ? { targetProject } : {}),
    baseRefName,
    headRefOid,
    diffRefs: {
      ...(string(diff.base_sha) ? { base: string(diff.base_sha) } : {}),
      ...(string(diff.head_sha) ? { head: string(diff.head_sha) } : {}),
      ...(string(diff.start_sha) ? { start: string(diff.start_sha) } : {}),
    },
    body: string(row.description),
    createdAt: date(row.created_at),
    additions: number(row.additions),
    deletions: number(row.deletions),
    changedFiles: number(row.changes_count),
    mergeable,
  };
}

export function mapNote(raw: unknown, fallbackUrl: string): ChangeRequestComment {
  const row = object(raw);
  const position = object(row.position);
  const hasPosition = Object.keys(position).length > 0;
  const id = String(row.id ?? "");
  if (!id) throw new Error("GitLab response has an invalid note ID.");
  return {
    id,
    author: user(row.author),
    body: string(row.body),
    createdAt: date(row.created_at),
    url: safeUrl(row.url, fallbackUrl),
    ...(string(row.discussion_id) ? { threadId: string(row.discussion_id) } : {}),
    ...(row.noteable_id !== undefined ? { replyToId: String(row.noteable_id) } : {}),
    ...(hasPosition ? { kind: "review" as const } : { kind: "issue" as const }),
    ...(string(position.new_path, string(position.old_path)) ? { path: string(position.new_path, string(position.old_path)) } : {}),
    ...(typeof position.new_line === "number" || typeof position.old_line === "number" ? { line: number(position.new_line, number(position.old_line)) } : {}),
    ...(row.resolvable === true ? { resolved: row.resolved === true } : {}),
  };
}

export function mapThread(raw: unknown, fallbackUrl: string): ReviewThread {
  const row = object(raw);
  const notes = Array.isArray(row.notes) ? row.notes : [];
  const comments = notes.map((note) => mapNote({ ...object(note), discussion_id: string(row.id) }, fallbackUrl));
  const root = object(notes[0]);
  return {
    id: string(row.id),
    resolved: root.resolvable === true && root.resolved === true,
    resolvable: root.resolvable === true || comments.some((comment) => comment.resolved !== undefined),
    comments,
  };
}

export function mapDiffFiles(raw: unknown[]): ChangeRequestFile[] {
  return raw.map((value) => {
    const row = object(value);
    const diff = string(row.diff);
    const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return { path: string(row.new_path, string(row.old_path)), additions, deletions };
  }).filter((file) => file.path.length > 0);
}

export function mapDiffText(raw: unknown[]): string {
  const quote = (path: string): string => /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
  return raw.map((value) => {
    const row = object(value);
    const oldPath = string(row.old_path, string(row.new_path));
    const newPath = string(row.new_path, string(row.old_path));
    if (!oldPath && !newPath) return "";
    const oldHeader = row.new_file === true ? "/dev/null" : `a/${oldPath}`;
    const newHeader = row.deleted_file === true ? "/dev/null" : `b/${newPath}`;
    const lines = [`diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${newPath}`)}`];
    if (row.renamed_file === true && oldPath !== newPath) {
      lines.push(`rename from ${quote(oldPath)}`, `rename to ${quote(newPath)}`);
    }
    lines.push(`--- ${row.new_file === true ? "/dev/null" : quote(oldHeader)}`, `+++ ${row.deleted_file === true ? "/dev/null" : quote(newHeader)}`);
    const diff = string(row.diff);
    if (diff) lines.push(diff);
    return lines.join("\n");
  }).filter(Boolean).join("\n");
}

export function mapPipelineJob(raw: unknown, workflow?: string): PrCheck {
  const row = object(raw);
  const rawStatus = string(row.status, "unknown").toLowerCase();
  const status: PrCheck["status"] = ["created", "pending", "manual", "scheduled"].includes(rawStatus)
    ? (rawStatus === "manual" ? "action_required" : "queued")
    : rawStatus === "running" ? "in_progress"
      : rawStatus === "success" ? "success"
        : rawStatus === "failed" ? "failure"
          : rawStatus === "canceled" || rawStatus === "cancelled" ? "cancelled"
            : rawStatus === "skipped" ? "skipped" : "neutral";
  const duration = typeof row.duration === "number" && Number.isFinite(row.duration) ? ` · ${row.duration}s` : "";
  return {
    id: String(row.id ?? row.name ?? "job"),
    name: string(row.name, "GitLab job"),
    status,
    ...(workflow ? { workflow } : {}),
    ...(string(row.started_at) ? { startedAt: string(row.started_at) } : {}),
    ...(string(row.finished_at) ? { completedAt: string(row.finished_at) } : {}),
    ...(string(row.web_url) ? { url: safeUrl(row.web_url) } : {}),
    summary: `${rawStatus}${duration}`,
  };
}
