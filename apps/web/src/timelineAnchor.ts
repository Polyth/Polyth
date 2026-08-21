// UX-PANE-MODEL: per-session timeline position as a STABLE anchor — the id of
// the topmost visible prompt plus its pixel offset and an at-bottom flag —
// never a raw global scrollTop. Full-screen/expanded pane transitions keep the
// live DOM (Chat stays mounted under the layer), so this record only matters
// for direct reload and session switches, where it is reapplied after event
// replay and window growth. Presentation state: appends no SessionEvent.
// sessionStorage scopes it to the tab so parallel tabs don't fight.
//
// UX-TIMELINE-LAYOUT-01: capture and restore are relative to the USABLE
// content edge, not the raw scrollport top. Reserved utility chrome lives
// outside the scroll root, so the inset is normally zero — but the helper
// owns that invariant: if future in-scrollport sticky/overlay chrome appears,
// the anchor row is the first row visible BELOW it, and restoration realigns
// to the same usable edge instead of silently parking a row behind chrome.

export interface TimelineAnchor {
  /** data-msg-id of the topmost visible prompt; null when none applies. */
  id: string | null;
  /** Anchor row top relative to the scroller's usable content edge, in px. */
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

/** Height of any sticky/fixed/absolute chrome painting over the scroller's
 *  top band. The reserved utility layout keeps chrome out of the scrollport,
 *  so this is normally 0 — measuring it anyway means a future in-scrollport
 *  bar cannot silently occlude the captured or restored anchor row. */
export function usableTopInset(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top;
  let inset = 0;
  for (const child of el.children) {
    const pos = getComputedStyle(child).position;
    if (pos !== "sticky" && pos !== "fixed" && pos !== "absolute") continue;
    const r = child.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.top <= top + 1 && r.bottom > top) inset = Math.max(inset, r.bottom - top);
  }
  return inset;
}

/** The usable content edge: scroller top plus any top-chrome inset. */
export function usableTopEdge(el: HTMLElement, inset: number = usableTopInset(el)): number {
  return el.getBoundingClientRect().top + inset;
}

/** Topmost USABLE-visible anchored row: first [data-msg-id] whose bottom edge
 *  is at or below the usable content edge (document order = timeline order).
 *  A row entirely behind top chrome is occluded, so it is never the anchor. */
export function captureTimelineAnchor(
  el: HTMLElement,
  atBottom: boolean,
  inset: number = usableTopInset(el),
): TimelineAnchor {
  if (atBottom) return { id: null, offset: 0, atBottom: true };
  const edge = usableTopEdge(el, inset);
  for (const node of el.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom >= edge) {
      return { id: node.dataset.msgId ?? null, offset: r.top - edge, atBottom: false };
    }
  }
  return { id: null, offset: 0, atBottom: false };
}

/** scrollTop delta that realigns `row` to the anchor's remembered offset from
 *  the usable content edge. */
export function restoreScrollDelta(
  el: HTMLElement,
  row: Element,
  anchor: TimelineAnchor,
  inset: number = usableTopInset(el),
): number {
  return row.getBoundingClientRect().top - usableTopEdge(el, inset) - anchor.offset;
}
