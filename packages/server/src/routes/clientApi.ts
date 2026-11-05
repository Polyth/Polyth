// Client API v1 (`/api/v1`): the stable, bearer-only surface for third-party
// apps. This is a facade, not a second implementation: it validates a small
// allowlist of fields, calls the same Space-scoped session services as the UI
// routes, and publishes the mapped shapes from `@polyth/contracts/client-api`.
// A field the UI accepts (auto-accept, hidden prompts, commands, memory
// narrowing, worktree paths) cannot be sent through here because it is never
// read. Authorization already ran in httpCore's default-deny route table.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clientEventFromSessionEvent,
  pendingRequestsFromEvents,
  type ClientEvent,
  type ClientEventPage,
  type ClientSession,
  type ClientPendingRequest,
} from "@polyth/contracts/client-api";
import type {
  AuthPrincipal,
  HarnessSelection,
  JsonObject,
  ModelDescriptor,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createSessionOnce, sessionIdForCreateOperation } from "../sessionCreateIdempotency.ts";
import { clampWaitMs, type SessionEventWaiters } from "../sessionEventWaiters.ts";
import type { SpaceServices } from "../spaceScope.ts";

/** A live stream re-checks its token at least this often, and pings. */
const STREAM_HEARTBEAT_MS = 15_000;
/** One app cannot pin an unbounded number of server responses. */
const MAX_STREAMS_PER_TOKEN = 16;
const MAX_TITLE_CHARS = 120;
const MAX_LIST_LIMIT = 200;
const DELIVERIES = new Set(["normal", "queue", "steer", "interrupt"]);

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
const notFound = (): Error => Object.assign(new Error("not found"), { code: "not-found" });

/** Live stream count per token, for one HTTP handler. */
export interface ClientApiStreams {
  enter(tokenId: string): boolean;
  leave(tokenId: string): void;
}

export function createClientApiStreams(limit = MAX_STREAMS_PER_TOKEN): ClientApiStreams {
  const open = new Map<string, number>();
  return {
    enter(tokenId) {
      const count = open.get(tokenId) ?? 0;
      if (count >= limit) return false;
      open.set(tokenId, count + 1);
      return true;
    },
    leave(tokenId) {
      const count = (open.get(tokenId) ?? 1) - 1;
      if (count > 0) open.set(tokenId, count);
      else open.delete(tokenId);
    },
  };
}

export interface ClientApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  principal: AuthPrincipal;
  services(): SpaceServices;
  /** Services for this Space by the request's credential as it stands now;
   *  throws once the token is revoked, expired or lost the route's grant. */
  currentServices(spaceId: string): SpaceServices;
  body(): Promise<Record<string, unknown>>;
  json(code: number, body: unknown): void;
  models(): Promise<ModelDescriptor[]>;
  version: string;
  streams: ClientApiStreams;
  waiters?: SessionEventWaiters;
  audit?(action: string, resource: string): void;
  parseHarness(value: unknown): HarnessSelection | undefined;
  parseOperationId(value: unknown): string | undefined;
  /** Folds the account into a client's operation id, as the UI routes do. */
  scopeOperationId(operationId: string, userId: string): string;
  recordCreated(ref: { id: string }): Promise<void>;
  /** Tests shorten this; a stream re-checks its token on every beat. */
  heartbeatMs?: number;
}

const clientSession = (row: SessionProjection): ClientSession => ({
  id: row.id,
  projectId: row.projectId,
  ...(row.parentId ? { parentId: row.parentId } : {}),
  title: row.title,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  pending: { permissions: row.attention?.permissions ?? 0, questions: row.attention?.questions ?? 0 },
});

const modelInput = (value: unknown): { providerID: string; modelID: string } | undefined => {
  if (value === undefined) return undefined;
  const row = value as { providerId?: unknown; modelId?: unknown } | null;
  if (!row || typeof row !== "object" || typeof row.providerId !== "string" || typeof row.modelId !== "string" || !row.providerId || !row.modelId) {
    throw invalid("model must be { providerId, modelId }");
  }
  return { providerID: row.providerId, modelID: row.modelId };
};

const cursorInput = (raw: string | null): { updatedAt: number; id: string } | undefined => {
  if (raw === null) return undefined;
  const split = raw.indexOf(":");
  const updatedAt = Number(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (split <= 0 || !id || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw invalid("invalid cursor");
  return { updatedAt, id };
};

const seqInput = (raw: string | null | undefined): number => {
  const value = Number(raw ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw invalid("invalid event cursor");
  return value;
};

const eventsOf = (events: readonly SessionEvent[]): ClientEvent[] =>
  events.flatMap((event) => {
    const mapped = clientEventFromSessionEvent(event);
    return mapped ? [mapped] : [];
  });

/** Everything the session still waits on. Reads history only when the
 *  projection says something is open. */
async function pendingRequests(services: SpaceServices, sessionId: string): Promise<ClientPendingRequest[]> {
  const row = await services.sessions.snapshot(sessionId);
  if (!row.attention?.permissions && !row.attention?.questions) return [];
  const replay = services.sessions.replayPage;
  if (!replay) throw Object.assign(new Error("history unavailable"), { code: "unsupported" });
  const events: SessionEvent[] = [];
  let cursor = 0;
  let highWater: number | undefined;
  for (;;) {
    const page = await replay(sessionId, cursor, highWater);
    highWater ??= page.highWater;
    events.push(...page.events.filter((event) => event.type.startsWith("permission/") || event.type.startsWith("question/")));
    if (page.complete) break;
    if (page.cursor <= cursor) throw Object.assign(new Error("history cursor did not advance"), { code: "conflict" });
    cursor = page.cursor;
  }
  return pendingRequestsFromEvents(events);
}

/** `GET …/events` with `Accept: text/event-stream`. Every line it writes is
 *  re-read from persisted history, so a missed wake costs latency, never an
 *  event, and `Last-Event-ID` resumes exactly. */
async function streamEvents(ctx: ClientApiContext, sessionId: string, spaceId: string): Promise<void> {
  const { res, waiters, principal } = ctx;
  if (!waiters || !ctx.services().sessions.replayPage) {
    throw Object.assign(new Error("live events unavailable"), { code: "unsupported" });
  }
  const tokenId = principal.kind === "access-token" ? principal.tokenId : "";
  const lastEventId = ctx.req.headers["last-event-id"];
  const after = typeof lastEventId === "string" ? lastEventId : ctx.url.searchParams.get("afterSeq");
  let cursor = seqInput(after);
  // Fails with the ordinary 404/403 while no bytes have left yet.
  await ctx.services().sessions.snapshot(sessionId);
  if (!ctx.streams.enter(tokenId)) {
    ctx.json(429, { error: "rate-limited", message: "Too many live streams for this token" });
    return;
  }
  let wait: AbortController | null = null;
  let closed = false;
  const onClose = (): void => { closed = true; wait?.abort(); };
  res.once("close", onClose);
  const writeAll = async (text: string): Promise<void> => {
    if (res.write(text)) return;
    await new Promise<void>((resolve) => {
      const done = (): void => { res.off("drain", done); res.off("close", done); resolve(); };
      res.once("drain", done);
      res.once("close", done);
    });
  };
  const finish = (reason: string): void => {
    if (!res.writableEnded) res.end(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
  };
  try {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    await writeAll("retry: 3000\n\n");
    while (!closed) {
      if (waiters.isClosed()) return finish("shutdown");
      let services: SpaceServices;
      try {
        services = ctx.currentServices(spaceId);
      } catch {
        return finish("unauthorized");
      }
      // Register before the read, so an event appended in between still wakes.
      wait = new AbortController();
      const woke = waiters.waitForEvent(sessionId, ctx.heartbeatMs ?? STREAM_HEARTBEAT_MS, wait.signal);
      let page;
      try {
        page = await services.sessions.replayPage!(sessionId, cursor);
      } catch (error) {
        wait.abort();
        if ((error as { code?: string }).code === "not-found") return finish("not-found");
        throw error;
      }
      if (page.cursor < cursor) {
        wait.abort();
        throw Object.assign(new Error("history cursor moved back"), { code: "conflict" });
      }
      for (const event of eventsOf(page.events)) {
        await writeAll(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        if (closed) break;
      }
      const moved = page.cursor > cursor;
      cursor = page.cursor;
      if (!page.complete && moved) {
        wait.abort();
        continue;
      }
      if (!moved) {
        await woke;
        if (!closed && !waiters.isClosed()) await writeAll(": ping\n\n");
      } else {
        wait.abort();
      }
    }
  } catch {
    if (!res.writableEnded) finish("error");
  } finally {
    wait?.abort();
    res.off("close", onClose);
    ctx.streams.leave(tokenId);
  }
}

/** Serve one Client API request. Authorization has already passed. */
export async function handleClientApi(ctx: ClientApiContext): Promise<void> {
  const { path, method, url, principal } = ctx;
  const notRouted = (): void => { throw notFound(); };

  if (path === "/api/v1/me" && method === "GET") {
    const scope = ctx.services().ctx;
    return ctx.json(200, {
      userId: scope.userId,
      spaceId: scope.spaceId,
      ...(principal.kind === "access-token" && principal.appName ? { app: principal.appName } : {}),
      grants: principal.kind === "access-token" ? [...principal.grants] : [],
      version: ctx.version,
    });
  }
  if (path === "/api/v1/projects" && method === "GET") {
    const projects = await ctx.services().projects.list();
    return ctx.json(200, { projects: projects.map(({ id, name, path: folder }) => ({ id, name, path: folder })) });
  }
  if (path === "/api/v1/models" && method === "GET") {
    const models = await ctx.models();
    return ctx.json(200, {
      models: models.map((model) => ({
        providerId: model.providerID,
        modelId: model.modelID,
        name: model.name,
        ...(model.harnessId ? { harnessId: model.harnessId } : {}),
      })),
    });
  }
  if (path === "/api/v1/sessions" && method === "GET") {
    const summaries = ctx.services().sessions.summaries;
    if (!summaries) throw Object.assign(new Error("session list unavailable"), { code: "unsupported" });
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1) throw invalid("invalid limit");
    const cursor = cursorInput(url.searchParams.get("cursor"));
    const page = await summaries({
      projectId: url.searchParams.get("projectId") ?? undefined,
      limit: Math.min(limit, MAX_LIST_LIMIT),
      ...(cursor ? { cursor } : {}),
      ...(url.searchParams.has("archived") ? { archived: url.searchParams.get("archived") === "true" } : {}),
    });
    return ctx.json(200, {
      sessions: page.sessions.map(clientSession),
      ...(page.next ? { nextCursor: `${page.next.updatedAt}:${page.next.id}` } : {}),
    });
  }
  if (path === "/api/v1/sessions" && method === "POST") {
    const body = await ctx.body();
    if (typeof body.projectId !== "string" || !body.projectId) throw invalid("projectId is required");
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > MAX_TITLE_CHARS)) {
      throw invalid(`title must be text of at most ${MAX_TITLE_CHARS} characters`);
    }
    if (body.harnessId !== undefined && typeof body.harnessId !== "string") throw invalid("harnessId must be text");
    const harness = body.harnessId === undefined ? undefined : ctx.parseHarness({ mode: "pinned", harnessId: body.harnessId });
    const model = modelInput(body.model);
    const operationId = ctx.parseOperationId(body.clientOperationId);
    const projectId = body.projectId;
    const services = ctx.services();
    const create = async (id?: string) => {
      const ref = await services.sessions.create({
        projectId,
        ...(harness ? { harness } : {}),
        ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
        ...(model ? { model } : {}),
        ...(id ? { id } : {}),
      });
      await ctx.recordCreated(ref);
      return ref;
    };
    const ref = operationId
      ? (await createSessionOnce(services.sessions, sessionIdForCreateOperation(operationId, services.ctx), projectId, create)).ref
      : await create();
    return ctx.json(200, clientSession(await services.sessions.snapshot(ref.id)));
  }

  const session = path.match(/^\/api\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (!session) return notRouted();
  const sessionId = session[1]!;
  const rest = session[2];

  if (rest === undefined && method === "GET") {
    return ctx.json(200, clientSession(await ctx.services().sessions.snapshot(sessionId)));
  }
  if (rest === "events" && method === "GET") {
    const accept = ctx.req.headers.accept;
    if (typeof accept === "string" && accept.includes("text/event-stream")) {
      return streamEvents(ctx, sessionId, ctx.services().ctx.spaceId);
    }
    const replay = ctx.services().sessions.replayPage;
    if (!replay) throw Object.assign(new Error("history unavailable"), { code: "unsupported" });
    const afterSeq = seqInput(url.searchParams.get("afterSeq"));
    const page = async (): Promise<ClientEventPage> => {
      const read = await replay(sessionId, afterSeq);
      return { events: eventsOf(read.events), cursor: read.cursor, complete: read.complete };
    };
    const waitMs = ctx.waiters ? clampWaitMs(url.searchParams.get("waitMs")) : 0;
    if (waitMs === 0) return ctx.json(200, await page());
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    ctx.res.once("close", onClose);
    try {
      // Register before the read, so an event appended in between still wakes.
      const woke = ctx.waiters!.waitForEvent(sessionId, waitMs, abort.signal);
      let result = await page();
      if (result.cursor === afterSeq) {
        await woke;
        if (!abort.signal.aborted) result = await page();
      }
      return ctx.json(200, result);
    } finally {
      abort.abort();
      ctx.res.off("close", onClose);
    }
  }
  if (rest === "messages" && method === "POST") {
    const body = await ctx.body();
    if (typeof body.text !== "string" || !body.text.trim()) throw invalid("text is required");
    if (body.delivery !== undefined && !DELIVERIES.has(String(body.delivery))) throw invalid("invalid delivery");
    const model = modelInput(body.model);
    const services = ctx.services();
    const operationId = ctx.parseOperationId(body.clientOperationId);
    const result = await services.sessions.send(sessionId, {
      text: body.text,
      ...(operationId ? { clientOperationId: ctx.scopeOperationId(operationId, services.ctx.userId) } : {}),
      ...(model ? { model } : {}),
      ...(body.delivery ? { delivery: body.delivery as "normal" | "queue" | "steer" | "interrupt" } : {}),
    }, principal.kind === "access-token" && principal.appName
      ? { author: { userId: services.ctx.userId, via: "app", viaName: principal.appName } }
      : undefined);
    return ctx.json(200, {
      ...(result.turnId ? { turnId: result.turnId } : {}),
      ...(result.queueId ? { queueId: result.queueId } : {}),
      queued: result.queued === true,
    });
  }
  if (rest === "abort" && method === "POST") {
    await ctx.services().sessions.abort(sessionId, { source: "client-api" });
    return ctx.json(200, { ok: true });
  }
  if (rest === "requests" && method === "GET") {
    return ctx.json(200, { requests: await pendingRequests(ctx.services(), sessionId) });
  }
  const answer = rest?.match(/^(permissions|questions)\/([^/]+)\/(approve|reject|answer)$/);
  if (answer && method === "POST") {
    const [, kind, requestId, action] = answer as unknown as [string, string, string, string];
    const services = ctx.services();
    if (kind === "permissions" && action === "approve") {
      // Only once: a standing rule is a policy change, which stays in the UI.
      await services.sessions.replyPermission(sessionId, requestId, "once");
      // The approval has happened: a failed record must not read as a refusal.
      try {
        ctx.audit?.("app.permission-approved", `${sessionId}/${requestId}`);
      } catch (error) {
        console.error("[polyth] could not audit an app's approval", error);
      }
      return ctx.json(200, { ok: true });
    }
    if (kind === "permissions" && action === "reject") {
      await services.sessions.replyPermission(sessionId, requestId, "reject");
      return ctx.json(200, { ok: true });
    }
    if (kind === "questions" && action === "answer") {
      const body = await ctx.body();
      const answers = body.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw invalid("answers must be an object");
      await services.sessions.replyQuestion(sessionId, requestId, answers as JsonObject);
      return ctx.json(200, { ok: true });
    }
    if (kind === "questions" && action === "reject") {
      await services.sessions.replyQuestion(sessionId, requestId, { __reject: true });
      return ctx.json(200, { ok: true });
    }
  }
  return notRouted();
}
