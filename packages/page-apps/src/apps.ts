// A saved app: one page an agent drew, kept by one person in one Space. Pure
// and browser-safe: the record, its limits and the validation both the server
// and the client apply. The page itself is only ever shown in the sandboxed
// frame of @polyth/chat-blocks; nothing here gives it more than a chat block has.
import {
  PAGE_MAX_FILE_BYTES,
  PAGE_MAX_TITLE,
  PAGE_STORAGE_MAX_BYTES,
  PAGE_STORAGE_MAX_KEYS,
  pageByteLength,
  pageStorageBytes,
  pageStorageKey,
  pageStorageValue,
} from "@polyth/chat-blocks/page";

export const PAGE_APPS_PACKAGE_ID = "page-apps";

export const APP_LIMITS = {
  /** Apps one person keeps in one Space. */
  apps: 100,
  titleChars: PAGE_MAX_TITLE,
  htmlBytes: PAGE_MAX_FILE_BYTES,
  /** A chat, project or file reference kept to recognise the same page again. */
  sourceChars: 300,
  storageBytes: PAGE_STORAGE_MAX_BYTES,
  storageKeys: PAGE_STORAGE_MAX_KEYS,
} as const;

/** Where the page came from. Only ever compared with another app's source of
 *  the same person, to update an app instead of saving it twice: it is never
 *  used to open a chat, a project or a file. */
export interface AppSource {
  sessionId?: string;
  projectId?: string;
  /** Project-relative file the page was loaded from. */
  from?: string;
}

export interface AppView {
  id: string;
  title: string;
  /** Grows by one each time the page changes. */
  version: number;
  /** SHA-256 of the page, hex. */
  hash: string;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  source?: AppSource;
}

export type SaveOutcome = "created" | "updated" | "unchanged";

export interface AppStorageChange {
  clear?: boolean;
  remove?: readonly string[];
  set?: Readonly<Record<string, string>>;
}

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export const invalidInput = (message: string): Error => fail("invalid-input", message);
export const notFound = (message = "App not found"): Error => fail("not-found", message);
export const conflict = (message: string): Error => fail("conflict", message);
export const tooLarge = (message: string): Error => fail("too-large", message);

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids are minted by the server; anything else never reaches a path. */
export function appId(value: unknown): string {
  if (typeof value !== "string" || !APP_ID.test(value)) throw notFound();
  return value;
}

export const isAppId = (value: unknown): value is string => typeof value === "string" && APP_ID.test(value);

export function appTitle(value: unknown): string {
  if (typeof value !== "string") throw invalidInput("An app needs a name");
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) throw invalidInput("An app needs a name");
  if (title.length > APP_LIMITS.titleChars) throw invalidInput("That name is too long");
  return title;
}

export function appHtml(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput("An app needs a page");
  if (pageByteLength(value) > APP_LIMITS.htmlBytes) throw tooLarge("That page is too large to keep as an app");
  return value;
}

const reference = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= APP_LIMITS.sourceChars && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
};

export function appSource(raw: unknown): AppSource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const sessionId = reference(value.sessionId);
  const projectId = reference(value.projectId);
  const from = reference(value.from);
  if (!sessionId && !projectId && !from) return undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), ...(from ? { from } : {}) };
}

/** Two saves are the same app when they name the same project file, or the
 *  same chat and the same title. A page with no source is always a new app. */
export function sourceKey(source: AppSource | undefined, title: string): string | null {
  if (!source) return null;
  if (source.from && source.projectId) return `file\n${source.projectId}\n${source.from}`;
  if (source.sessionId) return `chat\n${source.sessionId}\n${title.toLowerCase()}`;
  return null;
}

/** An app record read back from disk; null when it is not one. */
export function parseAppView(raw: unknown): AppView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const count = (field: unknown): number | null => typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : null;
  const version = count(value.version);
  const bytes = count(value.bytes);
  const createdAt = count(value.createdAt);
  const updatedAt = count(value.updatedAt);
  if (!isAppId(value.id) || typeof value.title !== "string" || typeof value.hash !== "string") return null;
  if (version === null || version < 1 || bytes === null || createdAt === null || updatedAt === null) return null;
  if (!/^[0-9a-f]{64}$/.test(value.hash)) return null;
  let title: string;
  try { title = appTitle(value.title); } catch { return null; }
  const source = appSource(value.source);
  return { id: value.id, title, version, hash: value.hash, bytes, createdAt, updatedAt, ...(source ? { source } : {}) };
}

/** Newest first, then by name: the order every list shows. */
export const compareApps = (a: AppView, b: AppView): number =>
  b.updatedAt - a.updatedAt || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** Validate a change the page asked for. */
export function parseStorageChange(raw: unknown): AppStorageChange {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidInput("Invalid storage change");
  const value = raw as Record<string, unknown>;
  const change: { clear?: boolean; remove?: string[]; set?: Record<string, string> } = {};
  if (value.clear === true) change.clear = true;
  if (value.remove !== undefined) {
    if (!Array.isArray(value.remove) || value.remove.length > APP_LIMITS.storageKeys || !value.remove.every(pageStorageKey)) {
      throw invalidInput("Invalid storage keys");
    }
    change.remove = [...value.remove] as string[];
  }
  if (value.set !== undefined) {
    if (!value.set || typeof value.set !== "object" || Array.isArray(value.set)) throw invalidInput("Invalid storage values");
    const entries = Object.entries(value.set as Record<string, unknown>);
    if (entries.length > APP_LIMITS.storageKeys) throw tooLarge("An app keeps at most a few hundred values");
    const set: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, item] of entries) {
      if (!pageStorageKey(key) || !pageStorageValue(item)) throw invalidInput("Invalid storage value");
      set[key] = item;
    }
    change.set = set;
  }
  return change;
}

/** Apply a change to a stored map, within the limits. Pure. */
export function applyStorageChange(current: Readonly<Record<string, string>>, change: AppStorageChange): Record<string, string> {
  const next: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!change.clear) for (const [key, value] of Object.entries(current)) next[key] = value;
  for (const key of change.remove ?? []) delete next[key];
  for (const [key, value] of Object.entries(change.set ?? {})) next[key] = value;
  if (Object.keys(next).length > APP_LIMITS.storageKeys) throw tooLarge("This app's storage is full");
  if (pageStorageBytes(next) > APP_LIMITS.storageBytes) throw tooLarge("This app's storage is full");
  return next;
}
