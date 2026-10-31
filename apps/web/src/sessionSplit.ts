// Split sessions view: two chats side by side in the workspace. One pane is
// focused — it IS the active chat (activeSessionId), with the live socket, the
// composer and every shell surface that follows the active chat. The other is
// a companion: a live view of a background chat that becomes the focused one
// on a click. Panes keep their on-screen places; focus moves between them.
//
// Presentation state only: nothing here appends a SessionEvent or touches a
// runtime. It is tab-scoped (sessionStorage) like the timeline anchor, so two
// tabs can show different pairs; the divider position is a remembered
// preference (localStorage).
import { useSyncExternalStore } from "react";
import { getState, subscribeStore } from "./store.ts";

export type SplitSide = 0 | 1;

export interface SessionSplitState {
  /** Session ids by on-screen place, start pane first. The focused place may
   *  be null while it shows a fresh chat; the companion place never is. */
  panes: readonly [string | null, string | null];
  focused: SplitSide;
  /** Start pane's share of the split width. */
  ratio: number;
}

export const SPLIT_RATIO_MIN = 0.28;
export const SPLIT_RATIO_MAX = 0.72;
export const SPLIT_RATIO_DEFAULT = 0.5;
/** Narrowest pane that still reads as a chat; below two of these the split
 *  rests (the focused chat fills the workspace, the pair is kept). */
export const SPLIT_PANE_MIN_PX = 360;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

export function otherSide(side: SplitSide): SplitSide {
  return side === 0 ? 1 : 0;
}

/** The background chat shown beside the focused one. */
export function companionSessionId(state: SessionSplitState | null): string | null {
  return state ? state.panes[otherSide(state.focused)] : null;
}

/** Open `companion` beside the focused chat (at the end, the reading
 *  direction's far side), or replace the companion of an open split. A chat
 *  is never shown beside itself. */
export function openSplit(
  state: SessionSplitState | null,
  active: string | null,
  companion: string,
  ratio = SPLIT_RATIO_DEFAULT,
): SessionSplitState | null {
  if (companion === active) return state;
  if (state) {
    const companionSide = otherSide(state.focused);
    const panes: [string | null, string | null] = [...state.panes];
    panes[state.focused] = active;
    panes[companionSide] = companion;
    return { ...state, panes };
  }
  return { panes: [active, companion], focused: 0, ratio: clampSplitRatio(ratio) };
}

/** Follow the active chat. Choosing the companion (in its pane, the navigator
 *  or anywhere else) moves focus to its place; choosing another chat shows it
 *  in the focused place. A split whose companion place would be empty — the
 *  companion was focused, then a fresh chat started — closes. */
export function followActiveSession(state: SessionSplitState | null, active: string | null): SessionSplitState | null {
  if (!state) return null;
  if (state.panes[state.focused] === active) return state;
  const companionSide = otherSide(state.focused);
  if (active !== null && state.panes[companionSide] === active) {
    const next = { ...state, focused: companionSide };
    return next.panes[otherSide(companionSide)] === null ? null : next;
  }
  const panes: [string | null, string | null] = [...state.panes];
  panes[state.focused] = active;
  return panes[companionSide] === null ? null : { ...state, panes };
}

/** Swap the two places; focus stays with its chat. */
export function swapSplitSides(state: SessionSplitState): SessionSplitState {
  return {
    ...state,
    panes: [state.panes[1], state.panes[0]],
    focused: otherSide(state.focused),
    ratio: clampSplitRatio(1 - state.ratio),
  };
}

/** Drop chats that no longer exist. Losing either chat ends the split. */
export function pruneSplit(state: SessionSplitState | null, removed: ReadonlySet<string>): SessionSplitState | null {
  if (!state) return null;
  const companion = companionSessionId(state);
  if (companion !== null && removed.has(companion)) return null;
  const focused = state.panes[state.focused];
  if (focused !== null && removed.has(focused)) return null;
  return state;
}

/** Whether the workspace is wide enough for two readable panes. */
export function splitFits(widthPx: number): boolean {
  return widthPx >= SPLIT_PANE_MIN_PX * 2;
}

/** Keep the divider where both panes stay at least `SPLIT_PANE_MIN_PX`. */
export function fitSplitRatio(ratio: number, widthPx: number): number {
  const clamped = clampSplitRatio(ratio);
  if (widthPx <= 0 || !splitFits(widthPx)) return clamped;
  const min = SPLIT_PANE_MIN_PX / widthPx;
  return Math.min(1 - min, Math.max(min, clamped));
}

export interface SplitSnapshot {
  shown: boolean;
  companion: string | null;
  focusedSide: SplitSide;
  focusedId: string | null;
}

export type SplitTransition = "open" | "close" | "focus" | "sides" | "replace";

/** What changed between two renders of the split, for its motion. Focus
 *  moving to the other chat keeps both chats in their places ("focus");
 *  swapping sides moves the same focused chat across ("sides"). */
export function splitTransition(was: SplitSnapshot, now: SplitSnapshot): SplitTransition | null {
  if (!was.shown && now.shown) return "open";
  if (was.shown && !now.shown) return "close";
  if (!now.shown) return null;
  if (was.focusedSide !== now.focusedSide) {
    return was.focusedId === now.focusedId ? "sides" : "focus";
  }
  return was.companion !== now.companion ? "replace" : null;
}

export function parseSessionSplit(raw: string | null): SessionSplitState | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionSplitState>;
    if (typeof value !== "object" || value === null || !Array.isArray(value.panes) || value.panes.length !== 2) return null;
    const [start, end] = value.panes.map((id) => (typeof id === "string" && id ? id : null));
    const focused: SplitSide = value.focused === 1 ? 1 : 0;
    const panes: [string | null, string | null] = [start ?? null, end ?? null];
    if (panes[otherSide(focused)] === null || panes[0] === panes[1]) return null;
    return { panes, focused, ratio: clampSplitRatio(Number(value.ratio)) };
  } catch {
    return null;
  }
}

// ---- tab-scoped store --------------------------------------------------------

const STATE_KEY = "polyth.sessionSplit.v1";
const RATIO_KEY = "polyth.sessionSplit.ratio";

function storage(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? globalThis.sessionStorage ?? null : globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function rememberedRatio(): number {
  const raw = storage("local")?.getItem(RATIO_KEY);
  return raw ? clampSplitRatio(Number(raw)) : SPLIT_RATIO_DEFAULT;
}

let current: SessionSplitState | null = parseSessionSplit(storage("session")?.getItem(STATE_KEY) ?? null);
const listeners = new Set<() => void>();

function publish(next: SessionSplitState | null): void {
  if (next === current) return;
  current = next;
  try {
    const store = storage("session");
    if (next) store?.setItem(STATE_KEY, JSON.stringify(next));
    else store?.removeItem(STATE_KEY);
  } catch {
    // Storage full or blocked: the split still works for this document.
  }
  for (const listener of [...listeners]) listener();
}

export function getSessionSplit(): SessionSplitState | null {
  return current;
}

export function subscribeSessionSplit(listener: () => void): () => void {
  installActiveSessionFollow();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionSplit(): SessionSplitState | null {
  return useSyncExternalStore(subscribeSessionSplit, getSessionSplit, getSessionSplit);
}

/** Show `sessionId` beside the active chat. */
export function openSessionInSplit(sessionId: string): boolean {
  installActiveSessionFollow();
  const next = openSplit(current, getState().activeSessionId, sessionId, current?.ratio ?? rememberedRatio());
  if (next === current) return false;
  publish(next);
  return true;
}

export function closeSessionSplit(): void {
  publish(null);
}

/** The chat open before the current one, for "split with the previous chat". */
let previousSessionId: string | null = null;

/** Close an open split, or show the previous chat beside the current one.
 *  False when there is nothing to pair with. */
export function toggleSessionSplit(): boolean {
  installActiveSessionFollow();
  if (current) {
    publish(null);
    return true;
  }
  return previousSessionId !== null && openSessionInSplit(previousSessionId);
}

/** The split's other chat, for "focus the other chat". */
export function splitOtherSessionId(): string | null {
  return companionSessionId(current);
}

export function swapSessionSplit(): void {
  if (current) publish(swapSplitSides(current));
}

export function setSessionSplitRatio(ratio: number, opts: { remember?: boolean } = {}): void {
  if (!current) return;
  const next = clampSplitRatio(ratio);
  if (next !== current.ratio) publish({ ...current, ratio: next });
  if (opts.remember) {
    try { storage("local")?.setItem(RATIO_KEY, String(next)); } catch { /* preference only */ }
  }
}

// The split follows the active chat wherever it changes (navigator, palette,
// deep link, deletion), so the store subscription lives here, installed with
// the first reader rather than by the shell. Chats are not pruned from the
// session list: a list page holds only recent chats, so a missing row is not
// a deleted chat. The companion pane ends the split when its chat answers 404.
let followInstalled = false;
function installActiveSessionFollow(): void {
  if (followInstalled) return;
  followInstalled = true;
  let lastActive = getState().activeSessionId;
  // A restored pair meets the chat the URL reopened. Boot may not have
  // restored it yet (null); the change that does is followed below.
  if (lastActive !== null) publish(followActiveSession(current, lastActive));
  subscribeStore(() => {
    const active = getState().activeSessionId;
    if (active === lastActive) return;
    if (lastActive !== null) previousSessionId = lastActive;
    lastActive = active;
    publish(followActiveSession(current, active));
  });
}

/** End the split because one of its chats is gone. */
export function dropSplitSession(sessionId: string): void {
  publish(pruneSplit(current, new Set([sessionId])));
}
