// Which files the chats sharing one checkout edited, read from the canonical
// event log. Feeds the Files change highlighting (a colour per chat) and IDE
// mode's "a chat's edited files stay open". Space-scoped, bounded and
// incremental: the client passes a cursor per chat and gets only newer edits.
import path from "node:path";
import type {
  JsonObject,
  JsonValue,
  ProjectService,
  RouteRequest,
  SessionEvent,
  SessionPersistence,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { extractChangedFiles } from "@polyth/contracts/tool-edits";
import { resolveWorkspaceContext, workspaceExecutionPath, workspaceRepository } from "@polyth/contracts/workspace";

export const SESSION_EDITS_PATH = "/api/files/session-edits";
const TOOL_EVENT_TYPES = ["tool/call", "tool/started", "tool/result", "tool/error"] as const;

/** Other chats reported per request (the viewer is always included). */
const MAX_PEERS = 8;
/** Most recently updated chats considered as peers. */
const PEER_CANDIDATES = 24;
/** A chat idle longer than this is no longer a peer unless the client tracks it. */
const PEER_RECENCY_MS = 7 * 24 * 60 * 60_000;
const PEER_ROOT_TTL_MS = 30_000;
/** A first read never reaches further back than this many events. */
const COLD_WINDOW = 50_000;
/** Tool events folded per request across every chat; the rest waits (`more`). */
const ROW_BUDGET = 3_000;
const PAGE = 500;
const MAX_CALLS_PER_SOURCE = 400;
/** A started call newer than this holds the cursor so its result is read with its input. */
const OPEN_CALL_HOLD_MS = 15 * 60_000;
const MAX_STRING = 64 * 1024;
const MAX_CALL_BYTES = 256 * 1024;
const MAX_CURSORS = 16;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface SessionEditCall {
  callId: string;
  /** Sequence of the event that completed the call. */
  seq: number;
  time: number;
  tool: string;
  /** Bounded copy: strings over 64 KiB are dropped and `truncated` is set. */
  input: JsonObject;
  metadata?: JsonObject;
  /** Paths as the tool wrote them (canonical `extractChangedFiles`). */
  changedFiles: string[];
  truncated?: true;
}

export interface SessionEditSource {
  sessionId: string;
  title: string;
  createdAt: number;
  parentId?: string;
  /** The chat the request was made for. */
  viewer: boolean;
  /** Pass back as this chat's cursor; nothing at or below it is sent again. */
  cursor: number;
  /** More history waits beyond this request's budget. */
  more: boolean;
  calls: SessionEditCall[];
}

export interface SessionEditsResponse {
  sources: SessionEditSource[];
}

export interface SessionEditsDeps {
  forSpace(space: SpaceContext): { projects: ProjectService; sessions: SessionService };
  store: Pick<SessionPersistence, "latestSeq" | "events" | "eventsOfTypes">;
  now?: () => number;
}

type Project = NonNullable<Awaited<ReturnType<ProjectService["get"]>>>;

const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found", status: 404 });
const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input", status: 400 });

const objectOf = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const stringOf = (value: unknown): string => typeof value === "string" ? value : "";

/** The checkout a session (or the bare project) exposes for one repository. */
export function checkoutRoot(project: Project, session: SessionProjection | null, repositoryId: string | null): string {
  if (repositoryId) {
    const repository = workspaceRepository(resolveWorkspaceContext(project, session), repositoryId);
    if (repository.state === "missing") throw notFound("repository checkout is missing");
    return repository.path;
  }
  return session ? workspaceExecutionPath(project, session) : project.path;
}

const sameRoot = (left: string, right: string): boolean =>
  path.resolve(left) === path.resolve(right);

interface CopyBudget { left: number; truncated: boolean }

function boundedCopy(value: JsonValue, budget: CopyBudget, depth: number): JsonValue | undefined {
  if (typeof value === "string") {
    if (value.length > MAX_STRING || value.length > budget.left) {
      budget.truncated = true;
      return undefined;
    }
    budget.left -= value.length;
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) {
    budget.truncated = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) budget.truncated = true;
    const out: JsonValue[] = [];
    for (const item of value.slice(0, 256)) {
      const next = boundedCopy(item, budget, depth + 1);
      if (next !== undefined) out.push(next);
    }
    return out;
  }
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const next = boundedCopy(child, budget, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

interface OpenCall { tool: string; input: JsonObject; seq: number; time: number }

/** Parse `id:seq,id:seq` cursors; unknown shapes are ignored, never trusted. */
export function parseCursors(raw: string | null): Map<string, number> {
  const cursors = new Map<string, number>();
  for (const part of (raw ?? "").split(",").slice(0, MAX_CURSORS)) {
    const index = part.lastIndexOf(":");
    if (index <= 0) continue;
    const id = part.slice(0, index);
    const seq = Number(part.slice(index + 1));
    if (!SESSION_ID.test(id) || !Number.isSafeInteger(seq) || seq < 0) continue;
    cursors.set(id, seq);
  }
  return cursors;
}

async function toolEvents(
  store: SessionEditsDeps["store"],
  sessionId: string,
  after: number,
  through: number,
  limit: number,
): Promise<SessionEvent[]> {
  if (store.eventsOfTypes) return store.eventsOfTypes(sessionId, TOOL_EVENT_TYPES, after, through, limit);
  const page = await store.events(sessionId, after, { direction: "forward", throughSeq: through, limit });
  return page.filter((event) => (TOOL_EVENT_TYPES as readonly string[]).includes(event.type));
}

/**
 * Fold one chat's tool events after `since` into completed edit calls. The
 * returned cursor stays behind a recently started, unfinished call so its
 * result is read together with its input next time; the client deduplicates
 * calls by id.
 */
export async function scanSessionEdits(
  store: SessionEditsDeps["store"],
  sessionId: string,
  since: number,
  budget: { rows: number },
  now: number,
): Promise<Pick<SessionEditSource, "cursor" | "more" | "calls">> {
  const latest = await store.latestSeq(sessionId);
  // A cursor past the log (a replaced session) starts over.
  let scanned = since > 0 && since <= latest ? since : Math.max(0, latest - COLD_WINDOW);
  const open = new Map<string, OpenCall>();
  const calls: SessionEditCall[] = [];
  while (scanned < latest && budget.rows > 0) {
    const limit = Math.min(PAGE, budget.rows);
    const page = await toolEvents(store, sessionId, scanned, latest, limit);
    budget.rows -= Math.max(1, page.length);
    for (const event of page) {
      scanned = Math.max(scanned, event.seq);
      const data = objectOf(event.data) ?? {};
      const callId = stringOf(data.callId);
      if (!callId) continue;
      if (event.type === "tool/call" || event.type === "tool/started") {
        const input = objectOf(data.input);
        const existing = open.get(callId);
        if (existing) {
          if (input && Object.keys(input).length > 0) existing.input = input;
          if (!existing.tool) existing.tool = stringOf(data.tool);
        } else {
          open.set(callId, { tool: stringOf(data.tool), input: input ?? {}, seq: event.seq, time: event.time });
        }
        continue;
      }
      const started = open.get(callId);
      open.delete(callId);
      if (event.type !== "tool/result") continue;
      const tool = started?.tool || stringOf(data.tool);
      const late = objectOf(data.input);
      const input = late && Object.keys(late).length > 0 ? { ...(started?.input ?? {}), ...late } : started?.input ?? {};
      const metadata = objectOf(data.metadata);
      // Same rule as the web reducer, so every chat is read alike.
      const changedFiles = extractChangedFiles(tool, late ?? started?.input ?? {}, metadata);
      if (changedFiles.length === 0) continue;
      const copy: CopyBudget = { left: MAX_CALL_BYTES, truncated: false };
      const boundedInput = (boundedCopy(input, copy, 0) ?? {}) as JsonObject;
      const boundedMetadata = metadata ? boundedCopy(metadata, copy, 0) as JsonObject | undefined : undefined;
      calls.push({
        callId,
        seq: event.seq,
        time: event.time,
        tool,
        input: boundedInput,
        ...(boundedMetadata ? { metadata: boundedMetadata } : {}),
        changedFiles,
        ...(copy.truncated ? { truncated: true as const } : {}),
      });
    }
    if (page.length < limit) {
      scanned = latest;
      break;
    }
    if (scanned < latest && budget.rows > 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const held = [...open.values()].filter((call) => now - call.time < OPEN_CALL_HOLD_MS);
  const cursor = held.length > 0 ? Math.min(scanned, ...held.map((call) => call.seq - 1)) : scanned;
  return { cursor: Math.max(0, cursor), more: scanned < latest, calls: calls.slice(-MAX_CALLS_PER_SOURCE) };
}

export function sessionEditsRoute(deps: SessionEditsDeps): (request: RouteRequest) => Promise<boolean> {
  const now = deps.now ?? Date.now;
  const peerRoots = new Map<string, { at: number; root: string | null }>();

  const peerRoot = async (
    sessions: SessionService,
    project: Project,
    sessionId: string,
    repositoryId: string | null,
    spaceId: string,
  ): Promise<{ root: string | null; session?: SessionProjection }> => {
    const key = JSON.stringify([spaceId, project.id, sessionId, repositoryId]);
    const cached = peerRoots.get(key);
    if (cached && now() - cached.at < PEER_ROOT_TTL_MS && cached.root === null) return { root: null };
    let session: SessionProjection;
    try {
      session = await sessions.snapshot(sessionId);
    } catch {
      peerRoots.set(key, { at: now(), root: null });
      return { root: null };
    }
    let root: string | null = null;
    try {
      root = session.projectId === project.id ? checkoutRoot(project, session, repositoryId) : null;
    } catch {
      root = null;
    }
    peerRoots.set(key, { at: now(), root });
    if (peerRoots.size > 512) peerRoots.delete(peerRoots.keys().next().value!);
    return { root, session };
  };

  return async (request) => {
    if (request.path !== SESSION_EDITS_PATH || request.method !== "GET") return false;
    const query = (name: string) => request.url.searchParams.get(name);
    const projectId = query("projectId")?.trim() ?? "";
    if (!projectId) throw invalid("projectId required");
    const sessionId = query("sessionId")?.trim() || null;
    const repositoryId = query("repositoryId")?.trim() || null;
    if (sessionId && !SESSION_ID.test(sessionId)) throw invalid("invalid sessionId");
    const cursors = parseCursors(query("cursors"));
    const scoped = deps.forSpace(request.space);
    const project = await scoped.projects.get(projectId);
    if (!project) throw notFound("project not found");
    let viewer: SessionProjection | null = null;
    if (sessionId) {
      try {
        viewer = await scoped.sessions.snapshot(sessionId);
      } catch {
        throw notFound("session not found in project");
      }
      if (viewer.projectId !== projectId) throw notFound("session not found in project");
    }
    let root: string;
    try {
      root = checkoutRoot(project, viewer, repositoryId);
    } catch {
      throw notFound("repository not found in workspace");
    }

    // Peers: recently active chats of this project that write into the same checkout.
    const listed = scoped.sessions.summaries
      ? (await scoped.sessions.summaries({ projectId, limit: PEER_CANDIDATES })).sessions
      : (await scoped.sessions.list(projectId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, PEER_CANDIDATES);
    const peers: SessionProjection[] = [];
    for (const summary of listed) {
      if (peers.length >= MAX_PEERS) break;
      if (summary.id === viewer?.id || summary.projectId !== projectId || summary.status === "archived") continue;
      if (now() - summary.updatedAt > PEER_RECENCY_MS && !cursors.has(summary.id)) continue;
      const peer = await peerRoot(scoped.sessions, project, summary.id, repositoryId, request.space.spaceId);
      if (!peer.root || !sameRoot(peer.root, root)) continue;
      peers.push(peer.session ?? summary);
    }

    const budget = { rows: ROW_BUDGET };
    const sources: SessionEditSource[] = [];
    for (const [session, isViewer] of [
      ...(viewer ? [[viewer, true] as const] : []),
      ...peers.map((peer) => [peer, false] as const),
    ]) {
      const scan = await scanSessionEdits(deps.store, session.id, cursors.get(session.id) ?? 0, budget, now());
      sources.push({
        sessionId: session.id,
        title: session.title,
        createdAt: session.createdAt,
        ...(session.parentId ? { parentId: session.parentId } : {}),
        viewer: isViewer,
        ...scan,
      });
    }
    request.json(200, { sources } satisfies SessionEditsResponse);
    return true;
  };
}
