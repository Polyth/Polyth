/** Pure, bounded extractor-output validation. Kept separate so the security
 * behavior can be tested without booting the package graph or a provider. */
export interface HarvestCandidate {
  title: string;
  body: string;
  category?: string;
  tags?: string[];
}

export interface HarvestSourceEvent {
  seq: number;
  type: string;
  data: unknown;
}

const sourceObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A persisted turn opt-out applies to its user event and following assistant
 * events until the next user event starts a new turn. */
export function rememberOff(event: HarvestSourceEvent): boolean {
  if (event.type !== "user/message") return false;
  return sourceObject(sourceObject(event.data).memory).remember === "off";
}

export type HarvestSegment = { start: number; end: number; excluded: boolean };

export function harvestSegments(events: readonly HarvestSourceEvent[], start: number, end: number): HarvestSegment[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let excluded = false;
  for (const event of ordered) {
    if (event.seq >= start) break;
    if (event.type === "user/message") excluded = rememberOff(event);
  }
  const segments: HarvestSegment[] = [];
  for (const event of ordered) {
    if (event.seq < start || event.seq > end) continue;
    const currentExcluded = event.type === "user/message" ? rememberOff(event) : excluded;
    const previous = segments.at(-1);
    if (!previous || previous.excluded !== currentExcluded || event.seq > previous.end + 1) {
      segments.push({ start: event.seq, end: event.seq, excluded: currentExcluded });
    } else {
      previous.end = event.seq;
    }
    if (event.type === "user/message") excluded = rememberOff(event);
  }
  if (!segments.length) return [{ start, end, excluded }];
  if (segments.at(-1)!.end < end) segments.at(-1)!.end = end;
  return segments;
}

const secretPatterns = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const injectionPattern = /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i;
const urlPattern = /\bhttps?:\/\//i;

const redact = (value: string): string => secretPatterns.reduce((out, pattern) => out.replace(pattern, "[redacted]"), value).slice(0, 8_000);

export const sanitizeHarvestText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = redact(value).replace(/\0/g, "").trim();
  return clean && !injectionPattern.test(clean) && !urlPattern.test(clean) ? clean : undefined;
};

export function parseHarvestExtraction(value: string): HarvestCandidate[] | undefined {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).memories
    : undefined);
  if (!Array.isArray(rows)) return undefined;
  const out: HarvestCandidate[] = [];
  for (const row of rows.slice(0, 8)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const title = sanitizeHarvestText(item.title);
    const body = sanitizeHarvestText(item.body);
    if (!title || !body || title.length > 160 || Buffer.byteLength(body, "utf8") > 8 * 1024) continue;
    const tags = Array.isArray(item.tags)
      ? item.tags.map(sanitizeHarvestText).filter((tag): tag is string => !!tag).slice(0, 12)
      : undefined;
    out.push({ title, body, ...(typeof item.category === "string" ? { category: item.category } : {}), ...(tags ? { tags } : {}) });
  }
  return rows.length > 0 && out.length === 0 ? undefined : out;
}
