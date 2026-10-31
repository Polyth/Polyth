// Device-local placement of the conversation prompt bookmark. A dragged
// position is geometry of the screen that produced it, so it is neither a
// synced UI preference nor session data: it lives only in this browser's
// account-scoped storage (the persistence model of the mobile composer rail)
// and is never mirrored by settingsSync.
//
// The record holds two fractions of the bookmark's free area rather than
// pixels, so a saved placement stays valid across rotation, window resizes,
// density changes and the software keyboard.
import { useMemo, useSyncExternalStore } from "react";
import { accountStorageGet, accountStorageKey, accountStorageRemove, accountStorageSet } from "./accountStorage.ts";

export interface PromptBookmarkPosition {
  /** 0 = inline-start edge of the free area, 1 = inline-end edge. */
  x: number;
  /** 0 = top of the free area (below any floating header), 1 = bottom. */
  y: number;
}

export interface PromptBookmarkBox {
  width: number;
  height: number;
}

export const PROMPT_BOOKMARK_POSITION_KEY = "polyth.promptBookmark.position.v1";
/** The resting place before any drag: the inline-end edge, just below the header chrome. */
export const PROMPT_BOOKMARK_HOME: Readonly<PromptBookmarkPosition> = Object.freeze({ x: 1, y: 0 });

const CHANGE_EVENT = "polyth:prompt-bookmark-position";
const PRECISION = 1e4;
const unsaved = new Map<string, string | null>();

function unit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(1, Math.max(0, value)) * PRECISION) / PRECISION;
}

/** Clamp both axes into [0, 1]; a missing or non-finite axis keeps its home value. */
export function clampPromptBookmarkPosition(value: { x?: unknown; y?: unknown }): PromptBookmarkPosition {
  return { x: unit(value.x, PROMPT_BOOKMARK_HOME.x), y: unit(value.y, PROMPT_BOOKMARK_HOME.y) };
}

export function isPromptBookmarkHome(position: PromptBookmarkPosition): boolean {
  return position.x === PROMPT_BOOKMARK_HOME.x && position.y === PROMPT_BOOKMARK_HOME.y;
}

/** Unknown, corrupt or future-version records fall back to home instead of throwing. */
export function parsePromptBookmarkPosition(raw: string | null): PromptBookmarkPosition {
  if (!raw) return { ...PROMPT_BOOKMARK_HOME };
  try {
    const data = JSON.parse(raw) as { v?: unknown; x?: unknown; y?: unknown } | null;
    if (typeof data !== "object" || data === null || data.v !== 1) return { ...PROMPT_BOOKMARK_HOME };
    return clampPromptBookmarkPosition(data);
  } catch {
    return { ...PROMPT_BOOKMARK_HOME };
  }
}

/** Where the control's start-top corner sits inside the free area, in px. */
export function promptBookmarkOffset(
  position: PromptBookmarkPosition,
  area: PromptBookmarkBox,
  size: PromptBookmarkBox,
  rtl: boolean,
): { left: number; top: number } {
  const rangeX = Math.max(0, area.width - size.width);
  const rangeY = Math.max(0, area.height - size.height);
  return { left: (rtl ? 1 - position.x : position.x) * rangeX, top: position.y * rangeY };
}

/**
 * The inverse of `promptBookmarkOffset`. An axis with no room to move keeps
 * the `from` value, so a tiny free area (landscape phone, keyboard open) never
 * erases the saved placement of the other axis.
 */
export function promptBookmarkFromOffset(
  offset: { left: number; top: number },
  area: PromptBookmarkBox,
  size: PromptBookmarkBox,
  rtl: boolean,
  from: PromptBookmarkPosition = PROMPT_BOOKMARK_HOME,
): PromptBookmarkPosition {
  const rangeX = Math.max(0, area.width - size.width);
  const rangeY = Math.max(0, area.height - size.height);
  const horizontal = rangeX > 0 ? Math.min(1, Math.max(0, offset.left / rangeX)) : null;
  return clampPromptBookmarkPosition({
    x: horizontal === null ? from.x : rtl ? 1 - horizontal : horizontal,
    y: rangeY > 0 ? offset.top / rangeY : from.y,
  });
}

/** The stored record; blocked or quota-limited storage still lets the bookmark move for this page's lifetime. */
export function readPromptBookmarkPositionRecord(): string | null {
  const scoped = accountStorageKey(PROMPT_BOOKMARK_POSITION_KEY);
  return unsaved.has(scoped) ? unsaved.get(scoped) ?? null : accountStorageGet(PROMPT_BOOKMARK_POSITION_KEY);
}

export function getPromptBookmarkPosition(): PromptBookmarkPosition {
  return parsePromptBookmarkPosition(readPromptBookmarkPositionRecord());
}

/** `null` (or the home position) removes the record, so the default leaves no residue. */
export function writePromptBookmarkPosition(position: PromptBookmarkPosition | null): void {
  const next = position === null ? null : clampPromptBookmarkPosition(position);
  const raw = next === null || isPromptBookmarkHome(next) ? null : JSON.stringify({ v: 1, ...next });
  if (raw === null) accountStorageRemove(PROMPT_BOOKMARK_POSITION_KEY);
  else accountStorageSet(PROMPT_BOOKMARK_POSITION_KEY, raw);
  const scoped = accountStorageKey(PROMPT_BOOKMARK_POSITION_KEY);
  if (accountStorageGet(PROMPT_BOOKMARK_POSITION_KEY) === raw) unsaved.delete(scoped);
  else unsaved.set(scoped, raw);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribePromptBookmarkPosition(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) unsaved.clear();
    else if (event.key === accountStorageKey(PROMPT_BOOKMARK_POSITION_KEY)) unsaved.delete(event.key);
    else return;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePromptBookmarkPosition(): PromptBookmarkPosition {
  const raw = useSyncExternalStore(subscribePromptBookmarkPosition, readPromptBookmarkPositionRecord, () => null);
  return useMemo(() => parsePromptBookmarkPosition(raw), [raw]);
}
