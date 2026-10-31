// Dismissed and ticked-off key callouts, per session and turn, plus whether the
// strip is folded. Presentation preferences, so they live in this browser's
// storage and never in session history. Only the latest turn of each session is
// kept (a new turn brings new callouts), and only the most recently touched
// sessions, so the record stays small.

const STORAGE_KEY = "polyth.recap.dismissedCallouts.v1";
const COLLAPSED_KEY = "polyth.recap.calloutsCollapsed.v1";
const MAX_SESSIONS = 100;

interface Entry { atSeq: number; ids: string[]; done?: string[] }
export interface DismissedCallouts { atSeq: number; ids: ReadonlySet<string>; done: ReadonlySet<string>; key: string }

let cache: Map<string, Entry> | null = null;
let collapsed: boolean | null = null;
const snapshots = new Map<string, DismissedCallouts>();
const listeners = new Set<() => void>();
const EMPTY: DismissedCallouts = { atSeq: 0, ids: new Set(), done: new Set(), key: "" };
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): Map<string, Entry> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      for (const row of raw) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const entry = row[1] as Partial<Entry> | undefined;
        if (typeof entry?.atSeq !== "number" || !Array.isArray(entry.ids)) continue;
        cache.set(row[0], { atSeq: entry.atSeq, ids: strings(entry.ids), done: strings(entry.done) });
      }
    }
  } catch {
    // A corrupt or unreadable record only means nothing stays dismissed.
  }
  return cache;
}

function save(entries: Map<string, Entry>): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...entries]));
  } catch {
    // Storage full or denied: dismissal still holds for this page.
  }
}

export function dismissedCallouts(sessionId: string): DismissedCallouts {
  const entry = load().get(sessionId);
  if (!entry) return EMPTY;
  const done = entry.done ?? [];
  const key = `${entry.atSeq}:${entry.ids.join(",")}:${done.join(",")}`;
  const cached = snapshots.get(sessionId);
  if (cached?.key === key) return cached;
  const snapshot = { atSeq: entry.atSeq, ids: new Set(entry.ids), done: new Set(done), key };
  snapshots.set(sessionId, snapshot);
  return snapshot;
}

function update(sessionId: string, atSeq: number, change: (entry: Entry) => Entry): void {
  const entries = load();
  const previous = entries.get(sessionId);
  const current = previous?.atSeq === atSeq ? previous : { atSeq, ids: [] };
  entries.delete(sessionId);
  entries.set(sessionId, change(current));
  while (entries.size > MAX_SESSIONS) entries.delete(entries.keys().next().value!);
  save(entries);
  for (const listener of listeners) listener();
}

export function dismissCallouts(sessionId: string, atSeq: number, ids: readonly string[]): void {
  update(sessionId, atSeq, (entry) => ({ ...entry, ids: [...new Set([...entry.ids, ...ids])] }));
}

/** Tick a callout off (a step done, a question answered, a risk taken in), or back on. */
export function setCalloutDone(sessionId: string, atSeq: number, id: string, done: boolean): void {
  update(sessionId, atSeq, (entry) => {
    const rest = (entry.done ?? []).filter((item) => item !== id);
    return { ...entry, done: done ? [...rest, id] : rest };
  });
}

/** One fold state for every strip: someone who folds it wants it quiet. */
export function calloutsCollapsed(): boolean {
  if (collapsed === null) {
    try {
      collapsed = storage()?.getItem(COLLAPSED_KEY) === "1";
    } catch {
      collapsed = false;
    }
  }
  return collapsed;
}

export function setCalloutsCollapsed(value: boolean): void {
  collapsed = value;
  try {
    if (value) storage()?.setItem(COLLAPSED_KEY, "1");
    else storage()?.removeItem(COLLAPSED_KEY);
  } catch {
    // Storage full or denied: the fold still holds for this page.
  }
  for (const listener of listeners) listener();
}

export function subscribeDismissed(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests: forget the in-memory copy so the next read comes from storage. */
export function resetDismissedCacheForTests(): void {
  cache = null;
  collapsed = null;
  snapshots.clear();
}
