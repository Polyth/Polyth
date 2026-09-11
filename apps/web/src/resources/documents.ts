import { errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import type {
  ResourceDocumentHandle,
  ResourceDocumentSnapshot,
  ResourceDocumentStatus,
  ResourceRef,
  ResourceTextSource,
  Unregister,
} from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import { getUiSettings } from "../uiPrefs.ts";
import {
  autosaveDelay,
  beginLiveFileSave,
  checkLiveFile,
  completeLiveFileSave,
  conflictLiveFile,
  dismissLiveFileNotice,
  editLiveFile,
  failLiveFileSave,
  loadedLiveFile,
  restoreLiveFileBuffer,
  type LiveFileState,
} from "./liveFile.ts";
import { getResourceProvider, subscribeProviderUnload } from "./providers.ts";

const AUTOSAVE_MS = 1_500;
/** Every read in this module backs a buffer that `saveSession` can write back,
 *  so it must be the file's complete contents. A preview-sized slice here
 *  would either truncate the save or (as it does for a file past the editable
 *  cap) make the document read-only — never a silent partial write. */
const EDITABLE_READ = { editable: true } as const;

interface Session {
  ref: ResourceRef;
  status: ResourceDocumentStatus;
  saved: string;
  revision?: string;
  truncated: boolean;
  binary: boolean;
  dirty: boolean;
  bufferVersion: number;
  authoritativeGeneration: number;
  composing: boolean;
  editing: boolean;
  error: string;
  live: LiveFileState | null;
  saveCount: number;
  checkpoint: string;
  source: ResourceTextSource | null;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  loading: Promise<void> | null;
  /**
   * Exclusive persistence/lifecycle lane for this document.
   * UI `live.kind` is not this lock. One owner at a time: save, rename,
   * delete, reload, discard, or session dispose.
   */
  persistence: Promise<void> | null;
  closed: boolean;
  /**
   * Internal observation epoch. Advanced when an in-flight read/stat result
   * must not publish. Not `authoritativeGeneration` (that resets EditorState).
   */
  observationEpoch: number;
  /** Monotonic ticket so an older check cannot overwrite a newer one. */
  latestCheckTicket: number;
  listeners: Set<() => void>;
}

const sessions = new Map<string, Session>();
let storeVersion = 0;
const storeListeners = new Set<() => void>();

export interface DocumentEditorBridge {
  onAuthoritativeReset(ref: ResourceRef, text: string, generation: number): void;
  onSavedBaselineAdvanced(ref: ResourceRef, text: string): void;
  onDocumentDeleted(ref: ResourceRef): void;
  onDocumentMoved(from: ResourceRef, to: ResourceRef): void;
}

let editorBridge: DocumentEditorBridge | null = null;

export function registerDocumentEditorBridge(bridge: DocumentEditorBridge): Unregister {
  editorBridge = bridge;
  return () => {
    if (editorBridge === bridge) editorBridge = null;
  };
}

function notifyStore(): void {
  storeVersion++;
  for (const listener of [...storeListeners]) listener();
}

function notify(session: Session, store = true): void {
  for (const listener of [...session.listeners]) listener();
  if (store) notifyStore();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sync try-claim. Null means the lane is busy or the session is gone. */
function claimPersistence(session: Session): (() => void) | null {
  if (session.closed || session.persistence) return null;
  let settled = false;
  let resolve!: () => void;
  session.persistence = new Promise<void>((r) => { resolve = r; });
  return () => {
    if (settled) return;
    settled = true;
    session.persistence = null;
    resolve();
  };
}

/**
 * Wait until the lane is free, then claim it. Rechecks after every waiter
 * resume so another save cannot slip in between wait and the lifecycle op.
 */
async function acquirePersistence(session: Session): Promise<() => void> {
  for (;;) {
    if (session.closed) throw new Error("document closed");
    const release = claimPersistence(session);
    if (release) return release;
    await session.persistence;
  }
}

/** Claim+run synchronously when idle. `run` MUST be synchronous. */
function withPersistenceGate(session: Session, run: () => void): void | Promise<void> {
  const finish = (release: () => void): void => {
    try {
      const result: unknown = run();
      if (result != null && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("withPersistenceGate run must be synchronous");
      }
    } finally {
      release();
    }
  };
  const release = claimPersistence(session);
  if (release) {
    finish(release);
    return;
  }
  return acquirePersistence(session).then((rel) => { finish(rel); });
}

function bumpObservation(session: Session): void {
  session.observationEpoch++;
}

function isCurrentSession(
  session: Session,
  expectedRefKey?: string,
  expectedEpoch?: number,
): boolean {
  if (session.closed) return false;
  if (sessions.get(resourceKey(session.ref)) !== session) return false;
  if (expectedRefKey !== undefined && resourceKey(session.ref) !== expectedRefKey) return false;
  if (expectedEpoch !== undefined && session.observationEpoch !== expectedEpoch) return false;
  return true;
}

function maybeArmAutosave(session: Session): void {
  if (session.closed || !session.dirty || !session.editing || session.composing) return;
  armAutosave(session);
}

function isConflictError(err: unknown): boolean {
  return httpStatusOf(err) === 409 || errorCodeOf(err) === "conflict";
}

function bumpAuthoritative(session: Session, text: string): void {
  session.authoritativeGeneration++;
  session.checkpoint = text;
  editorBridge?.onAuthoritativeReset(session.ref, text, session.authoritativeGeneration);
}

export function documentsVersion(): number {
  return storeVersion;
}

export function subscribeDocuments(listener: () => void): Unregister {
  storeListeners.add(listener);
  return () => { storeListeners.delete(listener); };
}

function getBuffer(session: Session): string {
  return session.source?.getText() ?? session.checkpoint;
}

function snapshotOf(session: Session): ResourceDocumentSnapshot {
  return {
    status: session.status,
    saved: session.saved,
    revision: session.revision,
    dirty: session.dirty,
    readOnly: session.truncated || session.binary,
    truncated: session.truncated,
    binary: session.binary,
    live: session.live
      ? { kind: session.live.kind, noticeDismissed: session.live.noticeDismissed, message: session.live.message }
      : null,
    error: session.error,
    composing: session.composing,
    saveCount: session.saveCount,
    authoritativeGeneration: session.authoritativeGeneration,
  };
}

function clearAutosave(session: Session): void {
  if (session.autosaveTimer === null) return;
  clearTimeout(session.autosaveTimer);
  session.autosaveTimer = null;
}

function armAutosave(session: Session): void {
  clearAutosave(session);
  const delay = autosaveDelay(session.live ?? loadedLiveFile(session.revision), {
    enabled: getUiSettings().editorAutosave,
    editing: session.editing,
    composing: session.composing,
    readOnly: session.truncated || session.binary,
  }, AUTOSAVE_MS);
  if (delay === null) return;
  session.autosaveTimer = setTimeout(() => {
    session.autosaveTimer = null;
    void handle.save();
  }, delay);
  const handle = handleOf(session);
}

function handleOf(session: Session): ResourceDocumentHandle {
  return {
    key: resourceKey(session.ref),
    get ref() { return session.ref; },
    getSnapshot: () => snapshotOf(session),
    subscribe: (listener) => {
      session.listeners.add(listener);
      return () => { session.listeners.delete(listener); };
    },
    getBuffer: () => getBuffer(session),
    attachSource: (source) => {
      if (!isCurrentSession(session)) return null;
      const release = () => {
        if (session.source === source) {
          session.checkpoint = getBuffer(session);
          session.source = null;
        }
      };
      if (session.source === null) {
        session.checkpoint = getBuffer(session);
        session.source = source;
        return release;
      }
      if (session.source === source) return release;
      return null;
    },
    markUserEdit: () => {
      reportUserEdit(session, false);
    },
    reportUserEdit: (equivalentToSaved: boolean) => {
      reportUserEdit(session, equivalentToSaved);
    },
    load: () => loadSession(session),
    setComposing: (composing) => {
      if (!isCurrentSession(session) || session.composing === composing) return;
      session.composing = composing;
      armAutosave(session);
    },
    save: (options) => saveSession(session, options),
    reload: () => reloadSession(session),
    check: () => checkSession(session),
    discard: () => discardSession(session),
    dismissNotice: () => {
      if (!isCurrentSession(session) || !session.live) return;
      session.live = dismissLiveFileNotice(session.live);
      notify(session);
    },
    autosaveDelay: (enabled, delayMs) => autosaveDelay(session.live ?? loadedLiveFile(session.revision), {
      enabled,
      editing: session.editing,
      composing: session.composing,
      readOnly: session.truncated || session.binary,
    }, delayMs),
    moveTo: (ref) => moveSession(session, ref),
  };
}

function runDiscard(session: Session): void {
  session.dirty = false;
  session.bufferVersion++;
  if (session.live) session.live = restoreLiveFileBuffer(session.live);
  bumpObservation(session);
  bumpAuthoritative(session, session.saved);
  clearAutosave(session);
  notify(session);
}

function discardSession(session: Session): void | Promise<void> {
  if (session.closed) return;
  return withPersistenceGate(session, () => {
    if (!session.closed) runDiscard(session);
  });
}

function reportUserEdit(session: Session, equivalentToSaved: boolean): void {
  if (session.closed || !isCurrentSession(session)) return;
  const wasDirty = session.dirty;
  session.bufferVersion++;
  if (equivalentToSaved) {
    if (!wasDirty) return;
    session.dirty = false;
    if (session.live) session.live = restoreLiveFileBuffer(session.live);
    clearAutosave(session);
    notify(session);
    return;
  }
  session.dirty = true;
  if (session.live) session.live = editLiveFile(session.live);
  armAutosave(session);
  if (!wasDirty) notify(session);
}

async function loadSession(session: Session): Promise<void> {
  if (session.closed || session.status === "ready") return;
  if (session.loading) return session.loading;
  const refKey = resourceKey(session.ref);
  const epoch = session.observationEpoch;
  const readRef = session.ref;
  const run = (async () => {
    const provider = getResourceProvider(readRef.scheme);
    if (!provider) {
      if (!isCurrentSession(session, refKey, epoch)) return;
      session.status = "error";
      session.error = `No provider for ${readRef.scheme}`;
      notify(session);
      return;
    }
    if (!isCurrentSession(session, refKey, epoch)) return;
    session.status = "loading";
    notify(session);
    try {
      const got = await provider.read(readRef, EDITABLE_READ);
      if (!isCurrentSession(session, refKey, epoch)) return;
      session.saved = got.content;
      session.checkpoint = got.content;
      session.revision = got.revision;
      session.truncated = got.truncated === true;
      session.binary = got.binary === true || got.tooLarge === true;
      session.live = loadedLiveFile(got.revision);
      session.status = "ready";
      session.error = "";
      session.dirty = false;
      session.bufferVersion++;
      bumpObservation(session);
      bumpAuthoritative(session, got.content);
      notify(session);
    } catch (err) {
      if (!isCurrentSession(session, refKey, epoch)) return;
      session.status = "error";
      session.error = msg(err);
      notify(session);
    }
  })();
  session.loading = run;
  try {
    await run;
  } finally {
    if (session.loading === run) session.loading = null;
  }
}

async function saveSession(session: Session, options: { force?: boolean } = {}): Promise<void> {
  const provider = getResourceProvider(session.ref.scheme);
  if (!provider?.write || session.truncated || session.binary || session.closed) return;
  const release = claimPersistence(session);
  if (!release) return;
  const refKey = resourceKey(session.ref);
  const writeRef = session.ref;
  const content = getBuffer(session);
  session.live = beginLiveFileSave(session.live ?? loadedLiveFile(session.revision));
  try {
    notify(session);
    try {
      const base = options.force ? undefined : session.revision;
      const res = await provider.write(writeRef, content, base);
      if (!isCurrentSession(session, refKey)) return;
      const current = getBuffer(session);
      const stillDirty = current !== content;
      session.saved = content;
      session.revision = res.revision;
      session.live = completeLiveFileSave(session.live, res.revision ?? session.revision ?? "", stillDirty);
      session.dirty = stillDirty;
      session.error = "";
      session.saveCount++;
      bumpObservation(session);
      editorBridge?.onSavedBaselineAdvanced(session.ref, content);
      if (stillDirty) armAutosave(session);
      else clearAutosave(session);
    } catch (err) {
      if (!isCurrentSession(session, refKey)) return;
      if (isConflictError(err)) {
        session.live = conflictLiveFile(session.live ?? loadedLiveFile(session.revision));
      } else {
        session.error = msg(err);
        session.live = failLiveFileSave(session.live ?? loadedLiveFile(session.revision));
      }
      bumpObservation(session);
    }
    if (isCurrentSession(session, refKey)) notify(session);
  } finally {
    release();
  }
}

async function reloadSession(session: Session): Promise<void> {
  if (session.closed) return;
  const provider = getResourceProvider(session.ref.scheme);
  if (!provider) return;
  const release = await acquirePersistence(session);
  try {
    if (!isCurrentSession(session)) return;
    const refKey = resourceKey(session.ref);
    const epoch = session.observationEpoch;
    const readRef = session.ref;
    try {
      const got = await provider.read(readRef, EDITABLE_READ);
      if (!isCurrentSession(session, refKey, epoch)) return;
      session.saved = got.content;
      session.checkpoint = got.content;
      session.revision = got.revision;
      session.truncated = got.truncated === true;
      session.binary = got.binary === true || got.tooLarge === true;
      session.live = loadedLiveFile(got.revision);
      session.dirty = false;
      session.error = "";
      session.status = "ready";
      session.bufferVersion++;
      bumpObservation(session);
      bumpAuthoritative(session, got.content);
      clearAutosave(session);
    } catch (err) {
      if (!isCurrentSession(session, refKey, epoch)) return;
      session.error = msg(err);
    }
    if (isCurrentSession(session, refKey)) notify(session);
  } finally {
    release();
  }
}

async function checkSession(session: Session): Promise<void> {
  if (!isCurrentSession(session) || !session.live) return;
  const provider = getResourceProvider(session.ref.scheme);
  if (!provider?.stat) return;
  const refKey = resourceKey(session.ref);
  const epoch = session.observationEpoch;
  const ticket = ++session.latestCheckTicket;
  const statRef = session.ref;
  try {
    const stat = await provider.stat(statRef);
    if (!isCurrentSession(session, refKey, epoch) || session.latestCheckTicket !== ticket || !session.live) return;
    session.live = checkLiveFile(session.live, stat.kind === "missing"
      ? { kind: "deleted" }
      : { kind: "present", revision: stat.revision });
  } catch (err) {
    if (!isCurrentSession(session, refKey, epoch) || session.latestCheckTicket !== ticket || !session.live) return;
    session.live = httpStatusOf(err) === 404
      ? checkLiveFile(session.live, { kind: "deleted" })
      : checkLiveFile(session.live, { kind: "failed", message: msg(err) });
  }
  if (isCurrentSession(session, refKey, epoch) && session.latestCheckTicket === ticket) notify(session);
}

function applyMove(session: Session, to: ResourceRef): void {
  const fromKey = resourceKey(session.ref);
  const toKey = resourceKey(to);
  if (fromKey === toKey) return;
  const from = session.ref;
  session.checkpoint = getBuffer(session);
  session.source = null;
  sessions.delete(fromKey);
  session.ref = to;
  sessions.set(toKey, session);
  bumpObservation(session);
  editorBridge?.onDocumentMoved(from, to);
  notify(session);
  if (session.status !== "ready") {
    session.loading = null;
    session.status = "idle";
    void loadSession(session);
  }
}

function moveSession(session: Session, to: ResourceRef): void | Promise<void> {
  if (session.closed) return;
  return withPersistenceGate(session, () => {
    if (session.closed) return;
    applyMove(session, to);
    maybeArmAutosave(session);
  });
}

function dropSession(session: Session): void {
  if (session.closed) return;
  session.closed = true;
  bumpObservation(session);
  clearAutosave(session);
  sessions.delete(resourceKey(session.ref));
  editorBridge?.onDocumentDeleted(session.ref);
  notifyStore();
}

function ensureSession(ref: ResourceRef): Session {
  const key = resourceKey(ref);
  let session = sessions.get(key);
  if (!session) {
    session = {
      ref,
      status: "idle",
      saved: "",
      truncated: false,
      binary: false,
      dirty: false,
      bufferVersion: 0,
      authoritativeGeneration: 0,
      composing: false,
      editing: true,
      error: "",
      live: null,
      saveCount: 0,
      checkpoint: "",
      source: null,
      autosaveTimer: null,
      loading: null,
      persistence: null,
      closed: false,
      observationEpoch: 0,
      latestCheckTicket: 0,
      listeners: new Set(),
    };
    sessions.set(key, session);
  }
  return session;
}

export function openDocument(ref: ResourceRef): ResourceDocumentHandle {
  const session = ensureSession(ref);
  const handle = handleOf(session);
  if (session.status === "idle") void handle.load();
  return handle;
}

export function peekDocument(ref: ResourceRef): ResourceDocumentHandle | null {
  const session = sessions.get(resourceKey(ref));
  return session ? handleOf(session) : null;
}

export function isDocumentDirty(ref: ResourceRef): boolean {
  const session = sessions.get(resourceKey(ref));
  if (!session || session.closed) return false;
  return session.dirty === true || session.persistence != null;
}

export function setDocumentEditing(ref: ResourceRef, editing: boolean): void {
  const session = sessions.get(resourceKey(ref));
  if (!session || session.editing === editing) return;
  session.editing = editing;
  armAutosave(session);
  notify(session);
}

export function isDocumentEditing(ref: ResourceRef): boolean {
  return sessions.get(resourceKey(ref))?.editing !== false;
}

export function deleteDocument(ref: ResourceRef): void | Promise<void> {
  const session = sessions.get(resourceKey(ref));
  if (!session || session.closed) return;
  return withPersistenceGate(session, () => {
    dropSession(session);
  });
}

/** Physical rename + identity move under exclusive persistence ownership. */
export async function renameDocument(from: ResourceRef, toLocator: string): Promise<void> {
  const session = sessions.get(resourceKey(from));
  if (!session || session.closed) throw new Error("document closed");
  const release = await acquirePersistence(session);
  try {
    if (session.closed) throw new Error("document closed");
    const provider = getResourceProvider(session.ref.scheme);
    if (!provider?.rename) throw new Error("Rename is not supported");
    const next = await provider.rename(session.ref, toLocator);
    if (!isCurrentSession(session)) throw new Error("document closed");
    applyMove(session, next);
    maybeArmAutosave(session);
  } finally {
    release();
  }
}

/** Physical delete + session drop under exclusive persistence ownership. */
export async function removeDocument(ref: ResourceRef): Promise<void> {
  const session = sessions.get(resourceKey(ref));
  if (!session || session.closed) return;
  const release = await acquirePersistence(session);
  try {
    if (session.closed) return;
    const provider = getResourceProvider(session.ref.scheme);
    if (!provider?.remove) throw new Error("Delete is not supported");
    await provider.remove(session.ref);
    if (!isCurrentSession(session)) return;
    dropSession(session);
  } finally {
    release();
  }
}

export function anyUnflushedDirty(): boolean {
  const autosaveOn = getUiSettings().editorAutosave;
  for (const session of sessions.values()) {
    if (session.persistence) return true;
    if (!session.dirty) continue;
    const delay = autosaveDelay(session.live ?? loadedLiveFile(session.revision), {
      enabled: autosaveOn,
      editing: session.editing,
      composing: session.composing,
      readOnly: session.truncated || session.binary,
    });
    if (delay === null) return true;
  }
  return false;
}

let unloadGuardInstalled = false;

export function installDocumentUnloadGuard(): void {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (e) => {
    if (!anyUnflushedDirty()) return;
    e.preventDefault();
  });
}

export function resetDocumentsForTest(): void {
  for (const session of sessions.values()) {
    session.closed = true;
    clearAutosave(session);
  }
  sessions.clear();
  storeVersion = 0;
}

subscribeProviderUnload((scheme) => {
  for (const session of sessions.values()) {
    if (session.closed || session.ref.scheme !== scheme) continue;
    bumpObservation(session);
    if (session.persistence) continue;
    if (session.dirty) {
      session.status = "error";
      session.error = "Provider unavailable";
      notify(session);
      continue;
    }
    if (session.status === "ready" || session.status === "loading") {
      session.status = "error";
      session.error = "Provider unavailable";
      notify(session);
    }
  }
});

export function documentSessionCount(): number {
  return sessions.size;
}

export function fileRef(projectId: string, sessionId: string | null, path: string): ResourceRef {
  return { scheme: "file", locator: path, projectId, sessionId };
}
