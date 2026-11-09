// The browser's copy of a person's bookmarks, per project: one shared list every
// button, panel and bar reads. It refreshes after each change, when the window
// comes back, when the project changes, and on a slow timer, so another device's
// change arrives without a push channel. Saved text loads when it is opened.
import { useEffect, useSyncExternalStore } from "react";
import { createApiTransport, type Unregister, type WebPackageHost } from "@polyth/web-sdk";
import { compareBookmarks, type BookmarkKind, type BookmarkPatch, type BookmarkView } from "../src/bookmarks.ts";

const api = createApiTransport();
const PATH = "/api/bookmarks";
const POLL_MS = 60_000;

export interface ProjectBookmarks {
  loaded: boolean;
  bookmarks: readonly BookmarkView[];
  error: unknown;
}

export interface BookmarkWalk {
  sessionId: string;
  activeId: string;
}

interface State {
  projects: ReadonlyMap<string, ProjectBookmarks>;
  bySession: ReadonlyMap<string, readonly BookmarkView[]>;
  walk: BookmarkWalk | null;
}

const NO_BOOKMARKS: readonly BookmarkView[] = [];
const NOT_LOADED: ProjectBookmarks = { loaded: false, bookmarks: NO_BOOKMARKS, error: null };

let state: State = { projects: new Map(), bySession: new Map(), walk: null };
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();
const queued = new Set<string>();
const requested = new Set<string>();
// A list asked for before a change finished may not contain that change.
const generations = new Map<string, number>();
const bodies = new Map<string, { revision: number; body: string }>();

const emit = () => { for (const listener of listeners) listener(); };

const subscribe = (listener: () => void): Unregister => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function indexSessions(projects: ReadonlyMap<string, ProjectBookmarks>): ReadonlyMap<string, readonly BookmarkView[]> {
  const bySession = new Map<string, BookmarkView[]>();
  for (const project of projects.values()) {
    for (const bookmark of project.bookmarks) {
      if (!bookmark.sessionId) continue;
      const list = bySession.get(bookmark.sessionId);
      if (list) list.push(bookmark);
      else bySession.set(bookmark.sessionId, [bookmark]);
    }
  }
  return bySession;
}

function setProject(projectId: string, next: ProjectBookmarks): void {
  const projects = new Map(state.projects);
  projects.set(projectId, next);
  const bySession = indexSessions(projects);
  // A walk ends once the bookmark it stands on is gone.
  const walk = state.walk && (bySession.get(state.walk.sessionId) ?? NO_BOOKMARKS).some((entry) => entry.id === state.walk!.activeId)
    ? state.walk
    : null;
  state = { projects, bySession, walk };
  emit();
}

const projectOf = (projectId: string): ProjectBookmarks => state.projects.get(projectId) ?? NOT_LOADED;
const bumpGeneration = (projectId: string) => generations.set(projectId, (generations.get(projectId) ?? 0) + 1);

export function refreshBookmarks(projectId: string): Promise<void> {
  const running = inflight.get(projectId);
  if (running) {
    queued.add(projectId);
    return running;
  }
  const generation = generations.get(projectId) ?? 0;
  const request = api.get<{ bookmarks: BookmarkView[] }>(`${PATH}?projectId=${encodeURIComponent(projectId)}`)
    .then((snapshot) => {
      if ((generations.get(projectId) ?? 0) !== generation) {
        queued.add(projectId);
        return;
      }
      setProject(projectId, { loaded: true, bookmarks: snapshot.bookmarks, error: null });
    }, (error: unknown) => {
      setProject(projectId, { ...projectOf(projectId), error });
    })
    .finally(() => {
      inflight.delete(projectId);
      if (queued.delete(projectId)) void refreshBookmarks(projectId);
    });
  inflight.set(projectId, request);
  return request;
}

/** Load a project's list once; refreshes keep it current afterwards. */
export function ensureBookmarks(projectId: string): void {
  if (requested.has(projectId)) return;
  requested.add(projectId);
  void refreshBookmarks(projectId);
}

function placeLocally(bookmark: BookmarkView): void {
  const project = projectOf(bookmark.projectId);
  const others = project.bookmarks.filter((entry) => entry.id !== bookmark.id);
  setProject(bookmark.projectId, {
    ...project,
    loaded: true,
    bookmarks: [...others, bookmark].sort(compareBookmarks),
  });
}

function removeLocally(bookmark: BookmarkView): void {
  const project = projectOf(bookmark.projectId);
  setProject(bookmark.projectId, { ...project, bookmarks: project.bookmarks.filter((entry) => entry.id !== bookmark.id) });
}

export interface SaveBookmarkInput {
  kind: BookmarkKind;
  sessionId?: string;
  projectId?: string;
  eventSeq?: number;
  title?: string;
  body: string;
  note?: string;
  quote?: string;
  createdAt?: number;
}

export async function saveBookmark(input: SaveBookmarkInput): Promise<BookmarkView> {
  const { bookmark } = await api.post<{ bookmark: BookmarkView }>(PATH, input);
  bumpGeneration(bookmark.projectId);
  bodies.set(bookmark.id, { revision: bookmark.revision, body: input.body });
  placeLocally(bookmark);
  return bookmark;
}

export interface RemovedBookmark {
  removed: BookmarkView;
  body: string;
}

export async function removeBookmark(id: string): Promise<RemovedBookmark> {
  const result = await api.post<RemovedBookmark>(`${PATH}/delete`, { id });
  bumpGeneration(result.removed.projectId);
  bodies.delete(id);
  removeLocally(result.removed);
  return result;
}

/** Undo of a removal: the same text at the same place, under the old date. */
export function restoreBookmark({ removed, body }: RemovedBookmark): Promise<BookmarkView> {
  return saveBookmark({
    kind: removed.kind,
    ...(removed.sessionId ? { sessionId: removed.sessionId } : { projectId: removed.projectId }),
    ...(removed.eventSeq !== undefined ? { eventSeq: removed.eventSeq } : {}),
    title: removed.title,
    body,
    ...(removed.note ? { note: removed.note } : {}),
    ...(removed.quote ? { quote: removed.quote } : {}),
    createdAt: removed.createdAt,
  });
}

export async function updateBookmark(bookmark: BookmarkView, patch: BookmarkPatch): Promise<BookmarkView> {
  const { bookmark: next } = await api.post<{ bookmark: BookmarkView }>(`${PATH}/update`, {
    ...patch,
    id: bookmark.id,
    revision: bookmark.revision,
  });
  bumpGeneration(next.projectId);
  const cached = bodies.get(next.id);
  const body = patch.body ?? cached?.body;
  if (body !== undefined) bodies.set(next.id, { revision: next.revision, body });
  placeLocally(next);
  return next;
}

export async function readBookmarkBody(bookmark: Pick<BookmarkView, "id" | "revision">): Promise<string> {
  const cached = bodies.get(bookmark.id);
  if (cached?.revision === bookmark.revision) return cached.body;
  const result = await api.get<{ revision: number; body: string }>(`${PATH}/body?id=${encodeURIComponent(bookmark.id)}`);
  bodies.set(bookmark.id, { revision: result.revision, body: result.body });
  return result.body;
}

export function exportBookmarks(scope: { projectId: string; sessionId?: string }): Promise<{ fileName: string; markdown: string }> {
  const query = new URLSearchParams({ projectId: scope.projectId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) });
  return api.get(`${PATH}/export?${query}`);
}

// ---- a walk through one chat's bookmarks -------------------------------------

export const placesOf = (bookmarks: readonly BookmarkView[]): BookmarkView[] =>
  bookmarks.filter((bookmark) => bookmark.chat === "open" && bookmark.eventSeq !== undefined);

export function setBookmarkWalk(walk: BookmarkWalk | null): void {
  if (state.walk?.sessionId === walk?.sessionId && state.walk?.activeId === walk?.activeId) return;
  state = { ...state, walk };
  emit();
}

// ---- reading -----------------------------------------------------------------

export const getSessionBookmarks = (sessionId: string): readonly BookmarkView[] => state.bySession.get(sessionId) ?? NO_BOOKMARKS;

export const getAnswerBookmark = (sessionId: string, eventSeq: number): BookmarkView | undefined =>
  getSessionBookmarks(sessionId).find((bookmark) => bookmark.kind === "answer" && bookmark.eventSeq === eventSeq);

export function getBookmark(id: string): BookmarkView | undefined {
  for (const project of state.projects.values()) {
    const found = project.bookmarks.find((bookmark) => bookmark.id === id);
    if (found) return found;
  }
  return undefined;
}

export const subscribeBookmarks = subscribe;

export function useProjectBookmarks(projectId: string | null | undefined): ProjectBookmarks {
  useEffect(() => { if (projectId) ensureBookmarks(projectId); }, [projectId]);
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? projectOf(projectId) : NOT_LOADED),
    () => NOT_LOADED,
  );
}

export function useSessionBookmarks(sessionId: string | null | undefined): readonly BookmarkView[] {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? getSessionBookmarks(sessionId) : NO_BOOKMARKS),
    () => NO_BOOKMARKS,
  );
}

/** A footer reads one answer's bookmark; a list change elsewhere keeps it still. */
export function useAnswerBookmark(sessionId: string | null, eventSeq: number | null): BookmarkView | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId && eventSeq !== null ? getAnswerBookmark(sessionId, eventSeq) : undefined),
    () => undefined,
  );
}

export function useBookmarkWalk(): BookmarkWalk | null {
  return useSyncExternalStore(subscribe, () => state.walk, () => null);
}

/** Keep the active project's list current while the package is active. */
export function connectBookmarks(host: WebPackageHost): Unregister {
  const activeProject = () => host.store.getSnapshot().activeProjectId;
  let project = activeProject();
  if (project) ensureBookmarks(project);
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const refreshActive = () => {
    const current = activeProject();
    if (current && visible()) void refreshBookmarks(current);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", refreshActive);
  const timer = setInterval(refreshActive, POLL_MS);
  const offStore = host.store.subscribe(() => {
    const current = activeProject();
    if (current === project) return;
    project = current;
    if (current) void refreshBookmarks(current);
  });
  return () => {
    clearInterval(timer);
    offStore();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshActive);
  };
}

/** Test seam: forget everything cached. */
export function resetBookmarksState(): void {
  state = { projects: new Map(), bySession: new Map(), walk: null };
  inflight.clear();
  queued.clear();
  requested.clear();
  generations.clear();
  bodies.clear();
  emit();
}
