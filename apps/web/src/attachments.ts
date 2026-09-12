// F2: pending composer attachments. The per-session draft owns text AND pills:
// pills survive session switches via localStorage and clear together on send.
// Key "" holds the no-session (hero) composer's pills until a session exists.
import { useCallback, useSyncExternalStore } from "react";
import type { AttachmentRef, BrowserContext } from "@polyth/contracts";
import { browserContextMime } from "@polyth/contracts";
import { api, errorCodeOf } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";
import { flushClientPersistence } from "./clientPersistence.ts";
import {
  hydrateScopedDraftRecord,
  loadScopedDraftRecord,
  registerNativeStagedAttachment,
  removeNativeStagedAttachment,
  scopedDraftCacheKey,
  type NativeStagedAttachment,
  updateScopedDraftRecord,
} from "./draftRecord.ts";

export const MAX_PENDING_ATTACHMENTS = 16;
const EMPTY: AttachmentRef[] = [];

/** Browser-compatible UUID for attachment references. Some embedded WebViews
 * expose `crypto` but do not implement `crypto.randomUUID()`. */
export function newAttachmentId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Attachment IDs are local UI references; retain a collision-resistant
  // fallback for older WebViews without Web Crypto.
  return `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Entry { refs: AttachmentRef[]; listeners: Set<() => void> }
const entries = new Map<string, Entry>();
const MAX_ATTACHMENT_ENTRIES = 64;

const keyOf = (sessionId: string | null | undefined): string => scopedDraftCacheKey(sessionId);

function loadPersisted(sessionId: string | null | undefined): AttachmentRef[] {
  return loadScopedDraftRecord(sessionId).attachments;
}

function persist(sessionId: string | null | undefined, refs: AttachmentRef[]): void {
  updateScopedDraftRecord(sessionId, { attachments: refs });
}

function entry(key: string, sessionId: string | null | undefined): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { refs: loadPersisted(sessionId), listeners: new Set() };
  }
  // Map iteration order is the LRU order. Subscribers pin their entry so a
  // mounted composer never observes an eviction during a context switch.
  entries.delete(key);
  entries.set(key, e);
  trimEntries(key);
  return e;
}

function trimEntries(protectedKey?: string): void {
  while (entries.size > MAX_ATTACHMENT_ENTRIES) {
    const stale = [...entries].find(([entryKey, value]) => entryKey !== protectedKey && value.listeners.size === 0)?.[0];
    if (!stale) return;
    entries.delete(stale);
  }
}

/** Test-only boundedness observation; no draft metadata is exposed. */
export const pendingAttachmentEntryCountForTest = (): number => entries.size;

function set(sessionId: string | null | undefined, refs: AttachmentRef[]): void {
  const key = keyOf(sessionId);
  const e = entry(key, sessionId);
  e.refs = refs;
  persist(sessionId, refs);
  for (const l of [...e.listeners]) l();
}

export function pendingAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const e = entry(keyOf(sessionId), sessionId);
  return e.refs.length > 0 ? e.refs : EMPTY;
}

export function addAttachment(sessionId: string | null | undefined, ref: AttachmentRef): boolean {
  const key = keyOf(sessionId);
  const cur = entry(key, sessionId).refs;
  if (cur.length >= MAX_PENDING_ATTACHMENTS) return false;
  // dedupe: same file/range, same link, or same browser context id is a no-op
  const dup = cur.some((r) => {
    if (r.id === ref.id) return true;
    if (r.kind === "browser-context" || ref.kind === "browser-context") {
      return r.kind === "browser-context" && ref.kind === "browser-context" && r.id === ref.id;
    }
    if (r.kind === "url" || ref.kind === "url") return r.url === ref.url;
    return r.path === ref.path && JSON.stringify(r.range ?? null) === JSON.stringify(ref.range ?? null);
  });
  if (dup) return true;
  set(sessionId, [...cur, ref]);
  return true;
}

export function removeAttachment(sessionId: string | null | undefined, id: string): void {
  const key = keyOf(sessionId);
  const refs = entry(key, sessionId).refs;
  const removed = refs.find((r) => r.id === id);
  set(sessionId, refs.filter((r) => r.id !== id));
  discardBrowserArtifacts(removed);
}

/** Best-effort delete of managed capture files when a draft chip is discarded. */
export function discardBrowserArtifacts(ref: AttachmentRef | undefined): void {
  if (!ref || ref.kind !== "browser-context") return;
  const ids = [ref.browserContext?.screenshot?.id, ref.browserContext?.crop?.id]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const artifactId of ids) {
    void fetch(`/api/browser/artifacts?id=${encodeURIComponent(artifactId)}`, { method: "DELETE" }).catch(() => undefined);
  }
}

export function clearAttachments(sessionId: string | null | undefined): void {
  set(sessionId, []);
}

/** Replace a session's pending pills wholesale (marker-owned composer seeds:
 *  rewind/fork drafts restore the excluded prompt's exact attachments). */
export function seedAttachments(sessionId: string | null | undefined, refs: AttachmentRef[]): void {
  set(sessionId, refs);
}

/** Native process-restart hook: hydrate metadata only, never attachment bytes. */
export async function hydratePendingAttachments(sessionId: string | null): Promise<AttachmentRef[]> {
  const refs = (await hydrateScopedDraftRecord(sessionId)).attachments;
  const e = entry(keyOf(sessionId), sessionId);
  e.refs = refs;
  for (const listener of [...e.listeners]) listener();
  return refs;
}

/** Read-and-clear for send: the returned refs go on the wire, the pills go away. */
export function takeAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const key = keyOf(sessionId);
  const refs = entry(key, sessionId).refs;
  if (refs.length > 0) set(sessionId, []);
  return refs;
}

export function usePendingAttachments(sessionId: string | null | undefined): AttachmentRef[] {
  const key = keyOf(sessionId);
  const subscribe = useCallback((listener: () => void) => {
    const e = entry(key, sessionId);
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); trimEntries(); };
  }, [key, sessionId]);
  const snapshot = useCallback(() => pendingAttachments(sessionId), [key, sessionId]);
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
  refId = newAttachmentId(),
  expectedScopeKey = scopedDraftCacheKey(sessionId),
  /** The pill's display name. Uploads store bytes under an id-prefixed
   *  `_inbox/` path; that storage detail is not a name worth showing. */
  displayName = basename(path),
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
    id: refId,
    name: range ? `${displayName} (${range[0]}–${range[1]})` : displayName,
    mime,
    size: st.size,
    kind: range ? "range" : mime.startsWith("image/") ? "image" : "file",
    path,
    url: api.filesRawUrl(projectId, path, sid),
    ...(range ? { range } : {}),
  };
  if (scopedDraftCacheKey(sessionId) !== expectedScopeKey) {
    return { ok: false, reason: "Attachment context changed before completion; the result was not added to another draft." };
  }
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
  const expectedScopeKey = scopedDraftCacheKey(sessionId);
  const safeName = (file.name || "pasted").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "pasted";
  const id = newAttachmentId();
  const rel = `_inbox/${id}-${safeName}`;
  try {
    await api.filesUpload(projectId, rel, new Uint8Array(await file.arrayBuffer()), sessionId ?? undefined);
  } catch (err) {
    // A lost upload response is not permission to choose a new destination.
    // A read-only stat can prove the stable destination already arrived.
    try {
      const existing = await api.filesStat(projectId, rel, sessionId ?? undefined);
      if (existing.kind === "file" && existing.size === file.size) {
        return attachProjectFile(projectId, sessionId, rel, undefined, id, expectedScopeKey, safeName);
      }
      return { ok: false, reason: `${safeName} has a conflicting server copy; it was not uploaded again.` };
    } catch {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return attachProjectFile(projectId, sessionId, rel, undefined, id, expectedScopeKey, safeName);
}

export type NativeStagedSource = Omit<NativeStagedAttachment, "destination">;

/** Recoverable native upload. The scoped draft stores only metadata; bytes
 * stay in app-owned staging and are read under the native bridge's hard cap.
 * Every retry first proves destination absence or reuses an exact-size copy. */
export async function attachNativeStagedUpload(
  projectId: string,
  sessionId: string | null | undefined,
  source: NativeStagedSource,
  native: {
    read(metadata: NativeStagedSource): Promise<File>;
    remove(metadata: Pick<NativeStagedSource, "stagingPath">): Promise<void>;
  },
): Promise<AttachResult> {
  const scopeKey = scopedDraftCacheKey(sessionId);
  let staged: NativeStagedAttachment;
  try {
    staged = registerNativeStagedAttachment(sessionId, source);
    // Process death after this point must leave enough metadata to resume the
    // exact destination without re-picking or generating another upload ID.
    await flushClientPersistence();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const stillCurrent = () => scopedDraftCacheKey(sessionId) === scopeKey;
  const finish = async (): Promise<AttachResult> => {
    if (!stillCurrent()) return { ok: false, reason: "Attachment context changed; the staged copy was retained." };
    const attached = await attachProjectFile(projectId, sessionId, staged.destination, undefined, staged.id, scopeKey, staged.name);
    if (!attached.ok) return attached;
    removeNativeStagedAttachment(sessionId, staged.id);
    // Persist the attachment pill + staged-metadata removal before deleting
    // the only app-owned byte copy. Per-record write ordering keeps this final.
    await flushClientPersistence();
    await native.remove(staged);
    return attached;
  };

  try {
    const existing = await api.filesStat(projectId, staged.destination, sessionId ?? undefined);
    if (existing.kind !== "file" || existing.size !== staged.size) {
      return { ok: false, reason: `${staged.name} has a conflicting server copy; the staged file was retained.` };
    }
    return await finish();
  } catch (error) {
    if (errorCodeOf(error) !== "not-found") {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  if (!stillCurrent()) return { ok: false, reason: "Attachment context changed; the staged copy was retained." };
  let file: File;
  try {
    file = await native.read(source);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    await api.filesUpload(projectId, staged.destination, new Uint8Array(await file.arrayBuffer()), sessionId ?? undefined);
  } catch (uploadError) {
    // Response loss is resolved only by authoritative stat. If absent or the
    // server is unreachable, retain the same metadata/path for restart retry.
    try {
      const existing = await api.filesStat(projectId, staged.destination, sessionId ?? undefined);
      if (existing.kind === "file" && existing.size === staged.size) return await finish();
      return { ok: false, reason: `${staged.name} has a conflicting server copy; the staged file was retained.` };
    } catch {
      return { ok: false, reason: uploadError instanceof Error ? uploadError.message : String(uploadError) };
    }
  }
  return await finish();
}

const nativeRecoveryInFlight = new Map<string, Promise<AttachResult[]>>();

/** Process-restart hook. Sequential reads keep the bounded compatibility
 * allocation to one file, and the same stable destination is reused. */
export function recoverNativeStagedUploads(
  projectId: string,
  sessionId: string | null | undefined,
  native: Parameters<typeof attachNativeStagedUpload>[3],
): Promise<AttachResult[]> {
  const key = scopedDraftCacheKey(sessionId);
  const current = nativeRecoveryInFlight.get(key);
  if (current) return current;
  const run = (async () => {
    const staged = loadScopedDraftRecord(sessionId).nativeStaged ?? [];
    const results: AttachResult[] = [];
    for (const source of staged) {
      if (scopedDraftCacheKey(sessionId) !== key) {
        results.push({ ok: false, reason: "Attachment context changed; remaining staged files were retained." });
        break;
      }
      results.push(await attachNativeStagedUpload(projectId, sessionId, source, native));
    }
    return results;
  })().finally(() => nativeRecoveryInFlight.delete(key));
  nativeRecoveryInFlight.set(key, run);
  return run;
}

export function isLargeTextPaste(text: string): boolean {
  return text.length >= 2000 || text.split("\n").length >= 25;
}

export async function attachText(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
): Promise<AttachResult> {
  return attachUpload(projectId, sessionId, new File([text], "pasted-context.txt", { type: "text/plain" }));
}

function clipChipLabel(value: string, max = 48): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Localized composer chip title. Contracts keep English/model-facing labels. */
export function browserContextChipTitle(ctx: BrowserContext): string {
  if (ctx.type === "text") {
    return clipChipLabel(ctx.quote || "") || tr("attachments.browserText");
  }
  if (ctx.type === "element") {
    return clipChipLabel(ctx.element?.name || ctx.element?.text || ctx.element?.tag || "")
      || tr("attachments.browserElement");
  }
  if (ctx.type === "area") return tr("attachments.browserArea");
  return clipChipLabel(ctx.title || "") || tr("attachments.browserPage");
}

/** Attach a first-class browser context to the composer draft (does not send). */
export function attachBrowserContext(
  sessionId: string | null | undefined,
  ctx: BrowserContext,
): AttachResult {
  const thumbId = ctx.crop?.id ?? ctx.screenshot?.id;
  const ref: AttachmentRef = {
    id: ctx.id,
    name: browserContextChipTitle(ctx),
    mime: browserContextMime(),
    size: ctx.crop?.size ?? ctx.screenshot?.size ?? 0,
    kind: "browser-context",
    browserContext: ctx,
    ...(thumbId ? { url: `/api/browser/artifacts?id=${encodeURIComponent(thumbId)}` } : {}),
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
