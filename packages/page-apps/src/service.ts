// One person's apps in one Space.
//
//   <person storage>/spaces/<spaceId>/apps/<id>/app.json      the record
//   <person storage>/spaces/<spaceId>/apps/<id>/page.html     the page
//   <person storage>/spaces/<spaceId>/apps/<id>/storage.json  what the page stored
//
// The page is only ever returned as text to the person who saved it and shown
// in a sandboxed frame; no route serves it as a document of this origin.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { cleanPageStorage, pageByteLength } from "@polyth/chat-blocks/page";
import {
  APP_LIMITS,
  appHtml,
  appId,
  appSource,
  appTitle,
  applyStorageChange,
  compareApps,
  conflict,
  isAppId,
  notFound,
  parseAppView,
  parseStorageChange,
  sourceKey,
  type AppView,
  type SaveOutcome,
} from "./apps.ts";

export interface PageAppsDeps {
  /** A path inside the caller's own storage for this Space; throws when the
   *  caller is not a signed-in person. */
  path(space: SpaceContext, relative: string): string;
  now?(): number;
  newId?(): string;
}

export interface PageAppsService {
  list(space: SpaceContext): Promise<{ apps: AppView[] }>;
  open(space: SpaceContext, id: unknown): Promise<{ app: AppView; html: string; storage: Record<string, string> }>;
  save(space: SpaceContext, raw: Record<string, unknown>): Promise<{ app: AppView; outcome: SaveOutcome }>;
  rename(space: SpaceContext, id: unknown, title: unknown): Promise<{ app: AppView }>;
  remove(space: SpaceContext, id: unknown): Promise<{ removed: AppView }>;
  store(space: SpaceContext, id: unknown, raw: unknown): Promise<{ keys: number }>;
}

const APPS_DIR = "apps";
const recordFile = (id: string): string => join(APPS_DIR, id, "app.json");
const pageFile = (id: string): string => join(APPS_DIR, id, "page.html");
const storageFile = (id: string): string => join(APPS_DIR, id, "storage.json");

const missing = (cause: unknown): boolean => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export function createPageAppsService(deps: PageAppsDeps): PageAppsService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  // One writer per person and Space in this process.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(space: SpaceContext, run: () => T | Promise<T>): Promise<T> => {
    const key = `${space.userId}\n${space.spaceId}`;
    const result = (queues.get(key) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return result;
  };

  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteSync(path, text);
  };

  const readRecord = (space: SpaceContext, id: string): AppView | null => {
    try {
      const view = parseAppView(JSON.parse(readFileSync(deps.path(space, recordFile(id)), "utf8")) as unknown);
      // A record that names another id is not this app's record.
      return view && view.id === id ? view : null;
    } catch (cause) {
      if (missing(cause) || cause instanceof SyntaxError) return null;
      throw cause;
    }
  };

  const readAll = (space: SpaceContext): AppView[] => {
    let names: string[];
    try {
      names = readdirSync(deps.path(space, APPS_DIR));
    } catch (cause) {
      if (missing(cause)) return [];
      throw cause;
    }
    const apps: AppView[] = [];
    for (const name of names) {
      if (!isAppId(name)) continue;
      const view = readRecord(space, name);
      if (view) apps.push(view);
    }
    return apps.sort(compareApps);
  };

  const requireRecord = (space: SpaceContext, id: unknown): AppView => {
    const view = readRecord(space, appId(id));
    if (!view) throw notFound();
    return view;
  };

  const readStorage = (space: SpaceContext, id: string): Record<string, string> => {
    try {
      const raw = JSON.parse(readFileSync(deps.path(space, storageFile(id)), "utf8")) as { values?: unknown };
      return cleanPageStorage(raw?.values);
    } catch (cause) {
      if (missing(cause) || cause instanceof SyntaxError) return cleanPageStorage(null);
      throw cause;
    }
  };

  const writeRecord = (space: SpaceContext, view: AppView): void => {
    write(deps.path(space, recordFile(view.id)), `${JSON.stringify(view, null, 2)}\n`);
  };

  return {
    list: (space) => serial(space, () => ({ apps: readAll(space) })),

    open: (space, id) => serial(space, () => {
      const app = requireRecord(space, id);
      let html: string;
      try {
        html = readFileSync(deps.path(space, pageFile(app.id)), "utf8");
      } catch (cause) {
        if (missing(cause)) throw notFound();
        throw cause;
      }
      return { app, html, storage: readStorage(space, app.id) };
    }),

    save: (space, raw) => serial(space, () => {
      const title = appTitle(raw.title);
      const html = appHtml(raw.html);
      const source = appSource(raw.source);
      const hash = createHash("sha256").update(html, "utf8").digest("hex");
      const bytes = pageByteLength(html);
      const time = now();
      const apps = readAll(space);
      const key = sourceKey(source, title);
      const existing = key === null ? undefined : apps.find((app) => sourceKey(app.source, app.title) === key);
      if (existing) {
        if (existing.hash === hash) return { app: existing, outcome: "unchanged" as const };
        const app: AppView = { ...existing, version: existing.version + 1, hash, bytes, updatedAt: time };
        // The page first: a record never names a page that is not there.
        write(deps.path(space, pageFile(app.id)), html);
        writeRecord(space, app);
        return { app, outcome: "updated" as const };
      }
      if (apps.length >= APP_LIMITS.apps) throw conflict(`You can keep up to ${APP_LIMITS.apps} apps here; remove one first`);
      const id = appId(newId());
      if (apps.some((app) => app.id === id)) throw conflict("That app already exists");
      const app: AppView = { id, title, version: 1, hash, bytes, createdAt: time, updatedAt: time, ...(source ? { source } : {}) };
      write(deps.path(space, pageFile(id)), html);
      writeRecord(space, app);
      return { app, outcome: "created" as const };
    }),

    rename: (space, id, title) => serial(space, () => {
      const current = requireRecord(space, id);
      const next = appTitle(title);
      if (next === current.title) return { app: current };
      const app: AppView = { ...current, title: next, updatedAt: now() };
      writeRecord(space, app);
      return { app };
    }),

    remove: (space, id) => serial(space, () => {
      const removed = requireRecord(space, id);
      rmSync(deps.path(space, join(APPS_DIR, removed.id)), { recursive: true, force: true });
      return { removed };
    }),

    store: (space, id, raw) => serial(space, () => {
      const app = requireRecord(space, id);
      const next = applyStorageChange(readStorage(space, app.id), parseStorageChange(raw));
      write(deps.path(space, storageFile(app.id)), `${JSON.stringify({ values: next })}\n`);
      return { keys: Object.keys(next).length };
    }),
  };
}
