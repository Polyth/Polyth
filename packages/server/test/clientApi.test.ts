import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  APP_ACCESS_PROFILES,
  APP_APPROVAL_GRANT,
  CLI_ACCESS_PROFILES,
  CLI_TOKEN_GRANTABLE,
  normalizeAppTokenGrants,
  normalizeCliTokenGrants,
  normalizeSessionPerson,
  type AuthPrincipal,
  type AuthResolution,
  type SessionEvent,
  type SessionService,
} from "@polyth/contracts";
import { clientEventFromSessionEvent, pendingRequestsFromEvents } from "@polyth/contracts/client-api";
import { createHttpHandler } from "../src/http.ts";
import type { HttpAuth } from "../src/httpCore.ts";
import { CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";
import { createSessionEventWaiters } from "../src/sessionEventWaiters.ts";
import { testTenancy } from "./support/spaces.ts";

const ANON: AuthResolution = { principal: { kind: "anonymous" }, authenticated: false };
const CONTROL = [...CLI_ACCESS_PROFILES.control];
const APPROVE = [...APP_ACCESS_PROFILES.approve];

interface Call { name: string; args: unknown[] }

const event = (seq: number, type: string, data: Record<string, unknown>): SessionEvent => ({
  id: `e${seq}`, sessionId: "s-a", seq, time: 1000 + seq, type, data: data as never, v: 1,
});

/** A real tenancy boundary and HTTP gateway, with a recording session service. */
async function harness(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-client-api-"));
  const calls: Call[] = [];
  const events: SessionEvent[] = [];
  const pending = { permissions: 0, questions: 0 };
  const record = (name: string, result: unknown = undefined) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return result;
  };
  let projectId = "";
  const projection = (id: string) => ({
    id, projectId, title: "Chat", status: "idle", createdAt: 1, updatedAt: 2, attention: { ...pending, unread: 0 },
  });
  const sessions = {
    list: async () => [],
    sync: async () => [],
    snapshot: async (id: string) => projection(id),
    summaries: async (input: unknown) => {
      calls.push({ name: "summaries", args: [input] });
      return { sessions: [projection("s-a")], next: { updatedAt: 2, id: "s-a" }, complete: false, revision: 1 };
    },
    create: async (input: { id?: string }) => {
      calls.push({ name: "create", args: [input] });
      const id = input.id ?? "s-new";
      tenancy.sessionOwners.own(id, tenancy.defaultContext.spaceId);
      return { id };
    },
    send: record("send", { turnId: "t1" }),
    abort: record("abort"),
    replyPermission: record("replyPermission"),
    replyQuestion: record("replyQuestion"),
    replayPage: async (_id: string, afterSeq: number) => {
      const newer = events.filter((row) => row.seq > afterSeq);
      return { events: newer, cursor: newer.at(-1)?.seq ?? afterSeq, highWater: events.at(-1)?.seq ?? 0, complete: true };
    },
  } as unknown as SessionService;
  const tenancy = await testTenancy({ sessions: () => sessions });
  projectId = (await tenancy.services(tenancy.defaultContext).projects.add(dir, "Project")).id;
  tenancy.sessionOwners.own("s-a", tenancy.defaultContext.spaceId);
  const foreign = tenancy.addSpace("Other");
  tenancy.sessionOwners.own("s-foreign", foreign.spaceId);
  const userId = tenancy.defaultContext.userId;

  const tokens = new Map<string, AuthPrincipal>();
  const audits: Array<[string, string]> = [];
  const token = (name: string, grants: readonly string[], over: Partial<Extract<AuthPrincipal, { kind: "access-token" }>> = {}): string => {
    tokens.set(name, {
      kind: "access-token", tokenId: `tok-${name}`, tokenKind: "app", grants: Object.freeze([...grants]), appName: "Bot",
      spaceId: tenancy.defaultContext.spaceId, userId, ...over,
    } as AuthPrincipal);
    return name;
  };
  const uiPrincipal = { kind: "ui-session", sessionId: "ui", rememberedDeviceId: "ui", userId } as AuthPrincipal;
  const resolve = (req: { headers: Record<string, unknown> }): AuthResolution => {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (bearer) {
      const principal = tokens.get(bearer);
      return principal ? { principal, authenticated: true } : ANON;
    }
    return req.headers.cookie === "ui=1" ? { principal: uiPrincipal, authenticated: true } : ANON;
  };
  const auth: HttpAuth = {
    resolve: (req) => resolve(req as never),
    gate: (req) => (resolve(req as never).authenticated ? null : { status: 401, body: { error: "unauthorized", message: "authentication required" } }),
    auditToken: (_principal, action, resource) => { audits.push([action, resource]); },
  };
  const waiters = createSessionEventWaiters();
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
    auth,
    eventWaiters: waiters,
  });
  const server = createServer((req, res) => {
    void handler(req, res, { kind: "public-http", listenerId: "public", loopback: true, secure: false } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    waiters.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(tenancy.dataDir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, options: { token?: string; cookie?: string; body?: unknown } = {}) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolveCall, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = httpRequest({
        host: "127.0.0.1", port, path, method,
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
          resolveCall({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });

  /** Open a live stream; frames arrive in `frames`, `closed` settles at the end. */
  const openStream = (name: string, sessionId: string, lastEventId?: string) =>
    new Promise<{ res: IncomingMessage; frames: string[]; closed: Promise<void>; next(match: string): Promise<void>; destroy(): void }>((resolveOpen, reject) => {
      const req = httpRequest({
        host: "127.0.0.1", port, path: `/api/v1/sessions/${sessionId}/events`,
        headers: { authorization: `Bearer ${name}`, accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
      }, (res) => {
        const frames: string[] = [];
        let buffer = "";
        const listeners = new Set<() => void>();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf("\n\n");
          while (end !== -1) {
            frames.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
          for (const listener of [...listeners]) listener();
        });
        const closed = new Promise<void>((resolveClosed) => { res.on("close", () => resolveClosed()); });
        resolveOpen({
          res, frames, closed,
          next: (match) => new Promise<void>((resolveNext, rejectNext) => {
            const timer = setTimeout(() => { listeners.delete(check); rejectNext(new Error(`no frame with ${match}: ${frames.join(" | ")}`)); }, 3000);
            const check = (): void => {
              if (!frames.some((frame) => frame.includes(match))) return;
              clearTimeout(timer);
              listeners.delete(check);
              resolveNext();
            };
            listeners.add(check);
            check();
          }),
          destroy: () => req.destroy(),
        });
      });
      req.on("error", reject);
      req.end();
    });

  return { tenancy, calls, events, pending, tokens, audits, token, call, openStream, waiters, foreign, projectId };
}

test("the Client API speaks only bearer tokens, and an app's token only the Client API", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);

  assert.equal((await h.call("GET", "/api/v1/me")).status, 401);
  // A browser session has no way in, so a foreign page has no cookie to ride.
  assert.equal((await h.call("GET", "/api/v1/me", { cookie: "ui=1" })).status, 403);

  const me = await h.call("GET", "/api/v1/me", { token: app });
  assert.equal(me.status, 200);
  assert.equal(me.body.app, "Bot");
  assert.equal(me.body.spaceId, h.tenancy.defaultContext.spaceId);

  // No UI route, not even one its grants would cover in a CLI token's hands.
  assert.equal((await h.call("GET", "/api/sessions/summaries", { token: app })).status, 403);
  assert.equal((await h.call("POST", "/api/sessions/s-a/message", { token: app, body: { text: "x" } })).status, 403);
  assert.equal((await h.call("GET", "/", { token: app })).status, 403);
  assert.equal(h.calls.some((row) => row.name === "send"), false);

  // Unrouted paths stay denied.
  assert.equal((await h.call("GET", "/api/v1/settings", { token: app })).status, 403);
});

test("a command-line token may use the Client API with its own grants", async (t) => {
  const h = await harness(t);
  const cli = h.token("cli", CLI_ACCESS_PROFILES.read, { tokenKind: "device", appName: undefined } as never);
  assert.equal((await h.call("GET", "/api/v1/sessions/s-a", { token: cli })).status, 200);
  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/messages", { token: cli, body: { text: "x" } })).status, 403);
});

test("a read token cannot act, and every route enforces its own grant", async (t) => {
  const h = await harness(t);
  const read = h.token("read", CLI_ACCESS_PROFILES.read);
  assert.equal((await h.call("GET", "/api/v1/sessions", { token: read })).status, 200);
  for (const [method, path] of [
    ["POST", "/api/v1/sessions"],
    ["POST", "/api/v1/sessions/s-a/messages"],
    ["POST", "/api/v1/sessions/s-a/abort"],
    ["POST", "/api/v1/sessions/s-a/permissions/r1/approve"],
    ["POST", "/api/v1/sessions/s-a/permissions/r1/reject"],
    ["POST", "/api/v1/sessions/s-a/questions/q1/answer"],
    ["POST", "/api/v1/sessions/s-a/questions/q1/reject"],
  ] as const) {
    assert.equal((await h.call(method, path, { token: read, body: {} })).status, 403, path);
  }
  assert.deepEqual(h.calls.filter((row) => row.name !== "summaries"), []);
});

test("approving needs the owner-given grant; rejecting and answering do not", async (t) => {
  const h = await harness(t);
  const control = h.token("control", CONTROL);
  const approve = h.token("approve", APPROVE);

  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/permissions/r1/approve", { token: control, body: {} })).status, 403);
  assert.deepEqual(h.audits, []);
  assert.equal(h.calls.some((row) => row.name === "replyPermission"), false);

  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/permissions/r1/reject", { token: control, body: {} })).status, 200);
  assert.deepEqual(h.calls.at(-1)!.args.slice(1), ["r1", "reject", undefined]);

  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/questions/q1/answer", { token: control, body: { answers: { a: "yes" } } })).status, 200);
  assert.deepEqual(h.calls.at(-1)!.args.slice(1), ["q1", { a: "yes" }]);
  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/questions/q1/answer", { token: control, body: { answers: ["no"] } })).status, 400);
  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/questions/q1/reject", { token: control, body: {} })).status, 200);
  assert.deepEqual(h.calls.at(-1)!.args.slice(1), ["q1", { __reject: true }]);

  // Approval is always "once", whatever the body asks for, and it is audited.
  const approved = await h.call("POST", "/api/v1/sessions/s-a/permissions/r2/approve", { token: approve, body: { reply: "always", scope: "project" } });
  assert.equal(approved.status, 200);
  assert.deepEqual(h.calls.at(-1)!.args.slice(1), ["r2", "once", undefined]);
  assert.deepEqual(h.audits, [["app.permission-approved", "s-a/r2"]]);

  // The UI's "always allow" and delegation stay out of an app's reach.
  assert.equal((await h.call("POST", "/api/sessions/s-a/permission/r3", { token: approve, body: { reply: "always" } })).status, 403);
  assert.equal((await h.call("POST", "/api/sessions/s-a/permission/r3/delegate", { token: approve, body: {} })).status, 403);
});

test("command-line tokens still can never hold the approval grant", () => {
  assert.throws(() => normalizeCliTokenGrants([APP_APPROVAL_GRANT]), /not grantable/);
  assert.equal(CLI_TOKEN_GRANTABLE.includes(APP_APPROVAL_GRANT), false);
  assert.deepEqual(normalizeAppTokenGrants([APP_APPROVAL_GRANT]), [APP_APPROVAL_GRANT]);
  // An app is not a route around the human-only list.
  for (const refused of ["device.full-access", "secure-safe.secrets.read", "server.shutdown", "terminal.open", "files.write"]) {
    assert.throws(() => normalizeAppTokenGrants([refused]), /capability|not grantable/, refused);
  }
});

test("a known-valid session of another Space answers exactly like a missing one", async (t) => {
  const h = await harness(t);
  const app = h.token("app", APPROVE);
  for (const [method, path, body] of [
    ["GET", "/api/v1/sessions/s-foreign", undefined],
    ["GET", "/api/v1/sessions/s-foreign/requests", undefined],
    ["POST", "/api/v1/sessions/s-foreign/messages", { text: "x" }],
    ["POST", "/api/v1/sessions/s-foreign/abort", {}],
    ["POST", "/api/v1/sessions/s-foreign/permissions/r1/approve", {}],
    ["POST", "/api/v1/sessions/s-foreign/questions/q1/answer", { answers: {} }],
  ] as const) {
    const foreign = await h.call(method, path, { token: app, ...(body ? { body } : {}) });
    const missing = await h.call(method, path.replace("s-foreign", "s-missing"), { token: app, ...(body ? { body } : {}) });
    assert.equal(foreign.status, 404, path);
    assert.equal(missing.status, 404, path);
    assert.equal(foreign.body.message, missing.body.message, path);
  }
  assert.equal(h.calls.some((row) => row.name === "send" || row.name === "replyPermission" || row.name === "replyQuestion" || row.name === "abort"), false);
  assert.deepEqual(h.audits, []);

  const stream = await h.call("GET", "/api/v1/sessions/s-foreign/events", { token: app });
  assert.equal(stream.status, 404);
});

test("a send reads only the published fields and stamps the app from the token", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  const result = await h.call("POST", "/api/v1/sessions/s-a/messages", {
    token: app,
    body: {
      text: "hello",
      delivery: "queue",
      model: { providerId: "x", modelId: "y" },
      clientOperationId: "11111111-1111-4111-8111-111111111111",
      // Nothing below may survive the facade.
      hiddenUserMessage: true,
      command: { id: "compact" },
      memory: { project: false },
      dismissPending: true,
      agentProfileId: "root",
      harness: { mode: "pinned", harnessId: "claude" },
      author: { userId: "someone-else", via: "judge" },
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { turnId: "t1", queued: false });
  const send = h.calls.find((row) => row.name === "send")!;
  assert.equal(send.args[0], "s-a");
  const input = send.args[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["clientOperationId", "delivery", "model", "text"]);
  assert.deepEqual(input.model, { providerID: "x", modelID: "y" });
  // Folded with the account, as for the UI: another account cannot alias it.
  assert.notEqual(input.clientOperationId, "11111111-1111-4111-8111-111111111111");
  const author = (send.args[2] as { author: Record<string, unknown> }).author;
  assert.equal(author.userId, h.tenancy.defaultContext.userId);
  assert.equal(author.via, "app");
  assert.equal(author.viaName, "Bot");

  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/messages", { token: app, body: { text: "  " } })).status, 400);
  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/messages", { token: app, body: { text: "x", delivery: "now" } })).status, 400);
  assert.equal((await h.call("POST", "/api/v1/sessions/s-a/messages", { token: app, body: { text: "x", clientOperationId: "nope" } })).status, 400);
});

test("creating a chat takes no worktree, purpose or permission fields", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  const created = await h.call("POST", "/api/v1/sessions", {
    token: app,
    body: {
      projectId: h.projectId, title: " Hello ", harnessId: "claude", model: { providerId: "x", modelId: "y" },
      worktreePath: "/etc", purpose: "system", repositoryIds: ["r"], agent: "root", autoAccept: "all", id: "chosen",
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const input = h.calls.find((row) => row.name === "create")!.args[0] as Record<string, unknown>;
  assert.deepEqual(input, { projectId: h.projectId, harness: { mode: "pinned", harnessId: "claude" }, title: "Hello", model: { providerID: "x", modelID: "y" } });
  assert.equal(created.body.id, "s-new");
  assert.deepEqual(created.body.pending, { permissions: 0, questions: 0 });
  assert.equal((await h.call("POST", "/api/v1/sessions", { token: app, body: {} })).status, 400);
  assert.equal((await h.call("POST", "/api/v1/sessions", { token: app, body: { projectId: h.projectId, title: "x".repeat(121) } })).status, 400);
  assert.equal((await h.call("POST", "/api/v1/sessions", { token: app, body: { projectId: h.projectId, model: "gpt" } })).status, 400);
});

test("sessions list pages with an opaque cursor and maps only published fields", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  const page = await h.call("GET", `/api/v1/sessions?limit=500&projectId=${h.projectId}`, { token: app });
  assert.equal(page.status, 200);
  assert.equal(page.body.nextCursor, "2:s-a");
  assert.deepEqual((page.body.sessions as unknown[])[0], {
    id: "s-a", projectId: h.projectId, title: "Chat", status: "idle", createdAt: 1, updatedAt: 2, pending: { permissions: 0, questions: 0 },
  });
  const query = h.calls.find((row) => row.name === "summaries")!.args[0] as Record<string, unknown>;
  assert.equal(query.limit, 200);
  const next = await h.call("GET", "/api/v1/sessions?cursor=2:s-a", { token: app });
  assert.equal(next.status, 200);
  assert.deepEqual((h.calls.at(-1)!.args[0] as { cursor: unknown }).cursor, { updatedAt: 2, id: "s-a" });
  assert.equal((await h.call("GET", "/api/v1/sessions?cursor=bad", { token: app })).status, 400);
  assert.equal((await h.call("GET", "/api/v1/sessions?limit=0", { token: app })).status, 400);
});

test("pending requests come from history only when the projection says so", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  h.events.push(event(1, "permission/requested", { requestId: "r1", permission: "bash", patterns: ["rm -rf"], tool: "Bash", metadata: { secret: "x" } }));
  assert.deepEqual((await h.call("GET", "/api/v1/sessions/s-a/requests", { token: app })).body, { requests: [] });
  h.pending.permissions = 1;
  h.pending.questions = 1;
  h.events.push(event(2, "question/asked", { requestId: "q1", questions: [{ title: "Which?" }] }));
  h.events.push(event(3, "permission/requested", { requestId: "r2", permission: "edit", patterns: [] }));
  h.events.push(event(4, "permission/resolved", { requestId: "r2", reply: "once" }));
  const { body } = await h.call("GET", "/api/v1/sessions/s-a/requests", { token: app });
  assert.deepEqual(body.requests, [
    { kind: "permission", requestId: "r1", permission: "bash", patterns: ["rm -rf"], tool: "Bash" },
    { kind: "question", requestId: "q1", questions: [{ title: "Which?" }] },
  ]);
});

test("the event mapping is an allowlist: private history never leaves", () => {
  const map = (type: string, data: Record<string, unknown>) => clientEventFromSessionEvent(event(1, type, data));
  assert.equal(map("user/message", { text: "x", hiddenUserMessage: true }), null);
  assert.equal(map("user/message", { text: "x", hidden: true }), null);
  for (const type of ["secret/requested", "context/memory-prepared", "context/memory-delivery", "assistant/reasoning-chunk", "some/future-event", "runtime/receipt"]) {
    assert.equal(map(type, { requestId: "r", text: "private" }), null, type);
  }
  const user = map("user/message", {
    text: "visible", recoveryContext: "private", memory: { secret: 1 }, workspace: { root: "/x" },
    author: { userId: "u", name: "Ann", via: "app", viaName: "Bot" },
  });
  assert.deepEqual(user, { seq: 1, time: 1001, type: "message.user", text: "visible", author: { name: "Ann", app: "Bot" } });
  assert.deepEqual(map("tool/call", { callId: "c", tool: "bash", input: { command: "ls" }, partId: "private" }), { seq: 1, time: 1001, type: "tool.called", callId: "c", tool: "bash", input: { command: "ls" } });
  assert.deepEqual(map("assistant/chunk", { partId: "p", text: "he" }), { seq: 1, time: 1001, type: "message.delta", partId: "p", text: "he" });
  assert.deepEqual(map("assistant/message", { partId: "p", text: "hello", reasoning: "private", cost: 3 }), { seq: 1, time: 1001, type: "message.assistant", partId: "p", text: "hello" });
  assert.deepEqual(map("permission/requested", { requestId: "r", permission: "bash", patterns: ["ls", 1], metadata: { env: "x" }, preview: {} }), { seq: 1, time: 1001, type: "permission.requested", requestId: "r", permission: "bash", patterns: ["ls"] });
  assert.deepEqual(map("turn/stopped", { reason: "error", error: { message: "boom", stack: "private" } }), { seq: 1, time: 1001, type: "turn.finished", reason: "error", error: "boom" });
  assert.deepEqual(map("turn/stopped", { reason: "error", error: "Connection error." }), { seq: 1, time: 1001, type: "turn.finished", reason: "error", error: "Connection error." });
  assert.deepEqual(map("turn/stopped", { turnId: "t" }), { seq: 1, time: 1001, type: "turn.finished", reason: "completed" });
  assert.deepEqual(pendingRequestsFromEvents([event(1, "secret/requested", { requestId: "s" })]), []);
});

test("an app's name reaches the record bounded, and only as an app", () => {
  assert.deepEqual(normalizeSessionPerson({ userId: "u", via: "app", viaName: `  ${"n".repeat(200)} ` }), { userId: "u", via: "app", viaName: "n".repeat(120) });
  assert.deepEqual(normalizeSessionPerson({ userId: "u", via: "judge", viaName: "Bot" }), { userId: "u", via: "judge" });
  assert.deepEqual(normalizeSessionPerson({ userId: "u", viaName: "Bot" }), { userId: "u" });
});

test("events page and long-poll hide private events but advance past them", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  h.events.push(event(1, "user/message", { text: "hi" }));
  h.events.push(event(2, "context/memory-delivery", { status: "private" }));
  const page = await h.call("GET", "/api/v1/sessions/s-a/events", { token: app });
  assert.deepEqual(page.body, {
    events: [{ seq: 1, time: 1001, type: "message.user", text: "hi" }],
    cursor: 2,
    complete: true,
  });
  const started = Date.now();
  const held = h.call("GET", "/api/v1/sessions/s-a/events?afterSeq=2&waitMs=5000", { token: app });
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.events.push(event(3, "turn/started", { turnId: "t" }));
  h.waiters.event("s-a");
  const woke = await held;
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(woke.body.events, [{ seq: 3, time: 1003, type: "turn.started", turnId: "t" }]);
  assert.equal((await h.call("GET", "/api/v1/sessions/s-a/events?afterSeq=-1", { token: app })).status, 400);
  assert.equal((await h.call("GET", "/api/v1/sessions/s-a/events?waitMs=-1", { token: app })).status, 400);
});

test("the live stream replays, follows, resumes from Last-Event-ID, and hides private events", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  h.events.push(event(1, "user/message", { text: "first" }));
  h.events.push(event(2, "context/memory-delivery", { status: "private" }));
  const stream = await h.openStream(app, "s-a");
  assert.equal(stream.res.statusCode, 200);
  assert.match(String(stream.res.headers["content-type"]), /^text\/event-stream/);
  await stream.next('"first"');
  h.events.push(event(3, "assistant/chunk", { partId: "p", text: "second" }));
  h.waiters.event("s-a");
  await stream.next('"second"');
  assert.ok(stream.frames.includes(`id: 3\ndata: ${JSON.stringify({ seq: 3, time: 1003, type: "message.delta", partId: "p", text: "second" })}`));
  assert.equal(stream.frames.some((frame) => frame.includes("private")), false);
  stream.destroy();
  await stream.closed;

  const resumed = await h.openStream(app, "s-a", "2");
  await resumed.next('"second"');
  assert.equal(resumed.frames.some((frame) => frame.includes('"first"')), false);
  resumed.destroy();
  await resumed.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.waiters.size(), 0, "no waiter outlives its stream");
});

test("revoking a token closes its live stream, and shutdown ends every stream", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  const other = h.token("other", CONTROL);
  const revoked = await h.openStream(app, "s-a");
  const remaining = await h.openStream(other, "s-a");
  await revoked.next("retry:");
  await remaining.next("retry:");
  await new Promise((resolve) => setTimeout(resolve, 20));

  h.tokens.delete(app);
  h.events.push(event(1, "user/message", { text: "after revoke" }));
  h.waiters.event("s-a");
  await revoked.closed;
  assert.ok(revoked.frames.includes(`event: end\ndata: ${JSON.stringify({ reason: "unauthorized" })}`), revoked.frames.join(" | "));
  assert.equal(revoked.frames.some((frame) => frame.includes("after revoke")), false, "a revoked token reads nothing more");
  await remaining.next("after revoke");

  // A grant that is gone counts too, and an open read checks it on its next beat.
  h.waiters.close();
  await remaining.closed;
  assert.ok(remaining.frames.includes(`event: end\ndata: ${JSON.stringify({ reason: "shutdown" })}`), remaining.frames.join(" | "));
});

test("one token cannot pin an unbounded number of live streams", async (t) => {
  const h = await harness(t);
  const app = h.token("app", CONTROL);
  const open = await Promise.all(Array.from({ length: 16 }, () => h.openStream(app, "s-a")));
  await Promise.all(open.map((stream) => stream.next("retry:")));
  const refused = await h.openStream(app, "s-a");
  assert.equal(refused.res.statusCode, 429);
  const other = await h.openStream(h.token("other", CONTROL), "s-a");
  assert.equal(other.res.statusCode, 200);
  open[0]!.destroy();
  await open[0]!.closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await h.openStream(app, "s-a");
  assert.equal(again.res.statusCode, 200);
  for (const stream of [...open, refused, other, again]) stream.destroy();
});

test("the published API description matches the route table", () => {
  const spec = JSON.parse(readFileSync(new URL("../../../docs/api/client-v1.openapi.json", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const published = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!path.startsWith("/api/v1/")) continue;
    for (const method of Object.keys(item)) {
      if (method !== "parameters") published.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
    }
  }
  const routed = new Set<string>();
  for (const rule of CORE_REMOTE_ACCESS.http) {
    if (!rule.path.startsWith("/api/v1/")) continue;
    for (const method of rule.methods) routed.add(`${method} ${rule.path}`);
  }
  assert.deepEqual([...published].sort(), [...routed].sort());
});
