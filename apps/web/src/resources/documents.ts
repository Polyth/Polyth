import { httpStatusOf } from "@polyth/session/web-api";
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
  listeners: Set<() => void>;
}

const sessions = new Map<string, Session>();
let storeVersion = 0;
const storeListeners = new Set<() => void>();

export interface DocumentEditorBridge {
  onAuthoritativeReset(ref: ResourceRef, text: string, generation: number): void;
  onSavedClean(ref: ResourceRef, text: string): void;
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

function bumpAuthoritative(session: Session, text: string): void {
  session.authoritativeGeneration++;
  session.checkpoint = text;
  session.source?.resetAuthoritative(text);
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
    bufferVersion: session.bufferVersion,
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
      if (session.source !== null && session.source !== source) return;
      session.checkpoint = getBuffer(session);
      session.source = source;
    },
    detachSource: () => {
      session.checkpoint = getBuffer(session);
      session.source = null;
    },
    markUserEdit: () => {
      reportUserEdit(session, false);
    },
    reportUserEdit: (equivalentToSaved: boolean) => {
      reportUserEdit(session, equivalentToSaved);
    },
    load: () => loadSession(session),
    setComposing: (composing) => {
      if (session.composing === composing) return;
      session.composing = composing;
      armAutosave(session);
    },
    save: (options) => saveSession(session, options),
    reload: () => reloadSession(session),
    check: () => checkSession(session),
    discard: () => {
      session.saved = session.saved;
      session.dirty = false;
      session.bufferVersion++;
      if (session.live) session.live = restoreLiveFileBuffer(session.live);
      bumpAuthoritative(session, session.saved);
      clearAutosave(session);
      notify(session);
    },
    dismissNotice: () => {
      if (!session.live) return;
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

function reportUserEdit(session: Session, equivalentToSaved: boolean): void {
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
  if (session.status === "ready") return;
  if (session.loading) return session.loading;
  const run = (async () => {
    const provider = getResourceProvider(session.ref.scheme);
    if (!provider) {
      session.status = "error";
      session.error = `No provider for ${session.ref.scheme}`;
      notify(session);
      return;
    }
    session.status = "loading";
    notify(session);
    try {
      const got = await provider.read(session.ref);
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
      bumpAuthoritative(session, got.content);
    } catch (err) {
      session.status = "error";
      session.error = msg(err);
    }
    notify(session);
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
  if (!provider?.write || session.truncated || session.binary) return;
  if (session.live?.kind === "saving") return;
  const content = getBuffer(session);
  session.live = beginLiveFileSave(session.live ?? loadedLiveFile(session.revision));
  notify(session);
  try {
    const base = options.force ? undefined : session.revision;
    const res = await provider.write(session.ref, content, base);
    const current = getBuffer(session);
    const stillDirty = current !== content;
    session.saved = content;
    session.revision = res.revision;
    session.live = completeLiveFileSave(session.live, res.revision ?? session.revision ?? "", stillDirty);
    session.dirty = stillDirty;
    session.error = "";
    session.saveCount++;
    if (stillDirty) armAutosave(session);
    else {
      clearAutosave(session);
      editorBridge?.onSavedClean(session.ref, content);
    }
  } catch (err) {
    if (httpStatusOf(err) === 409) {
      session.live = conflictLiveFile(session.live ?? loadedLiveFile(session.revision));
    } else {
      session.error = msg(err);
      session.live = failLiveFileSave(session.live ?? loadedLiveFile(session.revision));
    }
  }
  notify(session);
}

async function reloadSession(session: Session): Promise<void> {
  const provider = getResourceProvider(session.ref.scheme);
  if (!provider) return;
  try {
    const got = await provider.read(session.ref);
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
    bumpAuthoritative(session, got.content);
    clearAutosave(session);
  } catch (err) {
    session.error = msg(err);
  }
  notify(session);
}

async function checkSession(session: Session): Promise<void> {
  const provider = getResourceProvider(session.ref.scheme);
  if (!provider?.stat || !session.live) return;
  try {
    const stat = await provider.stat(session.ref);
    session.live = checkLiveFile(session.live, stat.kind === "missing"
      ? { kind: "deleted" }
      : { kind: "present", revision: stat.revision });
  } catch (err) {
    session.live = httpStatusOf(err) === 404
      ? checkLiveFile(session.live, { kind: "deleted" })
      : checkLiveFile(session.live, { kind: "failed", message: msg(err) });
  }
  notify(session);
}

function moveSession(session: Session, to: ResourceRef): void {
  const fromKey = resourceKey(session.ref);
  const toKey = resourceKey(to);
  if (fromKey === toKey) return;
  const from = session.ref;
  sessions.delete(fromKey);
  session.ref = to;
  sessions.set(toKey, session);
  editorBridge?.onDocumentMoved(from, to);
  notify(session);
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
  return sessions.get(resourceKey(ref))?.dirty === true;
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

export function deleteDocument(ref: ResourceRef): void {
  const key = resourceKey(ref);
  const session = sessions.get(key);
  if (!session) return;
  clearAutosave(session);
  sessions.delete(key);
  editorBridge?.onDocumentDeleted(ref);
  notifyStore();
}

function anyUnflushedDirty(): boolean {
  const autosaveOn = getUiSettings().editorAutosave;
  for (const session of sessions.values()) {
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
  for (const session of sessions.values()) clearAutosave(session);
  sessions.clear();
  storeVersion = 0;
}

subscribeProviderUnload((scheme) => {
  for (const session of sessions.values()) {
    if (session.ref.scheme !== scheme) continue;
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
