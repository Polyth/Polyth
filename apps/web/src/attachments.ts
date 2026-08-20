// F2: pending composer attachments. The per-session draft owns text AND pills:
// pills survive session switches via localStorage and clear together on send.
// Key "" holds the no-session (hero) composer's pills until a session exists.
import { useCallback, useSyncExternalStore } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { api } from "./api.ts";

export const MAX_PENDING_ATTACHMENTS = 16;
const DRAFT_ATT = "polyth.draft.att.";
const EMPTY: AttachmentRef[] = [];

interface Entry { refs: AttachmentRef[]; listeners: Set<() => void> }
const entries = new Map<string, Entry>();

const keyOf = (sessionId: string | null | undefined): string => sessionId ?? "";

function loadPersisted(key: string): AttachmentRef[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(DRAFT_ATT + key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) ? (v as AttachmentRef[]) : [];
  } catch {
    return [];
  }
}

function persist(key: string, refs: AttachmentRef[]): void {
  if (!key) return; // hero composer pills are in-memory only
  try {
    if (refs.length > 0) localStorage.setItem(DRAFT_ATT + key, JSON.stringify(refs));
    else localStorage.removeItem(DRAFT_ATT + key);
  } catch {
    // private mode / quota — best-effort like text drafts
  }
}

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { refs: loadPersisted(key), listeners: new Set() };
    entries.set(key, e);
  }
  return e;
}

function set(key: string, refs: AttachmentRef[]): void {
  const e = entry(key);
  e.refs = refs;
  persist(key, refs);
  for (const l of [...e.listeners]) l();
}

export function pendingAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const e = entry(keyOf(sessionId));
  return e.refs.length > 0 ? e.refs : EMPTY;
}

export function addAttachment(sessionId: string | null | undefined, ref: AttachmentRef): boolean {
  const key = keyOf(sessionId);
  const cur = entry(key).refs;
  if (cur.length >= MAX_PENDING_ATTACHMENTS) return false;
  // dedupe: same file/range or same link is a no-op, not a second pill
  const dup = cur.some((r) =>
    r.kind === "url" || ref.kind === "url"
      ? r.url === ref.url
      : r.path === ref.path && JSON.stringify(r.range ?? null) === JSON.stringify(ref.range ?? null));
  if (dup) return true;
  set(key, [...cur, ref]);
  return true;
}

export function removeAttachment(sessionId: string | null | undefined, id: string): void {
  const key = keyOf(sessionId);
  set(key, entry(key).refs.filter((r) => r.id !== id));
}

export function clearAttachments(sessionId: string | null | undefined): void {
  set(keyOf(sessionId), []);
}

/** Replace a session's pending pills wholesale (marker-owned composer seeds:
 *  rewind/fork drafts restore the excluded prompt's exact attachments). */
export function seedAttachments(sessionId: string | null | undefined, refs: AttachmentRef[]): void {
  set(keyOf(sessionId), refs);
}

/** Read-and-clear for send: the returned refs go on the wire, the pills go away. */
export function takeAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const key = keyOf(sessionId);
  const refs = entry(key).refs;
  if (refs.length > 0) set(key, []);
  return refs;
}

export function usePendingAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const key = keyOf(sessionId);
  const subscribe = useCallback((listener: () => void) => {
    const e = entry(key);
    e.listeners.add(listener);
    return () => e.listeners.delete(listener);
  }, [key]);
  const snapshot = useCallback(() => pendingAttachments(key || null), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ---------------------------------------------------------------- builders

const basename = (p: string): string => p.split("/").pop() || p;

export type AttachResult = { ok: true; ref: AttachmentRef } | { ok: false; reason: string };

/** Stat-verified project-file attachment. Deleted files refuse attachment here
 *  (and again server-side at send time). */
export async function attachProjectFile(
  projectId: string,
  sessionId: string | null | undefined,
  path: string,
  range?: [number, number],
): Promise<AttachResult> {
  // Resolve against the session's worktree so the pill points at the same
  // bytes the agent sees (UX-FIXTURE-VISUAL P0).
  const sid = sessionId ?? undefined;
  let st: { kind: "file" | "dir"; size: number; mime?: string };
  try {
    st = await api.filesStat(projectId, path, sid);
  } catch {
    return { ok: false, reason: `File not found: ${path}` };
  }
  if (st.kind !== "file") return { ok: false, reason: `Not a file: ${path}` };
  const mime = st.mime || "application/octet-stream";
  const ref: AttachmentRef = {
    id: crypto.randomUUID(),
    name: range ? `${basename(path)} (${range[0]}–${range[1]})` : basename(path),
    mime,
    size: st.size,
    kind: range ? "range" : mime.startsWith("image/") ? "image" : "file",
    path,
    url: api.filesRawUrl(projectId, path, sid),
    ...(range ? { range } : {}),
  };
  if (!addAttachment(sessionId, ref)) {
    return { ok: false, reason: `At most ${MAX_PENDING_ATTACHMENTS} attachments per message` };
  }
  return { ok: true, ref };
}

/** Upload a desktop/pasted file into _inbox/, then attach the stored copy. */
export async function attachUpload(
  projectId: string,
  sessionId: string | null | undefined,
  file: File,
): Promise<AttachResult> {
  const safeName = (file.name || "pasted").replace(/[^\w.-]+/g, "_").slice(0, 80) || "pasted";
  const rel = `_inbox/${Date.now().toString(36)}-${safeName}`;
  try {
    await api.filesUpload(projectId, rel, new Uint8Array(await file.arrayBuffer()), sessionId ?? undefined);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return attachProjectFile(projectId, sessionId, rel);
}

// ---------------------------------------------------------------- GitHub URLs

export interface GithubUrlParts {
  owner: string;
  repo: string;
  kind: "pull" | "issues";
  number: number;
  url: string;
}

/** Parse a lone GitHub PR/issue URL. Pure; exported for tests. */
export function parseGithubUrl(text: string): GithubUrlParts | null {
  const t = text.trim();
  const m = t.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/#?].*)?$/);
  if (!m) return null;
  const number = Number(m[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: m[1]!, repo: m[2]!, kind: m[3] as "pull" | "issues", number, url: t };
}

/** True when the pasted URL points at this project's GitHub remote. */
export function githubUrlMatchesRepo(
  parts: GithubUrlParts,
  repo: { owner: string; name: string } | null | undefined,
): boolean {
  if (!repo) return false;
  return repo.owner.toLowerCase() === parts.owner.toLowerCase()
    && repo.name.toLowerCase() === parts.repo.toLowerCase();
}

/** Build the pill for a matching GitHub URL. Link-only: nothing is fetched. */
export function githubUrlRef(parts: GithubUrlParts): AttachmentRef {
  return {
    id: crypto.randomUUID(),
    name: `${parts.kind === "pull" ? "PR" : "Issue"} #${parts.number}`,
    mime: "text/uri-list",
    size: 0,
    kind: "url",
    url: parts.url,
  };
}

/** UX-COMPOSER-DISC: result-bearing link attach shared by the Add-menu dialog
 *  and the paste path. Distinguishes every failure — invalid URL, no detected
 *  repository, repository mismatch, attachment limit, request failure. Only a
 *  matching URL creates the link-only pill; nothing is ever fetched from the
 *  linked issue or pull request. */
export type GithubAttachResult =
  | { ok: true; ref: AttachmentRef }
  | {
      ok: false;
      code: "invalid-url" | "no-repo" | "repo-mismatch" | "limit" | "request-failed";
      reason: string;
    };

/** Pure classification of a link attempt; exported for tests. `repo` is the
 *  probe outcome and `repoKnown` distinguishes "probe failed" from "probe
 *  succeeded but found no GitHub repository". */
export function classifyGithubAttach(
  parts: GithubUrlParts | null,
  probe: { ok: true; repo: { owner: string; name: string } | null } | { ok: false; reason: string },
): { code: "ok" } | { code: "invalid-url" | "no-repo" | "repo-mismatch" | "request-failed"; reason: string } {
  if (!parts) {
    return { code: "invalid-url", reason: "Enter a GitHub issue or pull request URL." };
  }
  if (!probe.ok) {
    return { code: "request-failed", reason: `Couldn’t check the project repository: ${probe.reason}` };
  }
  if (!probe.repo) {
    return { code: "no-repo", reason: "The active project has no detected GitHub repository." };
  }
  if (!githubUrlMatchesRepo(parts, probe.repo)) {
    return {
      code: "repo-mismatch",
      reason: `That link points at ${parts.owner}/${parts.repo}, not this project’s repository (${probe.repo.owner}/${probe.repo.name}).`,
    };
  }
  return { code: "ok" };
}

export async function attachGithubLink(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
): Promise<GithubAttachResult> {
  const parts = parseGithubUrl(text);
  let probe: { ok: true; repo: { owner: string; name: string } | null } | { ok: false; reason: string };
  if (!parts) {
    probe = { ok: true, repo: null }; // unused: invalid URL classifies first
  } else {
    const res = await api.githubRepo(projectId);
    probe = res.ok ? { ok: true, repo: res.data } : { ok: false, reason: res.reason };
  }
  const verdict = classifyGithubAttach(parts, probe);
  if (verdict.code !== "ok") return { ok: false, code: verdict.code, reason: verdict.reason };
  const ref = githubUrlRef(parts!);
  if (!addAttachment(sessionId, ref)) {
    return { ok: false, code: "limit", reason: `At most ${MAX_PENDING_ATTACHMENTS} attachments per message` };
  }
  return { ok: true, ref };
}

/** Paste handler: a lone GitHub PR/issue URL becomes a pill when the repo
 *  matches `/api/github/repo`. Returns true when consumed as a pill; any
 *  non-match falls back to plain text at the caller. */
export async function tryAttachGithubUrl(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
): Promise<boolean> {
  const r = await attachGithubLink(projectId, sessionId, text);
  return r.ok;
}
