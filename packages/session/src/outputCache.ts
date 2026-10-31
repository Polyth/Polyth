// Oversized tool-output paging cache.
//
// A tool that returns more than `MAX_CACHED_CHARS` of text does not reach the
// model whole: hard truncation is what loses the error line in the middle of a
// 50k-line test log. The full text stays in a bounded per-session in-memory
// cache under a virtual URI, and the model receives a head/tail preview plus
// the URI so it can page to the region it actually needs.
//
// This module is deliberately dependency-free (no node imports): the cache is
// plain process memory, never a persistence boundary. Cache content is derived
// model input, so it is evicted rather than written to disk.
//
// Erasable TypeScript only. Local imports use explicit .ts.

/** ~4k tokens. Below this the whole output is cheap enough to send as-is. */
export const MAX_PAGED_CHARS = 16_000;
/** Preview budget: the head carries the command/invocation, the tail the failure. */
export const PAGED_HEAD_CHARS = 2_000;
export const PAGED_TAIL_CHARS = 1_000;
/** Per-session ceiling. Oldest entries are evicted first (FIFO). */
export const MAX_CACHE_BYTES_PER_SESSION = 16 * 1024 * 1024;
/** Process-wide ceiling: idle sessions never age their entries, so without it
 *  the cache would grow with the number of sessions. Oldest entry, any session,
 *  is evicted first. */
export const MAX_CACHE_BYTES_TOTAL = 64 * 1024 * 1024;
/** Entry lifetime, counted in completed agent turns. */
export const CACHE_TTL_TURNS = 5;

export const OUTPUT_CACHE_SCHEME = "polyth://cache/";
export const READ_FILE_TOOL_NAME = "read_file";

export interface OutputCacheEntryMeta {
  /** Tool that produced the output, when the caller knows it. */
  tool?: string;
  /** Workspace-relative or absolute origin of the text. */
  source?: string;
}

/** A cached payload plus the model-facing preview that replaced it. */
export type PagedOutput =
  /** Small enough to deliver unchanged. */
  | { paged: false; output: string }
  /** `output` is the bounded preview of the text cached at `uri`. */
  | { paged: true; output: string; uri: string; totalLines: number; totalChars: number };

export interface OutputCacheSlice {
  uri: string;
  /** 1-based inclusive bounds actually returned. */
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  lines: string[];
}

export interface OutputCacheOptions {
  maxChars?: number;
  headChars?: number;
  tailChars?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  ttlTurns?: number;
  /** Injected for deterministic ids in tests. */
  newId?: () => string;
}

interface StoredEntry {
  uri: string;
  sessionId: string;
  lines: string[];
  totalChars: number;
  bytes: number;
  turnsLeft: number;
  meta?: OutputCacheEntryMeta;
}

/** `polyth://cache/tool_<id>` → `<id>`, or undefined for any other input. */
export function parseOutputCacheUri(uri: string): string | undefined {
  if (!uri.startsWith(OUTPUT_CACHE_SCHEME)) return undefined;
  const id = uri.slice(OUTPUT_CACHE_SCHEME.length).replace(/\/+$/, "");
  return id || undefined;
}

export function isOutputCacheUri(uri: string): boolean {
  return parseOutputCacheUri(uri) !== undefined;
}

const defaultNewId = (): string => {
  const bytes = new Uint8Array(16);
  const random = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (random) return random.call(globalThis.crypto).replace(/-/g, "");
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// Accounted as in-memory UTF-16 size; encoding a multi-megabyte copy just to
// measure it would double the peak the budget exists to cap.
const byteLength = (text: string): number => text.length * 2;

/**
 * Per-session bounded store of oversized tool output.
 *
 * Three independent limits keep memory predictable: a per-entry trigger, a
 * per-session byte ceiling with FIFO eviction, and a turn-count TTL. Entries are
 * never shared across sessions — a URI is only resolvable by the session that
 * was told about it.
 */
export class SessionOutputCache {
  readonly maxChars: number;
  readonly headChars: number;
  readonly tailChars: number;
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly ttlTurns: number;
  private readonly newId: () => string;
  /** sessionId -> uri -> entry, insertion-ordered so eviction is FIFO. */
  private readonly entries = new Map<string, Map<string, StoredEntry>>();
  private readonly bytesBySession = new Map<string, number>();
  /** uri -> entry across every session, insertion-ordered for global FIFO. */
  private readonly order = new Map<string, StoredEntry>();
  private totalBytes = 0;

  constructor(options: OutputCacheOptions = {}) {
    this.maxChars = options.maxChars ?? MAX_PAGED_CHARS;
    this.headChars = options.headChars ?? PAGED_HEAD_CHARS;
    this.tailChars = options.tailChars ?? PAGED_TAIL_CHARS;
    this.maxBytes = options.maxBytes ?? MAX_CACHE_BYTES_PER_SESSION;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_CACHE_BYTES_TOTAL;
    this.ttlTurns = options.ttlTurns ?? CACHE_TTL_TURNS;
    this.newId = options.newId ?? defaultNewId;
  }

  /** Store raw text and return its virtual URI. */
  store(
    sessionId: string,
    text: string,
    meta?: OutputCacheEntryMeta,
  ): { uri: string; totalLines: number; totalChars: number } {
    const uri = `${OUTPUT_CACHE_SCHEME}tool_${this.newId()}`;
    const lines = text.split("\n");
    const entry: StoredEntry = {
      uri,
      sessionId,
      lines,
      totalChars: text.length,
      bytes: byteLength(text),
      turnsLeft: this.ttlTurns,
      ...(meta ? { meta } : {}),
    };
    this.insert(sessionId, entry);
    return { uri, totalLines: lines.length, totalChars: text.length };
  }

  /**
   * Bound one tool output for the model. Small outputs pass through untouched
   * so the common path stays byte-identical to today.
   */
  page(
    sessionId: string,
    text: string,
    meta?: OutputCacheEntryMeta,
  ): PagedOutput {
    if (text.length <= this.maxChars) return { paged: false, output: text };
    const stored = this.store(sessionId, text, meta);
    const head = text.slice(0, this.headChars);
    const tail = text.slice(Math.max(this.headChars, text.length - this.tailChars));
    const note = [
      "",
      `Output truncated. Full output (${stored.totalLines} lines) cached at ${stored.uri}.`,
      `You can inspect specific lines using ${READ_FILE_TOOL_NAME} with start_line and end_line.`,
    ].join("\n");
    return {
      paged: true,
      output: `${head}\n[... ${text.length - this.headChars - this.tailChars} characters omitted ...]\n${tail}${note}`,
      uri: stored.uri,
      totalLines: stored.totalLines,
      totalChars: stored.totalChars,
    };
  }

  /**
   * Resolve a virtual URI to a line range. 1-based inclusive bounds, clamped to
   * the entry; an out-of-range request is an error the caller can report, never
   * a silent empty read. Returns undefined for an unknown or foreign URI so the
   * caller can distinguish "not cached" from "cached but empty".
   */
  read(
    sessionId: string,
    uri: string,
    range: { startLine?: number; endLine?: number } = {},
  ): OutputCacheSlice | undefined {
    const entry = this.entries.get(sessionId)?.get(uri);
    if (!entry) return undefined;
    const totalLines = entry.lines.length;
    const startLine = clampLine(range.startLine, 1, totalLines);
    // An unbounded request reads the whole entry; a bounded one is clamped to it,
    // and a reversed range still yields at least the requested start line.
    const endLine = Math.max(startLine, clampLine(range.endLine, totalLines, totalLines));
    return {
      uri: entry.uri,
      startLine,
      endLine,
      totalLines,
      totalChars: entry.totalChars,
      lines: entry.lines.slice(startLine - 1, endLine),
    };
  }

  has(sessionId: string, uri: string): boolean {
    return this.entries.get(sessionId)?.has(uri) ?? false;
  }

  /**
   * One completed agent turn. Every entry ages by one; anything that reaches
   * zero turns is evicted. Called on the canonical terminal turn event so the
   * TTL tracks real conversation turns, not wall-clock time.
   */
  advanceTurn(sessionId: string): void {
    const entries = this.entries.get(sessionId);
    if (!entries) return;
    for (const [uri, entry] of [...entries]) {
      entry.turnsLeft -= 1;
      if (entry.turnsLeft <= 0) this.evict(sessionId, uri);
    }
    if (entries.size === 0) this.entries.delete(sessionId);
  }

  /** Drop every entry for one session. Called when the session closes. */
  clear(sessionId: string): void {
    for (const uri of [...(this.entries.get(sessionId)?.keys() ?? [])]) this.evict(sessionId, uri);
  }

  clearAll(): void {
    this.entries.clear();
    this.bytesBySession.clear();
    this.order.clear();
    this.totalBytes = 0;
  }

  bytes(sessionId: string): number {
    return this.bytesBySession.get(sessionId) ?? 0;
  }

  count(sessionId: string): number {
    return this.entries.get(sessionId)?.size ?? 0;
  }

  private insert(sessionId: string, entry: StoredEntry): void {
    let entries = this.entries.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.entries.set(sessionId, entries);
    }
    entries.set(entry.uri, entry);
    this.order.set(entry.uri, entry);
    this.totalBytes += entry.bytes;
    this.bytesBySession.set(sessionId, (this.bytesBySession.get(sessionId) ?? 0) + entry.bytes);
    this.evictToBudget(sessionId);
    for (const oldest of this.order.values()) {
      if (this.totalBytes <= this.maxTotalBytes) break;
      this.evict(oldest.sessionId, oldest.uri);
    }
  }

  /** FIFO: insertion order is the eviction order, so the newest entry survives. */
  private evictToBudget(sessionId: string): void {
    const entries = this.entries.get(sessionId);
    if (!entries) return;
    let bytes = this.bytesBySession.get(sessionId) ?? 0;
    for (const uri of [...entries.keys()]) {
      if (bytes <= this.maxBytes) break;
      this.evict(sessionId, uri);
      bytes = this.bytesBySession.get(sessionId) ?? 0;
    }
  }

  private evict(sessionId: string, uri: string): void {
    const entries = this.entries.get(sessionId);
    const entry = entries?.get(uri);
    if (!entries || !entry) return;
    entries.delete(uri);
    this.order.delete(uri);
    this.totalBytes -= entry.bytes;
    const remaining = Math.max(0, (this.bytesBySession.get(sessionId) ?? 0) - entry.bytes);
    if (remaining === 0) this.bytesBySession.delete(sessionId);
    else this.bytesBySession.set(sessionId, remaining);
    if (entries.size === 0) this.entries.delete(sessionId);
  }
}

const clampLine = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fallback;
  return Math.min(value as number, max);
};
