/** Client for `GET /api/files/session-edits`: every chat's edit calls in the
 * checkout a Files view shows, fetched incrementally (a cursor per chat) and
 * cached per chat for the page lifetime, so switching chats never rereads a
 * log from the start. */
import type { JsonObject } from "@polyth/contracts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import type { EditCall, EditSource } from "./checkoutEdits.ts";

interface CachedSource {
  sessionId: string;
  title: string;
  createdAt: number;
  parentId?: string;
  cursor: number;
  calls: Map<string, EditCall>;
}

interface WireCall {
  callId: string;
  seq: number;
  time: number;
  tool: string;
  input: JsonObject;
  metadata?: JsonObject;
  changedFiles: string[];
}

interface WireSource {
  sessionId: string;
  title: string;
  createdAt: number;
  parentId?: string;
  viewer: boolean;
  cursor: number;
  more: boolean;
  calls: WireCall[];
}

export interface CheckoutSourcesResult {
  /** Chats reported for the checkout, viewer first. */
  sources: EditSource[];
  /** A chat still has history beyond this response's budget. */
  more: boolean;
}

const MAX_CACHED_SOURCES = 24;
const MAX_CALLS_PER_SOURCE = 600;
const MAX_CURSORS = 16;
const cache = new Map<string, CachedSource>();
const inFlight = new Map<string, Promise<CheckoutSourcesResult>>();

function touch(source: CachedSource): void {
  cache.delete(source.sessionId);
  cache.set(source.sessionId, source);
  while (cache.size > MAX_CACHED_SOURCES) cache.delete(cache.keys().next().value!);
}

function merge(wire: WireSource): CachedSource {
  const cached = cache.get(wire.sessionId) ?? {
    sessionId: wire.sessionId, title: wire.title, createdAt: wire.createdAt, cursor: 0, calls: new Map<string, EditCall>(),
  };
  cached.title = wire.title;
  cached.createdAt = wire.createdAt;
  if (wire.parentId) cached.parentId = wire.parentId;
  // A cursor behind ours means the server started this chat over.
  if (wire.cursor < cached.cursor && wire.calls.length > 0 && wire.calls.every((call) => !cached.calls.has(call.callId))) {
    cached.calls.clear();
  }
  for (const call of wire.calls) {
    if (!call || typeof call.callId !== "string" || !Array.isArray(call.changedFiles)) continue;
    cached.calls.set(call.callId, {
      callId: call.callId,
      seq: call.seq,
      time: call.time,
      tool: call.tool,
      input: call.input ?? {},
      ...(call.metadata ? { metadata: call.metadata } : {}),
      changedFiles: call.changedFiles,
    });
  }
  if (cached.calls.size > MAX_CALLS_PER_SOURCE) {
    const newest = [...cached.calls.values()].sort((left, right) => right.seq - left.seq).slice(0, MAX_CALLS_PER_SOURCE);
    cached.calls = new Map(newest.map((call) => [call.callId, call]));
  }
  cached.cursor = wire.cursor;
  touch(cached);
  return cached;
}

const toSource = (cached: CachedSource, viewer: boolean): EditSource => ({
  sessionId: cached.sessionId,
  title: cached.title,
  createdAt: cached.createdAt,
  viewer,
  calls: [...cached.calls.values()].sort((left, right) => left.seq - right.seq),
});

/** Fetch newer edits of every chat sharing the viewer's checkout. */
export function fetchCheckoutSources(
  projectId: string,
  sessionId: string | null,
  fetcher: typeof fetch = fetch,
): Promise<CheckoutSourcesResult> {
  const flight = JSON.stringify([projectId, sessionId]);
  const existing = inFlight.get(flight);
  if (existing) return existing;
  const cursors = [...cache.values()]
    .filter((source) => source.cursor > 0)
    .slice(-MAX_CURSORS)
    .map((source) => `${source.sessionId}:${source.cursor}`)
    .join(",");
  const query = new URLSearchParams({ projectId, ...(sessionId ? { sessionId } : {}), ...(cursors ? { cursors } : {}) });
  const request = (async () => {
    const response = await fetcher(`/api/files/session-edits?${query}`);
    if (!response.ok) throw Object.assign(new Error(tr("files.changes.errUnavailable", { status: response.status })), { status: response.status });
    const body = await response.json() as { sources?: WireSource[] };
    const sources: EditSource[] = [];
    let more = false;
    for (const wire of Array.isArray(body.sources) ? body.sources : []) {
      if (!wire || typeof wire.sessionId !== "string" || !Array.isArray(wire.calls)) continue;
      more ||= wire.more === true;
      sources.push(toSource(merge(wire), wire.viewer === true));
    }
    return { sources, more };
  })().finally(() => {
    if (inFlight.get(flight) === request) inFlight.delete(flight);
  });
  inFlight.set(flight, request);
  return request;
}

/** Last fetched sources for a chat set without a request (first paint). */
export function cachedSource(sessionId: string, viewer: boolean): EditSource | null {
  const cached = cache.get(sessionId);
  return cached ? toSource(cached, viewer) : null;
}

export function resetSessionEditsCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}

/** The live render model's completed edit calls (newest-first window). */
export function liveEditCalls(messages: readonly { kind: string }[]): { calls: EditCall[]; lastUserSeq?: number } {
  const calls: EditCall[] = [];
  let lastUserSeq: number | undefined;
  for (const raw of messages) {
    const message = raw as {
      kind: string; id?: string; callId?: string; eventSeq?: number; time?: number; finishTime?: number;
      tool?: string; input?: JsonObject; metadata?: JsonObject; changedFiles?: string[]; status?: string; undone?: boolean;
    };
    if (message.kind === "user" && !message.undone && typeof message.eventSeq === "number") lastUserSeq = message.eventSeq;
    if (message.kind !== "tool" || message.status !== "done" || !message.changedFiles?.length) continue;
    calls.push({
      callId: message.callId ?? message.id ?? `seq:${message.eventSeq}`,
      seq: message.eventSeq ?? 0,
      time: message.finishTime ?? message.time ?? 0,
      tool: message.tool ?? "",
      input: message.input ?? {},
      ...(message.metadata ? { metadata: message.metadata } : {}),
      changedFiles: message.changedFiles,
      ...(message.undone ? { undone: true } : {}),
    });
  }
  return { calls, ...(lastUserSeq !== undefined ? { lastUserSeq } : {}) };
}

/** Server history plus the live window: the live copy of a call wins (it
 *  knows about rewinds and arrives first). */
export function mergeLiveCalls(server: readonly EditCall[], live: readonly EditCall[]): EditCall[] {
  const byId = new Map(server.map((call) => [call.callId, call]));
  for (const call of live) byId.set(call.callId, call);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}
