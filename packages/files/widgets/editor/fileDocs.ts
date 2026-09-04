// UX-PANE-MODEL: keep-alive file document store, scoped by canonical
// projectId + (sessionId ?? "project"). Buffers, dirty state, and live-file
// revision state survive tab switches, surface switches, presentation
// changes, and session/worktree switches — and one scope's buffers never
// appear in another. This is in-memory only: pane persistence stays
// metadata-only, so an uncommitted buffer is protected by the beforeunload
// warning rather than serialized into preferences.
import type { FileReadResult } from "@polyth/session/web-api";
import { autosaveDelay, type LiveFileState } from "./liveFile.ts";
import { getUiSettings } from "../../../../apps/web/src/uiPrefs.ts";

export interface FileDoc {
  doc: FileReadResult | null;
  buf: string;
  editing: boolean;
  loading: boolean;
  error: string;
  live: LiveFileState | null;
  composing: boolean;
}

/** Canonical scope key: no arbitrary cwd, ever. */
export function docScopeKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "project"}`;
}

const scopes = new Map<string, Map<string, FileDoc>>();
let version = 0;
const listeners = new Set<() => void>();

/** Notify subscribers that some document changed (buffer, live state, …). */
export function bumpDocs(): void {
  version++;
  for (const l of [...listeners]) l();
}

export function subscribeDocs(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function docsVersion(): number {
  return version;
}

function scopeDocs(scope: string): Map<string, FileDoc> {
  let docs = scopes.get(scope);
  if (!docs) {
    docs = new Map();
    scopes.set(scope, docs);
  }
  return docs;
}

export function getDoc(scope: string, path: string): FileDoc | undefined {
  return scopes.get(scope)?.get(path);
}

/** Get-or-create the entry for a path in a scope. */
export function ensureDoc(scope: string, path: string): FileDoc {
  const docs = scopeDocs(scope);
  let entry = docs.get(path);
  if (!entry) {
    entry = { doc: null, buf: "", editing: false, loading: false, error: "", live: null, composing: false };
    docs.set(path, entry);
  }
  return entry;
}

export function deleteDoc(scope: string, path: string): void {
  if (scopes.get(scope)?.delete(path)) bumpDocs();
}

/** Rename/move keeps the buffer (and dirty state) attached to the new path. */
export function moveDoc(scope: string, from: string, to: string): void {
  const docs = scopes.get(scope);
  const entry = docs?.get(from);
  if (!docs || !entry) return;
  docs.delete(from);
  docs.set(to, entry);
  bumpDocs();
}

export function isDocDirty(scope: string, path: string): boolean {
  const entry = scopes.get(scope)?.get(path);
  return !!entry?.doc && entry.buf !== entry.doc.content;
}

/** True when at least one dirty buffer would not be flushed by autosave
 *  (autosaveDelay would return null for its current conditions). */
function anyUnflushedDirtyDoc(): boolean {
  const autosaveOn = getUiSettings().editorAutosave;
  for (const docs of scopes.values()) {
    for (const entry of docs.values()) {
      if (!entry.doc || entry.buf === entry.doc.content) continue;
      if (!entry.live) return true;
      const delay = autosaveDelay(entry.live, {
        enabled: autosaveOn,
        editing: entry.editing,
        composing: entry.composing,
        readOnly: entry.doc.truncated || entry.doc.tooLarge === true,
      });
      if (delay === null) return true;
    }
  }
  return false;
}

// ---- unload guard --------------------------------------------------------------
// While an unsaved buffer exists that autosave will not flush, closing the
// page warns instead of silently dropping the edit. Warn whenever
// autosaveDelay is null for a dirty doc (pref off, not editing, composing,
// read-only, conflict/saving/…), not only when the autosave preference is off.

let unloadGuardInstalled = false;

export function installDocUnloadGuard(): void {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (e) => {
    if (!anyUnflushedDirtyDoc()) return;
    e.preventDefault();
  });
}

/** Test seam: drop every scope's documents. */
export function resetDocsForTest(): void {
  scopes.clear();
}
