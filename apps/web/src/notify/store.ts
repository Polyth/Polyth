// The one transient-notification standard. Every passing message the shell or
// a package shows — an error, a finished run, a new version, a hint, news —
// is a record here and is drawn by the single <NotificationStack/>. The
// persistent inbox (NotificationCentre) is a different thing: server records
// that outlive a page load.
//
// The store owns identity and lifetime; the stack owns geometry, motion and
// announcements. A record keyed by an `id` is updated in place (no second
// card). Only cards a person can actually read count down: the newest
// `MAX_VISIBLE` while the deck is open, only the front one while it is folded
// (the folded ones keep what they had left). Every countdown stops together
// while the person is on the stack (hover, focus, touch) or the page is
// hidden, so nothing leaves while it is being read.
import { useSyncExternalStore } from "react";
import type {
  WebNotificationDismissReason,
  WebNotificationHandle,
  WebNotificationInput,
  WebNotificationKind,
  WebNotificationPatch,
} from "@polyth/web-sdk";

/** Transient kinds mirror the web-sdk set plus the two people kinds the
 *  notification centre can carry, so one glyph/duration record stays total. */
export type NotificationKind = WebNotificationKind | "mention" | "message";
/** One message on a conversation card, oldest first. */
export interface ConversationNoticeLine {
  /** The inbox row it came from. */
  id: string;
  author: { userId: string; name: string } | null;
  text: string;
  /** It mentions the reader. */
  mention: boolean;
  ts: number;
}

/** A person's message or mention, drawn as a messenger card: who wrote it
 *  (their colour and monogram), where, the newest lines of a burst and a
 *  reply field. Shell only; packages never show one. */
export interface ConversationNotice {
  sessionId: string;
  /** The chat's title. */
  chat: string;
  /** The newest few, oldest first. */
  lines: readonly ConversationNoticeLine[];
  /** How many messages the card stands for (at least `lines.length`). */
  count: number;
  /** One of them mentions the reader (even one no longer among `lines`). */
  mention?: boolean;
  open(): void;
  /** Posts a reply as the reader; rejects when it did not go through. */
  reply?(text: string): Promise<void>;
}

/** Packages show web-sdk kinds; the shell may also show the people kinds
 *  (a new message or mention in a chat the person is not looking at). */
export type NotificationInput = Omit<WebNotificationInput, "kind"> & {
  kind: NotificationKind;
  conversation?: ConversationNotice;
};
export type NotificationPatch = WebNotificationPatch;
export type NotificationHandle = WebNotificationHandle;
export type NotificationDismissReason = WebNotificationDismissReason;

export interface NotificationRecord extends NotificationInput {
  id: string;
  /** Recency: a fresh `notify()` (new or replacing) moves a record to the front. */
  seq: number;
  /** Bumped on every content change; the stack re-announces on a new seq only. */
  revision: number;
  /** Bumped whenever the countdown restarts (the hairline restarts with it). */
  life: number;
  /** Resolved lifetime: ms, or "sticky". */
  duration: number | "sticky";
  dismissible: boolean;
}

export interface NotificationSnapshot {
  /** Oldest first; the stack shows the last `MAX_VISIBLE`, newest nearest the edge. */
  items: readonly NotificationRecord[];
  paused: boolean;
}

/** Cards on screen at once; the rest wait their turn without counting down. */
export const MAX_VISIBLE = 3;
/** Records kept at all; past this the oldest non-sticky one is dropped. */
export const MAX_RECORDS = 24;

/** How long each kind stays by default. Progress and updates wait for their
 *  owner (or the person); everything else leaves by itself. */
export const DEFAULT_DURATION: Readonly<Record<NotificationKind, number | "sticky">> = {
  error: 7_000,
  warning: 7_000,
  success: 5_000,
  info: 5_000,
  mention: 10_000,
  message: 8_000,
  hint: 8_000,
  news: 10_000,
  progress: "sticky",
  update: "sticky",
};

interface Timing {
  remaining: number;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let items: NotificationRecord[] = [];
let snapshot: NotificationSnapshot = { items, paused: false };
const timing = new Map<string, Timing>();
const pauses = new Set<string>();
const listeners = new Set<() => void>();
let seq = 0;
let anonymous = 0;
/** Whether the stack shows every visible card (true) or a folded deck with
 *  only the front one readable. With no stack mounted all visible cards run. */
let deckOpen = true;

/** `data` keys become `data-*` attributes: lowercase words and dashes only. */
const DATA_KEY = /^[a-z0-9-]+$/;

function emit(): void {
  snapshot = { items, paused: pauses.size > 0 };
  for (const listener of [...listeners]) listener();
}

function cleanData(data: NotificationInput["data"]): NotificationInput["data"] {
  if (!data) return data;
  const kept = Object.entries(data).filter(([key, value]) => DATA_KEY.test(key) && typeof value === "string");
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

function resolve(input: NotificationInput, id: string, previous?: NotificationRecord): NotificationRecord {
  const { id: _id, duration, dismissible, data, ...rest } = input;
  const safeData = cleanData(data);
  return {
    ...rest,
    ...(safeData ? { data: safeData } : {}),
    id,
    seq: ++seq,
    revision: (previous?.revision ?? 0) + 1,
    life: (previous?.life ?? 0) + 1,
    duration: normalizeDuration(duration ?? DEFAULT_DURATION[input.kind] ?? 5_000),
    dismissible: dismissible ?? true,
  };
}

function normalizeDuration(value: number | "sticky"): number | "sticky" {
  return value === "sticky" || !Number.isFinite(value) || value <= 0 ? "sticky" : Math.round(value);
}

function stopTimer(id: string): void {
  const entry = timing.get(id);
  if (!entry?.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.startedAt !== null) entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  entry.startedAt = null;
}

/** Start or stop every countdown so only readable, unpaused, timed records run:
 *  the visible ones while the deck is open, only the front one while folded. */
function schedule(): void {
  const visible = new Set(items.slice(deckOpen ? -MAX_VISIBLE : -1).map((item) => item.id));
  const paused = pauses.size > 0;
  for (const item of items) {
    const entry = timing.get(item.id);
    if (!entry) continue;
    const run = item.duration !== "sticky" && visible.has(item.id) && !paused;
    if (!run) { stopTimer(item.id); continue; }
    if (entry.timer) continue;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => {
      entry.timer = null;
      dismissNotification(item.id, "timeout");
    }, entry.remaining);
  }
}

function restartLife(record: NotificationRecord): void {
  stopTimer(record.id);
  timing.set(record.id, {
    remaining: record.duration === "sticky" ? 0 : record.duration,
    startedAt: null,
    timer: null,
  });
}

function trim(): void {
  while (items.length > MAX_RECORDS) {
    const victim = items.find((item) => item.duration !== "sticky") ?? items[0]!;
    remove(victim.id, "overflow");
  }
}

function remove(id: string, reason: NotificationDismissReason): NotificationRecord | null {
  const record = items.find((item) => item.id === id);
  if (!record) return null;
  stopTimer(id);
  timing.delete(id);
  items = items.filter((item) => item.id !== id);
  try { record.onDismiss?.(reason); } catch { /* an owner's callback never breaks the stack */ }
  return record;
}

/**
 * Show a notification, or — when `id` names one already on screen — replace
 * it in place and move it to the front. Returns a handle to update or dismiss
 * it later.
 */
export function notify(input: NotificationInput): NotificationHandle {
  const id = input.id ?? `notify-${++anonymous}`;
  const previous = items.find((item) => item.id === id);
  const record = resolve(input, id, previous);
  items = [...items.filter((item) => item.id !== id), record];
  restartLife(record);
  trim();
  schedule();
  emit();
  return handleFor(id);
}

/**
 * Change a notification in place without moving it. Its countdown restarts
 * only when the patch names a `duration` (e.g. a progress that has finished).
 */
export function updateNotification(id: string, patch: NotificationPatch): boolean {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const current = items[index]!;
  const { duration, dismissible, data, ...rest } = patch;
  const next: NotificationRecord = {
    ...current,
    ...rest,
    ...("data" in patch ? { data: cleanData(data) } : {}),
    revision: current.revision + 1,
    ...(dismissible !== undefined ? { dismissible } : {}),
  };
  if (duration !== undefined) {
    next.duration = normalizeDuration(duration);
    next.life = current.life + 1;
  }
  items = items.map((item, at) => (at === index ? next : item));
  if (duration !== undefined) restartLife(next);
  schedule();
  emit();
  return true;
}

export function dismissNotification(id: string, reason: NotificationDismissReason = "programmatic"): boolean {
  if (!remove(id, reason)) return false;
  schedule();
  emit();
  return true;
}

/** Close every notification the person may close (the stack's "Clear all"). */
export function dismissAllNotifications(reason: NotificationDismissReason = "user"): number {
  const closable = items.filter((item) => item.dismissible).map((item) => item.id);
  for (const id of closable) remove(id, reason);
  if (closable.length > 0) {
    schedule();
    emit();
  }
  return closable.length;
}

export function handleFor(id: string): NotificationHandle {
  return {
    id,
    update: (patch) => { updateNotification(id, patch); },
    dismiss: () => { dismissNotification(id, "programmatic"); },
  };
}

/** Hold every countdown while `source` (hover, focus, touch, hidden…) lasts. */
export function pauseNotifications(source: string): void {
  if (pauses.has(source)) return;
  pauses.add(source);
  schedule();
  emit();
}

export function resumeNotifications(source: string): void {
  if (!pauses.delete(source)) return;
  schedule();
  emit();
}

/** The stack reports whether its deck is open; while folded only the front
 *  card counts down. */
export function setNotificationDeckOpen(open: boolean): void {
  if (deckOpen === open) return;
  deckOpen = open;
  schedule();
}

/** What is left of a record's lifetime right now, ms (null: sticky/unknown).
 *  A card mounting again (back from the queue) resumes its hairline here. */
export function notificationRemaining(id: string): number | null {
  const entry = timing.get(id);
  const record = items.find((item) => item.id === id);
  if (!entry || !record || record.duration === "sticky") return null;
  const running = entry.startedAt !== null ? Date.now() - entry.startedAt : 0;
  return Math.max(0, entry.remaining - running);
}

export function getNotifications(): NotificationSnapshot {
  return snapshot;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useNotifications(): NotificationSnapshot {
  return useSyncExternalStore(subscribeNotifications, getNotifications, getNotifications);
}

/** Tests only: forget every record, timer and pause. */
export function resetNotifications(): void {
  for (const id of timing.keys()) stopTimer(id);
  timing.clear();
  pauses.clear();
  deckOpen = true;
  items = [];
  emit();
}

/** The host's public face of this store (`host.notifications`). */
export const notifications = {
  show: notify,
  update: updateNotification,
  dismiss: (id: string) => { dismissNotification(id, "programmatic"); },
};
