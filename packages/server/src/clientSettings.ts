// Server-persisted client preferences (`data/client-settings.json`). The web
// client owns the schema — Appearance, chat, notification, and UI-preference
// records travel together as one opaque JSON object. Multi-user servers keep
// one record per authenticated account; legacy single-user state belongs to
// the bootstrap owner.
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { ClientSettingsDto } from "@polyth/contracts";

/** Generous ceiling: the real payload is a few KB. Guards against a client
 *  streaming junk into the shared file. */
const MAX_BYTES = 256 * 1024;
const OWNER_USER_ID = "usr_owner";

export interface ClientSettingsService {
  get(userId?: string): ClientSettingsDto;
  put(settings: unknown): ClientSettingsDto;
  put(userId: string, settings: unknown): ClientSettingsDto;
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

  const get = (userId = OWNER_USER_ID): ClientSettingsDto => {
    const current = users[userId] ?? empty();
    return { ...current, settings: { ...current.settings } };
  };

  const put = (first: string | unknown, second?: unknown): ClientSettingsDto => {
    const userId = second === undefined ? OWNER_USER_ID : String(first);
    const settings = second === undefined ? first : second;
    if (!userId) throw invalid("account id is required");
    if (!isPlainObject(settings)) throw invalid("client settings must be a JSON object");
    const serialized = JSON.stringify(settings);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
      throw invalid("client settings exceed 256 KiB");
    }
    const current = users[userId] ?? empty();
    const next = { revision: current.revision + 1, updatedAt: Date.now(), settings };
    users = { ...users, [userId]: next };
    persist();
    return { ...next, settings: { ...next.settings } };
  };

  return { get, put } as ClientSettingsService;
}
