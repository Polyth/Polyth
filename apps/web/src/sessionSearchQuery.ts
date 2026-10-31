import type { SessionProjection } from "@polyth/contracts";

export type SessionSearchRole = "user" | "assistant";

export interface SessionSearchQuery {
  /** Free text sent to the server; facet tokens are stripped. */
  text: string;
  waiting: boolean;
  running: boolean;
  /** `is:archived` — archived sessions only (hidden by default). */
  archived: boolean;
  /** `from:me|user` / `from:agent|assistant` — message hits by author. */
  role?: SessionSearchRole;
}

const FACET_TOKEN = /(^|\s)(is|from):([a-z]+)(?=\s|$)/gi;

const ROLE_ALIASES: Record<string, SessionSearchRole> = {
  me: "user",
  user: "user",
  you: "user",
  agent: "assistant",
  assistant: "assistant",
  ai: "assistant",
};

/** Facet tokens the UI offers as chips; `from:` keeps one canonical alias each. */
export const SESSION_SEARCH_FACETS = [
  "is:waiting",
  "is:running",
  "is:archived",
  "from:me",
  "from:agent",
] as const;

export function parseSessionSearchQuery(raw: string): SessionSearchQuery {
  let waiting = false;
  let running = false;
  let archived = false;
  let role: SessionSearchRole | undefined;
  const text = raw
    .replace(FACET_TOKEN, (whole, lead: string, kind: string, value: string) => {
      const k = kind.toLowerCase();
      const v = value.toLowerCase();
      if (k === "is" && v === "waiting") { waiting = true; return lead; }
      if (k === "is" && v === "running") { running = true; return lead; }
      if (k === "is" && v === "archived") { archived = true; return lead; }
      if (k === "from" && ROLE_ALIASES[v]) { role = ROLE_ALIASES[v]; return lead; }
      return whole; // unknown facet stays searchable text
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, waiting, running, archived, ...(role ? { role } : {}) };
}

/** Toggle a facet token inside the raw query, preserving the free text. */
export function toggleSessionSearchFacet(raw: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "i");
  if (present.test(raw)) return raw.replace(present, "$1").replace(/\s+/g, " ").trim();
  // `from:` facets are exclusive — replace a sibling instead of stacking.
  const stripped = token.startsWith("from:")
    ? raw.replace(/(^|\s)from:[a-z]+(?=\s|$)/gi, "$1").replace(/\s+/g, " ").trim()
    : raw.trim();
  return stripped ? `${stripped} ${token}` : token;
}

export function matchesSessionSearchFacets(
  session: SessionProjection,
  query: Pick<SessionSearchQuery, "waiting" | "running"> & Partial<Pick<SessionSearchQuery, "archived">>,
): boolean {
  const waiting = session.status === "waiting"
    || (session.attention?.questions ?? 0) > 0
    || (session.attention?.permissions ?? 0) > 0;
  if (query.waiting && !waiting) return false;
  if (query.running && session.status !== "working") return false;
  // Archived chats stay searchable by default (everything, everywhere);
  // `is:archived` narrows to archived only.
  if (query.archived && session.status !== "archived") return false;
  return true;
}

/** Case/diacritic fold used for client-side title/branch matching. */
export function foldSearchText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Highlight ranges for every query term inside `text` (case/diacritic
 * insensitive, non-overlapping, merged when adjacent). Folding keeps code-unit
 * length for Latin/Cyrillic combining marks because NFD only strips marks the
 * original string did not have as separate code units; for scripts where the
 * fold changes length the helper falls back to no highlight rather than a
 * misaligned one.
 */
export function highlightRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!text) return [];
  const folded = foldSearchText(text);
  if (folded.length !== text.length) return [];
  const hits: Array<[number, number]> = [];
  for (const raw of terms) {
    const term = foldSearchText(raw);
    if (!term) continue;
    let from = 0;
    while (from <= folded.length - term.length) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      hits.push([at, at + term.length]);
      from = at + Math.max(1, term.length);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of hits) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Split `text` into plain/highlighted segments from `[start, end)` ranges. */
export function segmentHighlights(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const start = Math.max(cursor, Math.min(a, text.length));
    const end = Math.max(start, Math.min(b, text.length));
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) out.push({ text: text.slice(start, end), hit: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
