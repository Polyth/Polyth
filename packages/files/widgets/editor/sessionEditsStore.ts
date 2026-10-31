/** The Files surface's shared view of "which chat changed what" per checkout.
 *
 * EditorView (the coordinator) builds each repository's CheckoutEdits from the
 * viewing chat's live render model and the server's session-edits route and
 * publishes it here; file panes, tab markers and the review bar read it. It
 * is presentation state only: nothing here is persisted except the hunks the
 * person chose to Keep.
 */
import { useSyncExternalStore } from "react";
import type { PaneScope, PaneTabMarker } from "../../../../apps/web/src/workspace/paneProviders.ts";
import { workspacePresentationKey } from "../../../../apps/web/src/store.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { sessionToneColor, type CheckoutEdits, type CheckoutFile, type CheckoutSession } from "./checkoutEdits.ts";

export interface PublishedCheckout {
  edits: CheckoutEdits;
  /** The viewing chat's edited files (existing, oldest edit first): IDE tabs. */
  viewerFiles: readonly string[];
}

const checkouts = new Map<string, PublishedCheckout>();
const listeners = new Set<() => void>();
let version = 0;

export function checkoutScopeKey(projectId: string, sessionId: string | null, repositoryId: string | undefined): string {
  return JSON.stringify([projectId, sessionId ?? null, repositoryId ?? "primary"]);
}

function notify(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function subscribeCheckoutEdits(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const checkoutEditsVersion = (): number => version;

/** Publish (or with `null` withdraw) one checkout under each of its scope keys. */
export function publishCheckoutEdits(keys: readonly string[], value: PublishedCheckout | null): void {
  let changed = false;
  for (const key of keys) {
    if (value === null) changed = checkouts.delete(key) || changed;
    else if (checkouts.get(key) !== value) {
      checkouts.set(key, value);
      changed = true;
    }
  }
  if (changed) notify();
}

export function peekCheckout(key: string): PublishedCheckout | undefined {
  return checkouts.get(key);
}

export function resetCheckoutEditsForTest(): void {
  checkouts.clear();
  kept.clear();
  notify();
}

/** Label of a chat in legends and tooltips. */
export function sessionLabel(session: Pick<CheckoutSession, "viewer" | "title">): string {
  return session.viewer ? tr("files.changes.thisChat") : session.title.trim() || tr("files.changes.untitledChat");
}

export function changedByLabel(sessions: readonly Pick<CheckoutSession, "viewer" | "title">[]): string {
  return tr("files.changes.changedBy", { names: sessions.map(sessionLabel).join(", ") });
}

export interface CheckoutFileView {
  file: CheckoutFile | undefined;
  sessions: readonly CheckoutSession[];
  viewerFiles: readonly string[];
}

const EMPTY_VIEW: CheckoutFileView = { file: undefined, sessions: [], viewerFiles: [] };

export function checkoutFileView(key: string, path: string): CheckoutFileView {
  const published = checkouts.get(key);
  if (!published) return EMPTY_VIEW;
  return { file: published.edits.files.get(path), sessions: published.edits.sessions, viewerFiles: published.viewerFiles };
}

/** The file's entry plus the checkout's chats; stable while nothing changed. */
export function useCheckoutFile(key: string, path: string): CheckoutFileView {
  const published = useSyncExternalStore(subscribeCheckoutEdits, () => checkouts.get(key), () => undefined);
  if (!published) return EMPTY_VIEW;
  return { file: published.edits.files.get(path), sessions: published.edits.sessions, viewerFiles: published.viewerFiles };
}

/** Tab status mark: one dot per chat that changed the file. */
export function checkoutTabMarker(scope: PaneScope, path: string): PaneTabMarker | null {
  const published = checkouts.get(checkoutScopeKey(scope.projectId, scope.sessionId, scope.repositoryId));
  const file = published?.edits.files.get(path);
  if (!published || !file || file.sessions.length === 0) return null;
  const sessions = file.sessions
    .map((id) => published.edits.sessions.find((session) => session.sessionId === id))
    .filter((session): session is CheckoutSession => session !== undefined);
  if (sessions.length === 0) return null;
  return { tones: sessions.map((session) => sessionToneColor(session.tone)), label: changedByLabel(sessions) };
}

// ---- kept (accepted) hunks --------------------------------------------------
// "Keep" hides a reviewed change until Git shows a different hunk there. The
// record is device presentation state, scoped like the other Files records.

const MAX_KEPT = 400;
const kept = new Map<string, string[]>();

function keptStorageKey(projectId: string, sessionId: string | null): string {
  return workspacePresentationKey("files.kept-changes", projectId, sessionId);
}

function readKept(projectId: string, sessionId: string | null): string[] {
  const key = keptStorageKey(projectId, sessionId);
  const cached = kept.get(key);
  if (cached) return cached;
  let value: string[] = [];
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (Array.isArray(parsed)) value = parsed.filter((entry): entry is string => typeof entry === "string").slice(-MAX_KEPT);
  } catch { /* storage is optional */ }
  kept.set(key, value);
  return value;
}

const keptEntry = (repositoryId: string | undefined, path: string, digest: string): string =>
  JSON.stringify([repositoryId ?? "primary", path, digest]);

export function keptHunks(projectId: string, sessionId: string | null, repositoryId: string | undefined, path: string): ReadonlySet<string> {
  const prefix = JSON.stringify([repositoryId ?? "primary", path]).slice(0, -1);
  const result = new Set<string>();
  for (const entry of readKept(projectId, sessionId)) {
    if (!entry.startsWith(`${prefix},`)) continue;
    try {
      const digest = (JSON.parse(entry) as unknown[])[2];
      if (typeof digest === "string") result.add(digest);
    } catch { /* ignore a malformed entry */ }
  }
  return result;
}

export function keepHunks(projectId: string, sessionId: string | null, repositoryId: string | undefined, path: string, digests: readonly string[]): void {
  if (digests.length === 0) return;
  const key = keptStorageKey(projectId, sessionId);
  const current = readKept(projectId, sessionId);
  const added = digests.map((digest) => keptEntry(repositoryId, path, digest)).filter((entry) => !current.includes(entry));
  if (added.length === 0) return;
  const next = [...current, ...added].slice(-MAX_KEPT);
  kept.set(key, next);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage is optional */ }
  notify();
}
