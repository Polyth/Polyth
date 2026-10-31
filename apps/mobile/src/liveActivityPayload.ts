/** DOM- and Capacitor-free shape of the one Polyth Live Activity (Dynamic
 * Island / Lock Screen). Mirrors `PolythActivityAttributes.ContentState`
 * (apps/mobile/ios/App/App/PolythActivityAttributes.swift); native re-validates
 * every field, so these bounds are a courtesy, not the security boundary. */
export type LiveActivityState = "needs-approval" | "needs-reply" | "working" | "failed" | "done";

export interface LiveActivitySnapshot {
  state: LiveActivityState;
  sessionId: string;
  title: string;
  /** Pending question / approval / current task; may be empty. */
  detail: string;
  /** Short localized status word. */
  label: string;
  /** Localized line about the other chats; may be empty. */
  summary: string;
  /** Localized hint the system shows once the snapshot is stale. */
  staleHint: string;
  /** Start of the current work (epoch ms) for the system-drawn timer. */
  startedAt?: number;
  done: number;
  total: number;
}

export const LIVE_ACTIVITY_LIMITS = { title: 120, detail: 240, label: 48, summary: 80, staleHint: 80 } as const;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const STATES: ReadonlySet<string> = new Set(["needs-approval", "needs-reply", "working", "failed", "done"]);

function clamp(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const count = (value: number): number => (Number.isSafeInteger(value) && value > 0 ? Math.min(value, 999) : 0);

/** Normalized snapshot, or undefined when it cannot be shown at all. */
export function normalizeLiveActivitySnapshot(value: LiveActivitySnapshot): LiveActivitySnapshot | undefined {
  if (!STATES.has(value.state) || !SESSION_ID.test(value.sessionId)) return undefined;
  const title = clamp(value.title, LIVE_ACTIVITY_LIMITS.title);
  if (!title) return undefined;
  const total = count(value.total);
  const snapshot: LiveActivitySnapshot = {
    state: value.state,
    sessionId: value.sessionId,
    title,
    detail: clamp(value.detail, LIVE_ACTIVITY_LIMITS.detail),
    label: clamp(value.label, LIVE_ACTIVITY_LIMITS.label),
    summary: clamp(value.summary, LIVE_ACTIVITY_LIMITS.summary),
    staleHint: clamp(value.staleHint, LIVE_ACTIVITY_LIMITS.staleHint),
    done: Math.min(count(value.done), total),
    total,
  };
  if (typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt > 0) {
    snapshot.startedAt = Math.floor(value.startedAt);
  }
  return snapshot;
}

/** Stable comparison key: identical keys never cross the bridge twice. */
export function liveActivitySnapshotKey(snapshot: LiveActivitySnapshot | null): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}

/** `polyth://live-activity/<sessionId>` — the tap target the extension sets.
 * Deliberately not a general deep link (`mobileDeepLinkPath` ignores it): only
 * the page that published the activity may act on it. */
export function liveActivitySessionFromUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "polyth:" || url.hostname !== "live-activity" || url.search || url.hash) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
  } catch {
    return undefined;
  }
  return SESSION_ID.test(id) ? id : undefined;
}
