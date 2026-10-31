// People in a shared session. Two members of ONE Space use the same chat:
// every message records who wrote it, the session acts for the latest writer,
// and each person keeps their own draft, pin and unread count. Nothing on the
// boundary is stubbed: real store, real session service, real scoped facades.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  RuntimeEvent,
  SessionEvent,
  SessionPerson,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createProjectService } from "../src/projects.ts";
import { createSessionService } from "../src/sessions.ts";
import { createSpaceGateway, type SpaceGateway } from "../src/spaces.ts";
import { admittedAuthor, contextPerson, createSessionPeople } from "../src/sessionPeople.ts";
import { createWsGateway } from "../src/ws.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-session-people-"));

function fakeRuntime(): { rt: AgentRuntime; emit(sessionId: string, ev: RuntimeEvent): void } {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const emit = (sessionId: string, ev: RuntimeEvent) => { for (const listener of listeners) listener(sessionId, ev); };
  let turns = 0;
  const rt = {
    capabilities: async () => ({
      streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    resetSession: async () => "fresh",
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req: { sessionId: string }) => {
      turns += 1;
      emit(req.sessionId, { type: "turn/started", turnId: `t${turns}` });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb: (sessionId: string, ev: RuntimeEvent) => void) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  } as unknown as AgentRuntime;
  return { rt, emit };
}

const waitFor = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

interface Harness {
  gateway: SpaceGateway;
  store: ReturnType<typeof createStore>;
  emit(sessionId: string, ev: RuntimeEvent): void;
  ann: SpaceContext;
  bea: SpaceContext;
  annId: string;
  beaId: string;
  projectId: string;
  sessionId: string;
}

async function harness(): Promise<Harness> {
  const dataDir = tmp();
  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);
  const runtime = fakeRuntime();
  let sessions: ReturnType<typeof createSessionService>;
  const { gateway } = await createSpaceGateway({ dataDir, registry, store, sessions: () => sessions });
  sessions = createSessionService({
    store,
    projects: registry,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    runtimes: { forProject: async () => runtime.rt },
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    org: store,
  });
  const annId = gateway.store.users()[0]!.id;
  const beaId = gateway.store.createUser("Bea").id;
  const family = gateway.store.createSpace({ name: "Family", ownerId: annId });
  gateway.store.addMember(annId, family.id, beaId, "member");
  const ann = gateway.resolver.forUser(annId, family.id);
  const bea = gateway.resolver.forUser(beaId, family.id);
  const scoped = gateway.services(ann);
  const project = await scoped.projects.add(mkdtempSync(join(tmpdir(), "polyth-family-")), "family");
  const ref = await scoped.sessions.create({ projectId: project.id, title: "Shared chat" });
  return { gateway, store, emit: runtime.emit, ann, bea, annId, beaId, projectId: project.id, sessionId: ref.id };
}

const authors = (events: SessionEvent[], type = "user/message"): Array<SessionPerson | undefined> =>
  events.filter((event) => event.type === type)
    .map((event) => (event.data as { author?: SessionPerson }).author);

test("a message records the signed-in person, whatever the caller claims", async () => {
  const h = await harness();
  const bea = h.gateway.services(h.bea).sessions;
  // Both the input field and the admission are someone else's: both ignored.
  await bea.send(h.sessionId, {
    text: "from Bea",
    author: { userId: h.annId, name: "Ann" },
  }, { author: { userId: h.annId, name: "Ann" } });

  const events = await h.store.events(h.sessionId);
  assert.deepEqual(authors(events), [{ userId: h.beaId, name: "Bea" }]);
  // The session now acts for Bea: tools resolve accounts from this.
  assert.deepEqual((await h.store.projection(h.sessionId))?.actor, { userId: h.beaId, name: "Bea" });
});

test("the session acts for whoever wrote last, and queued messages keep their author", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  await ann.send(h.sessionId, { text: "Ann starts" });
  assert.equal((await h.store.projection(h.sessionId))?.actor?.userId, h.annId);

  // Ann's turn has not finished, so Bea's follow-up waits in the queue.
  const queued = await bea.send(h.sessionId, { text: "Bea follows", delivery: "queue" });
  assert.equal(queued.queued, true);
  const [item] = await h.store.queueList(h.sessionId);
  assert.equal(item?.author?.userId, h.beaId);
  assert.deepEqual(authors(await h.store.events(h.sessionId), "queue/enqueued").map((a) => a?.userId), [h.beaId]);
  // Queueing is not acting: the session still acts for Ann until Bea's turn runs.
  assert.equal((await h.store.projection(h.sessionId))?.actor?.userId, h.annId);

  // Ann's turn ends; dispatch admits Bea's message as Bea, not as whoever's
  // turn freed the queue.
  h.emit(h.sessionId, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () => authors(await h.store.events(h.sessionId)).length === 2, "the queued turn");
  assert.deepEqual(authors(await h.store.events(h.sessionId)).map((a) => a?.userId), [h.annId, h.beaId]);
  await waitFor(async () => (await h.store.projection(h.sessionId))?.actor?.userId === h.beaId, "Bea's actor");
});

test("system work writes no author, and may act for a member only while they belong", async () => {
  const h = await harness();
  const system = { ...h.ann, userId: "system:polyth-runtime", authority: { kind: "system", serviceId: "polyth-runtime" } } as SpaceContext;
  assert.equal(contextPerson(system), undefined);
  const directory = h.gateway.people!.directory!;
  // A schedule acting for Bea gets her current name and keeps its `via`.
  assert.deepEqual(admittedAuthor(system, { userId: h.beaId, via: "schedule" }, directory), {
    userId: h.beaId, name: "Bea", via: "schedule",
  });
  // Nobody asked for: nobody written.
  assert.equal(admittedAuthor(system, undefined, directory), undefined);
  // A person who left the Space cannot keep sending as themselves.
  h.gateway.store.removeMember(h.annId, h.ann.spaceId, h.beaId);
  assert.throws(() => admittedAuthor(system, { userId: h.beaId, via: "schedule" }, directory), { code: "forbidden" });
  // A person always speaks for themselves, never for the requested author.
  assert.deepEqual(admittedAuthor(h.ann, { userId: h.beaId }, directory)?.userId, h.annId);
  // A judge acting through its owner's own context says how, never changes who.
  assert.equal(admittedAuthor(h.ann, { userId: h.annId, via: "judge" }, directory)?.via, "judge");
  const other = admittedAuthor(h.ann, { userId: h.beaId, via: "judge" }, directory);
  assert.equal(other?.userId, h.annId); assert.equal(other?.via, undefined, "a `via` for someone else is dropped with them");
});

test("drafts are personal: neither person sees the other's", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  const annSaved = await ann.saveDraft!(h.sessionId, "Ann's half thought", null);
  assert.equal((await ann.snapshot(h.sessionId)).draft, "Ann's half thought");
  assert.equal((await bea.snapshot(h.sessionId)).draft, undefined);
  assert.equal((await bea.list(h.projectId))[0]?.draft, undefined);

  await bea.saveDraft!(h.sessionId, "Bea's idea", null);
  assert.equal((await bea.snapshot(h.sessionId)).draft, "Bea's idea");
  assert.equal((await ann.snapshot(h.sessionId)).draft, "Ann's half thought");
  // The shared projection itself never carries a personal draft.
  assert.equal((await h.store.projection(h.sessionId))?.draft, undefined);

  // Compare-and-set runs against the person's own stamp.
  await assert.rejects(() => ann.saveDraft!(h.sessionId, "stale", annSaved.draftUpdatedAt - 1), { code: "draft-conflict" });
  await ann.saveDraft!(h.sessionId, "", annSaved.draftUpdatedAt);
  assert.equal((await ann.snapshot(h.sessionId)).draft, undefined);
  assert.equal((await bea.snapshot(h.sessionId)).draft, "Bea's idea");
});

test("a navigator summary carries only the first line of the reader's own draft", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  await ann.saveDraft!(h.sessionId, "\n  Ann's parked idea  \nwith a second line", null);
  const row = async (sessions: typeof ann) =>
    (await sessions.summaries!({ projectId: h.projectId })).sessions.find((item) => item.id === h.sessionId);
  const annRow = await row(ann);
  assert.equal(annRow?.draftPreview, "Ann's parked idea");
  assert.equal(annRow?.draft, undefined, "a summary never carries the draft text itself");
  assert.equal(annRow?.draftUpdatedAt, undefined);
  assert.equal((await row(bea))?.draftPreview, undefined, "nobody sees another person's draft");

  await ann.saveDraft!(h.sessionId, "", (await ann.snapshot(h.sessionId)).draftUpdatedAt ?? null);
  assert.equal((await row(ann))?.draftPreview, undefined, "a cleared draft clears the mark");
});

test("pins and unread counts are each person's own", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  await ann.organize!(h.sessionId, { pinned: { position: 0 } });
  assert.deepEqual((await ann.snapshot(h.sessionId)).pinned, { position: 0 });
  assert.equal((await bea.snapshot(h.sessionId)).pinned, undefined);
  assert.equal((await h.store.projection(h.sessionId))?.pinned, undefined);

  const first = await h.store.append(h.sessionId, "assistant/message", { text: "one", partId: "p1" });
  await ann.markRead!(h.sessionId, first.seq);
  await bea.markRead!(h.sessionId, first.seq);
  await h.store.append(h.sessionId, "assistant/message", { text: "two", partId: "p2" });
  const latest = await h.store.append(h.sessionId, "assistant/message", { text: "three", partId: "p3" });
  await ann.markRead!(h.sessionId, latest.seq);
  const unread = async (sessions: typeof ann) =>
    (await sessions.list(h.projectId)).find((row) => row.id === h.sessionId)?.attention?.unread;
  assert.equal(await unread(ann), 0);
  assert.equal(await unread(bea), 2);
});

test("a fork belongs to whoever forked it, and delegated work acts for the parent's writer", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  await ann.send(h.sessionId, { text: "Ann asks" });
  await ann.organize!(h.sessionId, { pinned: { position: 1 } });

  const child = await h.gateway.services(h.ann).sessions.create({ projectId: h.projectId, parentId: h.sessionId });
  assert.deepEqual((await h.store.projection(child.id))?.actor, { userId: h.annId, name: (await h.store.projection(h.sessionId))?.actor?.name, via: "delegation" });

  // An idle chat with a pre-upgrade draft and pin, acting for Ann: none of
  // that is Bea's, so none of it travels into Bea's fork.
  const idle = await ann.create({ projectId: h.projectId, title: "Idle chat" });
  await h.store.patchProjection!(idle.id, (current) => ({
    ...current, draft: "legacy draft", draftUpdatedAt: 5, pinned: { position: 3 }, actor: { userId: h.annId },
  }));
  const fork = await bea.fork(idle.id);
  const forked = await h.store.projection(fork.id);
  assert.equal(forked?.draft, undefined);
  assert.equal(forked?.pinned, undefined);
  assert.equal(forked?.actor, undefined);
});

test("personalize hides a pre-upgrade draft from everyone but the session's owner", () => {
  const row: SessionProjection = {
    id: "s", projectId: "p", title: "t", status: "idle", createdAt: 1, updatedAt: 1,
    draft: "owner's old draft", draftUpdatedAt: 7, pinned: { position: 2 },
    attention: { questions: 0, permissions: 0, unread: 9 },
  };
  const people = createSessionPeople({
    personStates: (_ids, personId) => personId === "usr_bea" ? { s: { pinned: null } } : {},
    unreadFor: (_ids, personId) => ({ s: personId === "usr_bea" ? 1 : 0 }),
  }, undefined, (_sessionId, personId) => personId === "usr_ann");
  const [ann] = people.personalize([row], "usr_ann");
  const [bea] = people.personalize([row], "usr_bea");
  assert.equal(ann?.draft, "owner's old draft");
  assert.deepEqual(ann?.pinned, { position: 2 });
  assert.equal(ann?.attention?.unread, 0);
  assert.equal(bea?.draft, undefined);
  assert.equal(bea?.draftUpdatedAt, undefined);
  // An explicit unpin hides the shared pre-upgrade pin for that person only.
  assert.equal(bea?.pinned, undefined);
  assert.equal(bea?.attention?.unread, 1);
  // The input row is never mutated.
  assert.equal(row.draft, "owner's old draft");

  // The navigator summary of the same row: the preview follows the same rule.
  const summary: SessionProjection = { ...row, draft: undefined, draftUpdatedAt: undefined, summary: true, draftPreview: "owner's old draft" };
  assert.equal(people.personalize([summary], "usr_ann")[0]?.draftPreview, "owner's old draft");
  assert.equal(people.personalize([summary], "usr_bea")[0]?.draftPreview, undefined);
});

test("a live projection reaches each person's socket with their own draft and pin", async () => {
  const h = await harness();
  const ann = h.gateway.services(h.ann).sessions;
  const bea = h.gateway.services(h.bea).sessions;
  await ann.saveDraft!(h.sessionId, "Ann only", null);
  await bea.organize!(h.sessionId, { pinned: { position: 2 } });

  const ws = createWsGateway(ann, undefined, undefined, h.gateway);
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  // Each connection signs in as the person named by a test header.
  ws.attach(server, {
    identity: (req) => ({
      authenticated: true,
      principal: { kind: "local-user", trustedLoopback: true, userId: String(req.headers["x-test-user"]) } as never,
    }),
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const connect = async (userId: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { "x-test-user": userId, cookie: `${h.gateway.cookieName}=${h.ann.spaceId}` },
    });
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (raw) => { messages.push(JSON.parse(String(raw)) as Record<string, unknown>); });
    await once(socket, "open");
    return { socket, messages };
  };
  const annSocket = await connect(h.annId);
  const beaSocket = await connect(h.beaId);
  try {
    const live = (client: { messages: Record<string, unknown>[] }) =>
      client.messages.filter((m) => m.type === "projection").map((m) => m.session as SessionProjection);
    // The shared row carries neither person's draft or pin; fan-out adds each one's own.
    const shared = (await h.store.projection(h.sessionId))!;
    assert.equal(shared.draft, undefined);
    ws.projection(shared);
    await waitFor(async () => live(annSocket).length > 0 && live(beaSocket).length > 0, "both live projections");
    assert.equal(live(annSocket)[0]?.draft, "Ann only");
    assert.equal(live(annSocket)[0]?.pinned, undefined);
    assert.equal(live(beaSocket)[0]?.draft, undefined);
    assert.deepEqual(live(beaSocket)[0]?.pinned, { position: 2 });
  } finally {
    annSocket.socket.close();
    beaSocket.socket.close();
    ws.close();
    server.close();
  }
});
