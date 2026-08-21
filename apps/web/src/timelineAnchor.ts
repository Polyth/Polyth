// UX-PANE-MODEL: per-session timeline position as a STABLE anchor — the id of
// the topmost visible prompt plus its pixel offset and an at-bottom flag —
// never a raw global scrollTop. Full-screen/expanded pane transitions keep the
// live DOM (Chat stays mounted under the layer), so this record only matters
// for direct reload and session switches, where it is reapplied after event
// replay and window growth. Presentation state: appends no SessionEvent.
// sessionStorage scopes it to the tab so parallel tabs don't fight.

export interface TimelineAnchor {
  /** data-msg-id of the topmost visible prompt; null when none applies. */
  id: string | null;
  /** Anchor row top relative to the scroller top, in px. */
  offset: number;
  atBottom: boolean;
}

const KEY = "polyth.timelineAnchor.";

export function parseTimelineAnchor(raw: string | null): TimelineAnchor | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<TimelineAnchor>;
    if (typeof v !== "object" || v === null) return null;
    const id = typeof v.id === "string" ? v.id : null;
    const offset = typeof v.offset === "number" && Number.isFinite(v.offset) ? v.offset : 0;
    const atBottom = v.atBottom === true;
    if (id === null && !atBottom) return null; // nothing restorable
    return { id, offset, atBottom };
  } catch {
    return null;
  }
}

export function loadTimelineAnchor(sessionId: string): TimelineAnchor | null {
  try {
    return parseTimelineAnchor(sessionStorage.getItem(KEY + sessionId));
  } catch {
    return null;
  }
}

export function saveTimelineAnchor(sessionId: string, anchor: TimelineAnchor): void {
  try {
    sessionStorage.setItem(KEY + sessionId, JSON.stringify(anchor));
  } catch {
    // storage unavailable (private mode/quota): position simply isn't restored
  }
}

/** Topmost visible anchored row: first [data-msg-id] whose bottom edge is at
 *  or below the scroller's top edge (document order = timeline order). */
export function captureTimelineAnchor(el: HTMLElement, atBottom: boolean): TimelineAnchor {
  if (atBottom) return { id: null, offset: 0, atBottom: true };
  const top = el.getBoundingClientRect().top;
  for (const node of el.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom >= top) {
      return { id: node.dataset.msgId ?? null, offset: r.top - top, atBottom: false };
    }
  }
  return { id: null, offset: 0, atBottom: false };
}
