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

/** The rail is two runs of launchers: `start` reads from the leading edge, and
 *  `end` hugs Send. Membership, not a lane index, is what is saved, so a
 *  narrower screen, a wider Stop button or a launcher with nothing to show
 *  never moves another launcher away from where it was put. */
export interface MobileRailArrangement {
  start: string[];
  end: string[];
}
/** Older records were positional (`null` = an empty lane). They are read as an
 *  arrangement; new writes are a dense list. */
export type MobileRailSlots = (string | null)[];
/** Stored between the two runs. It reads as an ordinary unknown launcher to
 *  a client that predates it, which keeps it instead of stripping the record,
 *  and can never name a real slot item (`slot:<slot>:<item>`). */
export const MOBILE_RAIL_GAP = "slot:gap";
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
  const arrangement = parseMobileRail(raw);
  if (arrangement === null) return null;
  return serializeArrangement(arrangement);
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

function serializeArrangement({ start, end }: MobileRailArrangement): string {
  const slots = end.length ? [...start, MOBILE_RAIL_GAP, ...end] : [...start];
  return JSON.stringify({ v: 1, slots: slots.slice(0, MAX_SLOTS) });
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

/** A positional record becomes two runs: the last empty lane before a
 *  launcher is where the run beside Send began. Trailing empty lanes and
 *  repeated empty lanes say nothing more. */
export function mobileRailFromSlots(slots: readonly (string | null)[]): MobileRailArrangement {
  const gap = slots.indexOf(MOBILE_RAIL_GAP);
  if (gap >= 0) {
    const ids = (from: number, to?: number) => slots.slice(from, to).filter((id): id is string => id !== null && id !== MOBILE_RAIL_GAP);
    return { start: ids(0, gap), end: ids(gap + 1) };
  }
  let last = slots.length - 1;
  while (last >= 0 && slots[last] === null) last--;
  const split = slots.slice(0, last + 1).lastIndexOf(null);
  const ids = (from: number, to?: number) => slots.slice(from, to).filter((id): id is string => id !== null);
  return split < 0 ? { start: ids(0), end: [] } : { start: ids(0, split), end: ids(split + 1, last + 1) };
}

/** Unknown ids survive package disable/re-enable; duplicate and malformed ids do not. */
export function parseMobileRail(raw: string | null): MobileRailArrangement | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.v !== 1 || !Array.isArray(value.slots)) return null;
    const seen = new Set<string>();
    // Only a real empty lane (`null`) is position; an invalid or repeated id is
    // dropped, so it cannot pass for the space before Send.
    return mobileRailFromSlots(value.slots.slice(0, MAX_SLOTS).flatMap((id: unknown) => {
      if (id === null) return [null];
      if (typeof id !== "string" || id.length > 256 || !/^(?:host:add|widget:[\w.:-]+|slot:[\w.:-]+)$/.test(id) || seen.has(id)) return [];
      seen.add(id);
      return [id];
    }));
  } catch { return null; }
}

/** Every launcher of an arrangement, in reading order. */
export function mobileRailIds({ start, end }: MobileRailArrangement): string[] {
  return [...start, ...end];
}

/** Move one launcher to `index` of a run (`index` counts without it). */
export function moveMobileRailLauncher(arrangement: MobileRailArrangement, id: string, run: "start" | "end", index: number): MobileRailArrangement {
  const next = {
    start: arrangement.start.filter((value) => value !== id),
    end: arrangement.end.filter((value) => value !== id),
  };
  const target = next[run];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  return next;
}

export function removeMobileRailLauncher(arrangement: MobileRailArrangement, id: string): MobileRailArrangement {
  return { start: arrangement.start.filter((value) => value !== id), end: arrangement.end.filter((value) => value !== id) };
}

export function sameMobileRail(a: MobileRailArrangement, b: MobileRailArrangement): boolean {
  return a.start.join("\n") === b.start.join("\n") && a.end.join("\n") === b.end.join("\n");
}

/** This scope's own record, exactly (no inheritance). */
export function readMobileRail(key: string): string | null {
  const saved = readMap()[key];
  if (saved !== undefined) return saved;
  // One-time migration from the older per-key record. It is adopted only when
  // the map has no entry and the durable store has not already answered, so a
  // stale device copy can never overwrite a synced arrangement.
  return legacyArrangement(key);
}

/** What the rail shows: the scope's own record, else the arrangement most
 *  recently edited in the same Space. A project the user has not arranged yet
 *  starts from their latest arrangement instead of the package defaults, and
 *  gets its own record only once it is edited. */
export function readEffectiveMobileRail(key: string): string | null {
  const own = readMobileRail(key);
  if (own !== null) return own;
  if (!key.startsWith(LEGACY_PREFIX)) return null;
  // Space ids carry no "." (`spc_[A-Za-z0-9_-]+`), so the first one after the
  // prefix ends the Space part and the prefix names exactly one Space.
  const rest = key.slice(LEGACY_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const space = `${LEGACY_PREFIX}${rest.slice(0, dot + 1)}`;
  const map = readMap();
  const latest = Object.keys(map).findLast((other) => other.startsWith(space));
  return latest === undefined ? null : map[latest] ?? null;
}

export function writeMobileRail(key: string, arrangement: MobileRailArrangement | null): void {
  const map = { ...readMap() };
  if (arrangement === null) delete map[key];
  else {
    // Re-insert at the end so the cap evicts the least recently edited
    // arrangement, then store exactly that arrangement.
    delete map[key];
    map[key] = serializeArrangement(arrangement);
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
  return useSyncExternalStore(subscribeMobileRail, () => readEffectiveMobileRail(key), () => null);
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
