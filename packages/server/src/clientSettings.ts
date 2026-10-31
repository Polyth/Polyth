// Server-persisted client preferences (`data/client-settings.json`). The web
// client owns the schema — Appearance, chat, notification, and UI-preference
// records travel together as one opaque JSON object. Multi-user servers keep
// one record per authenticated account; legacy single-user state belongs to
// the bootstrap owner.
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { ClientSettingsDto } from "@polyth/contracts";

/** Retain the 4 MiB compatibility bound for records written by older clients
 * that embedded custom background images. Current clients send preset ids. */
const MAX_BYTES = 4 * 1024 * 1024;
const OWNER_USER_ID = "usr_owner";

export interface ClientSettingsService {
  /** Account preferences require an explicit durable identity. An omitted id
   * returns an empty record so server-global/background code cannot inherit
   * whichever human happened to be the bootstrap owner. */
  get(userId?: string): ClientSettingsDto;
  /** Compatibility write for the legacy single-user owner path. New request
   * handlers must use the userId overload. */
  put(settings: unknown): ClientSettingsDto;
  put(userId: string, settings: unknown, expectedRevision?: number): ClientSettingsDto;
  /** Every durable account id that has a record (mirror/union callers). */
  userIds(): string[];
  /** Read-modify-write ONE top-level section of an account's blob without
   *  disturbing any other key; `undefined` removes the section. Used by the provider/model visibility overlay so
   *  a toggle cannot clobber an in-flight settings-sync write. */
  patchSection(userId: string, section: string, value: unknown): ClientSettingsDto;
}

interface ClientSettingsFileV2 {
  version: 2;
  users: Record<string, ClientSettingsDto>;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const empty = (): ClientSettingsDto => ({ revision: 0, updatedAt: 0, settings: {} });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: unknown): ClientSettingsDto | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = raw as Partial<ClientSettingsDto>;
  if (!isPlainObject(state.settings)) return undefined;
  return {
    revision: Number.isFinite(state.revision) ? Math.max(0, Math.trunc(state.revision as number)) : 1,
    updatedAt: Number.isFinite(state.updatedAt) ? (state.updatedAt as number) : Date.now(),
    settings: state.settings,
  };
}

/** Starred model-picker keys from an account's synced `modelPrefs`. Keys
 *  written before harness support carry no `harness::` prefix and belong to
 *  OpenCode, matching the web parser in `@polyth/models`. */
export function modelFavoriteKeys(settings: unknown): string[] {
  const prefs = isPlainObject(settings) ? settings.modelPrefs : undefined;
  const raw = isPlainObject(prefs) && Array.isArray(prefs.favorites) ? prefs.favorites : [];
  const keys = raw
    .filter((key): key is string => typeof key === "string" && key.includes("/"))
    .map((key) => key.includes("::") ? key : `opencode::${key}`);
  return [...new Set(keys)].slice(0, 200);
}

/** Sections the server writes itself (via {@link ClientSettingsService.patchSection})
 *  because they are derived from host/account authority, not from a client
 *  preference store. A blob PUT never changes them: keeping the server copy
 *  also means a client push racing a visibility toggle cannot clobber it. */
const SERVER_OWNED_SECTIONS = new Set(["modelVisibility"]);

export function createClientSettings(opts: { file: string }): ClientSettingsService {
  mkdirSync(dirname(opts.file), { recursive: true });

  let users: Record<string, ClientSettingsDto> = {};
  let migratedLegacy = false;
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Record<string, unknown>;
    if (raw.version === 2 && isPlainObject(raw.users)) {
      users = Object.fromEntries(
        Object.entries(raw.users).flatMap(([userId, value]) => {
          const state = parseState(value);
          return state && userId ? [[userId, state] as const] : [];
        }),
      );
    } else {
      const legacy = parseState(raw);
      if (legacy) {
        users[OWNER_USER_ID] = legacy;
        migratedLegacy = true;
      }
    }
  } catch {
    // first run, or a hand-mangled file — start from empty account records
  }

  const persist = (): void => {
    const state: ClientSettingsFileV2 = { version: 2, users };
    atomicWriteSync(opts.file, JSON.stringify(state, null, 2));
  };
  if (migratedLegacy) persist();

  const get = (userId?: string): ClientSettingsDto => {
    if (!userId) return empty();
    const current = users[userId] ?? empty();
    return { ...current, settings: { ...current.settings } };
  };

  const put = (first: string | unknown, second?: unknown, expectedRevision?: number): ClientSettingsDto => {
    const userId = second === undefined ? OWNER_USER_ID : String(first);
    const settings = second === undefined ? first : second;
    if (!userId) throw invalid("account id is required");
    if (!isPlainObject(settings)) throw invalid("client settings must be a JSON object");
    const serialized = JSON.stringify(settings);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
      throw invalid("client settings exceed 4 MiB");
    }
    const current = users[userId] ?? empty();
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid("expected revision must be a non-negative integer");
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error("client settings changed; refresh and retry"), { code: "conflict" });
      }
    }
    const incoming = settings as Record<string, unknown>;
    let merged = incoming;
    for (const section of SERVER_OWNED_SECTIONS) {
      // A client's copy is never adopted, not even as a first write: a fresh
      // client pushes its empty default before the server snapshot arrives,
      // which would erase the seed the account still inherits.
      if (Object.prototype.hasOwnProperty.call(current.settings, section)) {
        merged = { ...merged, [section]: current.settings[section] };
      } else if (Object.prototype.hasOwnProperty.call(merged, section)) {
        const { [section]: _dropped, ...rest } = merged;
        merged = rest;
      }
    }
    const next = { revision: current.revision + 1, updatedAt: Date.now(), settings: merged };
    users = { ...users, [userId]: next };
    persist();
    return { ...next, settings: { ...next.settings } };
  };

  return {
    get,
    put,
    userIds: () => Object.keys(users),
    patchSection(userId, section, value) {
      if (!userId) throw invalid("account id is required");
      if (value !== undefined && !isPlainObject(value)) throw invalid("section value must be a JSON object");
      const current = users[userId] ?? empty();
      const { [section]: _previous, ...others } = current.settings;
      const settings = value === undefined ? others : { ...others, [section]: value };
      const serialized = JSON.stringify(settings);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
        throw invalid("client settings exceed 4 MiB");
      }
      const next = { revision: current.revision + 1, updatedAt: Date.now(), settings };
      users = { ...users, [userId]: next };
      persist();
      return { ...next, settings: { ...next.settings } };
    },
  } as ClientSettingsService;
}
