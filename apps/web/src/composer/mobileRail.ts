// Phone composer button arrangement, one saved per Space + project. The map is
// one account-owned UI preference (`core.mobile-composer-rail`), mirrored to
// the server by settingsSync so a client that has never seen a project still
// inherits the arrangement the user built elsewhere. localStorage stays the
// synchronous cache the rail reads at mount; the paired mobile app additionally
// mirrors it through the app-owned client-context store, because its Link
// loopback shell starts from an empty localStorage on every launch.
import { useSyncExternalStore } from "react";
import { accountStorageGet } from "../accountStorage.ts";
import { presentationScopeId } from "../projectInterfaceScope.ts";
import { MOBILE_RAIL_MAP_KEY, readNavigatorState, subscribeNavigatorStateHydrated, writeNavigatorState } from "../navigatorState.ts";

export type MobileRailSlots = (string | null)[];
const MAX_SLOTS = 32;
const CHANGE_EVENT = "polyth:mobile-composer-rail";
/** Bound the synced record: one arrangement per Space + project the user has
 *  actually arranged, never every project that was merely opened. */
const MAX_ARRANGEMENTS = 64;
/** Account-level preference id (mirrored to the server settings blob). */
export const MOBILE_RAIL_PREFERENCE_ID = "core.mobile-composer-rail";
/** LocalStorage key holding the whole per-key arrangement map. */
const RAIL_MAP_KEY = MOBILE_RAIL_MAP_KEY;
/** Older builds stored a bare per-key `polyth.composer.mobile-rail.v1.<space>.<project>`
 *  string; that exact key is read once as a migration source. */
const LEGACY_PREFIX = "polyth.composer.mobile-rail.v1.";

/** key -> serialized `{v:1,slots}` arrangement. */
type MobileRailMap = Record<string, string>;

function parseArrangement(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 8_192) return null;
  // Normalize through the slot parser so a synced value from another client
  // cannot smuggle malformed ids past this boundary.
  const slots = parseMobileRail(raw);
  if (slots === null) return null;
  return serializeArrangement(slots);
}

/** Tolerant reader: an unknown or malformed value is dropped, never fatal. */
export function parseMobileRailMap(value: unknown): MobileRailMap {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : (() => {
        try { return JSON.parse(typeof value === "string" ? value : "") as Record<string, unknown>; } catch { return null; }
      })();
  if (!raw) return {};
  const map: MobileRailMap = {};
  for (const [key, item] of Object.entries(raw).slice(0, MAX_ARRANGEMENTS)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const arrangement = parseArrangement(item);
    if (arrangement !== null) map[key] = arrangement;
  }
  return map;
}

function serializeArrangement(slots: readonly (string | null)[]): string {
  const next = slots.slice(0, MAX_SLOTS);
  while (next.at(-1) === null) next.pop();
  return JSON.stringify({ v: 1, slots: next });
}

/** Blocked/quota-limited storage still allows editing for this page lifetime. */
let unsaved: MobileRailMap | null = null;

function readMap(): MobileRailMap {
  return unsaved ?? parseMobileRailMap(readNavigatorState(RAIL_MAP_KEY));
}

function writeMap(map: MobileRailMap): void {
  const raw = JSON.stringify(map);
  writeNavigatorState(RAIL_MAP_KEY, raw);
  unsaved = readNavigatorState(RAIL_MAP_KEY) === raw ? null : map;
}

/** The legacy per-key record (account-scoped by `accountStorage`), read as a
 *  migration source until the map has an entry for the key. */
function legacyArrangement(key: string): string | null {
  return parseArrangement(accountStorageGet(key));
}

/** One arrangement per Space + project, or per Space while every project
 *  shares one interface (`projectInterfaceScope`). */
export function mobileRailKey(spaceId: string, projectId: string | null): string {
  return mobileRailScopeKey(spaceId, projectId === null ? "" : presentationScopeId(projectId));
}

/** The record for one storage scope exactly: a project id, or the shared scope. */
export function mobileRailScopeKey(spaceId: string, scope: string): string {
  return `${LEGACY_PREFIX}${encodeURIComponent(spaceId)}.${encodeURIComponent(scope)}`;
}

/** The last section belongs to Send/Stop. Every launcher retains a full tap box. */
export function mobileRailColumns(width: number, tap = 44, primaryWidth = tap, gap = 4): number {
  const available = width - Math.max(tap, primaryWidth);
  return Math.max(2, Math.min(12, Math.floor(available / (tap + gap)) + 1));
}

/** Unknown ids survive package disable/re-enable; duplicate and malformed ids do not. */
export function parseMobileRail(raw: string | null): MobileRailSlots | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.v !== 1 || !Array.isArray(value.slots)) return null;
    const seen = new Set<string>();
    return value.slots.slice(0, MAX_SLOTS).map((id: unknown) => {
      if (typeof id !== "string" || id.length > 256 || !/^(?:host:add|widget:[\w.:-]+|slot:[\w.:-]+)$/.test(id) || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
  } catch { return null; }
}

/** Resize only changes presentation; it never truncates a saved arrangement. */
export function mobileRailCells(slots: readonly (string | null)[], lanes: number, editing: boolean): MobileRailSlots {
  const next = [...slots];
  if (editing && !next.includes(null) && next.length < MAX_SLOTS) next.push(null);
  const count = Math.min(MAX_SLOTS, Math.max(lanes, Math.ceil(next.length / lanes) * lanes));
  while (next.length < count) next.push(null);
  return next;
}

export function swapMobileRailSlots(slots: readonly (string | null)[], from: number, to: number): MobileRailSlots {
  const next = [...slots];
  if (from < 0 || to < 0 || from >= slots.length || to >= slots.length) return next;
  [next[from], next[to]] = [next[to] ?? null, next[from] ?? null];
  return next;
}

export function readMobileRail(key: string): string | null {
  const saved = readMap()[key];
  if (saved !== undefined) return saved;
  // One-time migration from the older per-key record. It is adopted only when
  // the map has no entry and the durable store has not already answered, so a
  // stale device copy can never overwrite a synced arrangement.
  return legacyArrangement(key);
}

export function writeMobileRail(key: string, slots: MobileRailSlots | null): void {
  const map = { ...readMap() };
  if (slots === null) delete map[key];
  else {
    // Re-insert at the end so the cap evicts the least recently edited
    // arrangement, then store exactly that arrangement.
    delete map[key];
    map[key] = serializeArrangement(slots);
  }
  const keys = Object.keys(map);
  const bounded: MobileRailMap = keys.length > MAX_ARRANGEMENTS
    ? Object.fromEntries(keys.slice(keys.length - MAX_ARRANGEMENTS).map((id) => [id, map[id] as string]))
    : map;
  writeMap(bounded);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Bundle key -> arrangement, the JSON value mirrored to the server. */
export function getMobileRailMap(): MobileRailMap {
  return readMap();
}

/** Replace the whole map from a synced (validated) value. */
export function replaceMobileRailMap(value: unknown): void {
  writeMap(parseMobileRailMap(value));
}

/** Read one key from a synced value without touching local storage. */
export function mobileRailMapEntry(value: unknown, key: string): string | null {
  return parseMobileRailMap(value)[key] ?? null;
}

export function subscribeMobileRail(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key !== RAIL_MAP_KEY && event.key !== null && !event.key.startsWith(LEGACY_PREFIX)) return;
    unsaved = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", storage);
  const offHydrated = subscribeNavigatorStateHydrated(() => {
    unsaved = null;
    listener();
  });
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", storage);
    offHydrated();
  };
}

/** React binding for a single rail key: the current arrangement, re-read when
 *  the store changes, another client syncs, or the durable app copy lands. */
export function useMobileRail(key: string): string | null {
  return useSyncExternalStore(subscribeMobileRail, () => readMobileRail(key), () => null);
}

/** Account-sync adapter: this store owns validation and its synchronous cache;
 *  settingsSync only mirrors the JSON value. */
export const mobileRailPreference = {
  read: getMobileRailMap,
  write: replaceMobileRailMap,
  subscribe: subscribeMobileRail,
};

const EDIT_REQUEST_EVENT = "polyth:mobile-composer-rail-edit";

/** Ask the fresh-chat composer to enter its button-arranging mode. The new
 *  chat's Customize panel uses this on phones, where composer buttons live in
 *  this per-project rail rather than in the shared widget layout. */
export function requestMobileRailEdit(): void {
  window.dispatchEvent(new Event(EDIT_REQUEST_EVENT));
}

export function subscribeMobileRailEditRequest(listener: () => void): () => void {
  window.addEventListener(EDIT_REQUEST_EVENT, listener);
  return () => window.removeEventListener(EDIT_REQUEST_EVENT, listener);
}
