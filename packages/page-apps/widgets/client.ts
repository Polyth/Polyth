// The browser's copy of a person's apps: one shared list the panel and the
// save button read. It refreshes after each change and when the window comes
// back, so an app saved or removed on another device arrives without a push
// channel. A page and its stored data load when the app is opened.
import { useEffect, useSyncExternalStore } from "react";
import { createApiTransport, type Unregister } from "@polyth/web-sdk";
import { compareApps, type AppSource, type AppView, type SaveOutcome } from "../src/apps.ts";

const api = createApiTransport();
const PATH = "/api/page-apps";
/** Changes a page makes in a burst travel as one request. */
const STORE_DELAY_MS = 400;
/** A request that must outlive the page can only carry this much. */
const KEEPALIVE_MAX_BYTES = 48 * 1024;

export interface AppsState {
  loaded: boolean;
  apps: readonly AppView[];
  error: unknown;
}

export interface OpenedApp {
  app: AppView;
  html: string;
  storage: Record<string, string>;
}

let state: AppsState = { loaded: false, apps: [], error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
// A list asked for before a change finished may not contain that change.
let generation = 0;

const emit = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void): Unregister => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const set = (next: AppsState) => { state = next; emit(); };

const withApp = (apps: readonly AppView[], app: AppView): AppView[] =>
  [...apps.filter((item) => item.id !== app.id), app].sort(compareApps);

export function refreshApps(): Promise<void> {
  if (inflight) return inflight;
  const asked = generation;
  const run = api.get<{ apps: AppView[] }>(PATH).then(
    (reply) => { if (asked === generation) set({ loaded: true, apps: [...reply.apps].sort(compareApps), error: null }); },
    (error: unknown) => { if (asked === generation) set({ ...state, loaded: true, error }); },
  ).finally(() => {
    inflight = null;
    // A change landed while this list was on its way: ask again.
    if (asked !== generation) void refreshApps();
  });
  inflight = run;
  return run;
}

const changed = (apps: AppView[]): void => {
  generation += 1;
  set({ loaded: true, apps, error: null });
};

export function getApps(): AppsState {
  return state;
}

export function useApps(): AppsState {
  const snapshot = useSyncExternalStore(subscribe, getApps, getApps);
  useEffect(() => { if (!state.loaded) void refreshApps(); }, []);
  return snapshot;
}

/** Refresh when the window comes back: another device may have changed the list. */
export function connectApps(): Unregister {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const onVisible = () => { if (document.visibilityState === "visible" && state.loaded) void refreshApps(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}

export async function saveApp(input: { title: string; html: string; source?: AppSource }): Promise<{ app: AppView; outcome: SaveOutcome }> {
  const reply = await api.post<{ app: AppView; outcome: SaveOutcome }>(PATH, input);
  changed(withApp(state.apps, reply.app));
  return reply;
}

export async function renameApp(id: string, title: string): Promise<AppView> {
  const reply = await api.post<{ app: AppView }>(`${PATH}/update`, { id, title });
  changed(withApp(state.apps, reply.app));
  return reply.app;
}

export async function removeApp(id: string): Promise<void> {
  await api.post(`${PATH}/delete`, { id });
  changed(state.apps.filter((app) => app.id !== id));
}

export function openApp(id: string): Promise<OpenedApp> {
  return api.get<OpenedApp>(`${PATH}/app?id=${encodeURIComponent(id)}`);
}

export const isMissing = (cause: unknown): boolean => (cause as { status?: unknown } | null)?.status === 404;

// ---- what a running app stores ---------------------------------------------

export type StorageChange =
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string }
  | { op: "clear" };

export interface StorageWriter {
  /** The map as the page last left it: what a reloaded page starts with. */
  values(): Record<string, string>;
  push(change: StorageChange): void;
  /** Send what is pending now (the window is going away). */
  flush(): void;
  /** Send what is pending and wait until the server has it (or refused it),
   *  so a page loaded next starts from what this one stored. */
  drain(): Promise<void>;
  dispose(): void;
}

type Post = (body: unknown, keepalive: boolean) => Promise<unknown>;

/** Keeps one app's stored map: mirrors every change at once, and sends the
 *  changes of a burst as one request, one request at a time. A refused or
 *  failed write is reported once per failure; the mirror keeps the value for
 *  this window, so the page does not lose it while it stays open. */
export function createStorageWriter(
  id: string,
  initial: Readonly<Record<string, string>>,
  onError: (cause: unknown) => void,
  post: Post = (body, keepalive) => api.post(`${PATH}/storage`, body, keepalive ? { keepalive: true } : undefined),
): StorageWriter {
  let mirror: Record<string, string> = { ...initial };
  let pending: { clear: boolean; remove: Set<string>; set: Map<string, string> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<unknown> = Promise.resolve();
  let live = true;

  const send = (keepalive: boolean): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const batch = pending;
    if (!batch) return;
    pending = null;
    const body = {
      id,
      ...(batch.clear ? { clear: true } : {}),
      ...(batch.remove.size > 0 ? { remove: [...batch.remove] } : {}),
      ...(batch.set.size > 0 ? { set: Object.fromEntries(batch.set) } : {}),
    };
    const small = keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX_BYTES;
    sending = sending.then(() => post(body, small)).catch((cause: unknown) => { if (live) onError(cause); });
  };

  return {
    values: () => ({ ...mirror }),
    push(change) {
      if (!live) return;
      pending ??= { clear: false, remove: new Set(), set: new Map() };
      if (change.op === "clear") {
        mirror = {};
        pending = { clear: true, remove: new Set(), set: new Map() };
      } else if (change.op === "remove") {
        delete mirror[change.key];
        pending.set.delete(change.key);
        pending.remove.add(change.key);
      } else {
        mirror[change.key] = change.value;
        pending.remove.delete(change.key);
        pending.set.set(change.key, change.value);
      }
      if (timer === null) timer = setTimeout(() => send(false), STORE_DELAY_MS);
    },
    flush: () => send(true),
    drain: () => { send(false); return sending.then(() => undefined); },
    dispose() {
      send(true);
      live = false;
    },
  };
}
