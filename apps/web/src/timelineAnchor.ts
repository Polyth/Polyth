// UX-A390 repair: per-session timeline scroll anchor. Browser-local
// presentation state (localStorage polyth.timelineAnchors) — never session
// data, never appended to the event log. A session that was following the
// bottom keeps following after reload; a session scrolled back restores its
// exact reading position. Entries are LRU-capped so storage stays bounded.

export interface TimelineAnchor {
  /** Within the follow threshold of the bottom — keep following new rows. */
  atBottom: boolean;
  /** Exact scroll offset, meaningful when not at the bottom. */
  scrollTop: number;
}

export const TIMELINE_ANCHORS_KEY = "polyth.timelineAnchors";
export const MAX_TIMELINE_ANCHORS = 50;

/** Parse the stored anchor map; malformed input or entries are dropped and
 *  the map is capped to the most recently saved sessions. */
export function parseTimelineAnchors(raw: string | null): Record<string, TimelineAnchor> {
  try {
    const data = JSON.parse(raw ?? "") as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    const out: Record<string, TimelineAnchor> = {};
    for (const [id, entry] of Object.entries(data).slice(-MAX_TIMELINE_ANCHORS)) {
      if (!id || typeof entry !== "object" || entry === null) continue;
      const a = entry as Partial<TimelineAnchor>;
      if (typeof a.atBottom !== "boolean") continue;
      if (typeof a.scrollTop !== "number" || !Number.isFinite(a.scrollTop) || a.scrollTop < 0) continue;
      out[id] = { atBottom: a.atBottom, scrollTop: Math.round(a.scrollTop) };
    }
    return out;
  } catch {
    return {};
  }
}

function readAll(): Record<string, TimelineAnchor> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(TIMELINE_ANCHORS_KEY); } catch { /* private mode / no DOM */ }
  return parseTimelineAnchors(raw);
}

export function loadTimelineAnchor(sessionId: string): TimelineAnchor | null {
  return readAll()[sessionId] ?? null;
}

/** Insert-last keeps key order as recency, so the cap drops the oldest. */
export function saveTimelineAnchor(sessionId: string, anchor: TimelineAnchor): void {
  const all = readAll();
  delete all[sessionId];
  const entries = [...Object.entries(all), [sessionId, {
    atBottom: anchor.atBottom,
    scrollTop: Math.max(0, Math.round(anchor.scrollTop)),
  }] as const].slice(-MAX_TIMELINE_ANCHORS);
  try {
    localStorage.setItem(TIMELINE_ANCHORS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* private mode / no DOM */ }
}
