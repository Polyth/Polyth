// F2: pending composer attachments. The per-session draft owns text AND pills:
// pills survive session switches via localStorage and clear together on send.
// Key "" holds the no-session (hero) composer's pills until a session exists.
import { useCallback, useSyncExternalStore } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";

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
    return { ok: false, reason: tr("attachments.fileNotFoundValue", { path }) };
  }
  if (st.kind !== "file") {
    return { ok: false, reason: tr("attachments.notAFileValue", { path }) };
  }
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
    return {
      ok: false,
      reason: tr("attachments.atMostValueAttachmentsPerMessage", {
        count: MAX_PENDING_ATTACHMENTS,
      }),
    };
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
