// People talking to people in a session: `person/message` appends a canonical
// event, never touches the runtime, mentions only people who can open the
// chat, is per-person idempotent, and drives mention/message notifications.
// Real canonical identity, real store, real session service.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  SessionEvent,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import { SESSION_PURPOSE_CONVERSATION } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { accessControlledSessionService } from "../src/sessionResourceAccess.ts";
import { createSessionService } from "../src/sessions.ts";
import { createSessionPeople } from "../src/sessionPeople.ts";
import { sessionAudience, sessionMentionCandidates } from "../src/sessionSharing.ts";

const SESSION_ID = "sess_team";

interface Harness {
  root: string;
  security: ReturnType<typeof createCanonicalSecurity>;
  store: ReturnType<typeof createStore>;
  sessions: ReturnType<typeof createSessionService>;
  project: Project;
  projects: ProjectService;
  startedTurns: number;
  people: ReturnType<typeof createSessionPeople>;
  ctx(userId: string, role: SpaceContext["role"], spaceId?: string): SpaceContext;
  notifications: Array<{
    sessionId: string;
    seq: number;
    author: { userId: string; name?: string };
    text: string;
    mentions: Array<{ userId: string; name?: string }>;
    audience: Array<{ userId: string; name?: string }>;
  }>;
  /** Projections the service published (what the WS fans out per reader). */
  projections: SessionProjection[];
  events(): Promise<SessionEvent[]>;
}

async function harness(t: test.TestContext): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "polyth-person-messages-"));
  const security = createCanonicalSecurity({
    dataDir: root,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    now: () => 1_000,
  });
  security.control.transaction(() => {
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_work"]) {
      security.control.run(
        "INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)",
        space, space, space,
      );
    }
    for (const [id, name, role, space] of [
      ["usr_ann", "Ann", "owner", "spc_home"],
      ["usr_bea", "Bea", "member", "spc_home"],
      ["usr_cara", "Cara", "member", "spc_home"],
      ["usr_outsider", "Outsider", "member", "spc_work"],
    ] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      security.control.run(
        "INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,?,1)",
        space, id, role,
      );
    }
  });
  const binding = bindCanonicalSecurity(security);
  const store = createStore(join(root, "sessions.db"));
  t.after(() => {
    void store.close();
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project: Project = {
    id: "prj_home", path: join(root, "project"), name: "Home", createdAt: 1, spaceId: "spc_home",
  };
  const projects: ProjectService = {
    async list() { return [project]; },
    async add() { return project; },
    async create() { return project; },
    async remove() {},
    async get(id) { return id === project.id ? project : undefined; },
  };
  let startedTurns = 0;
  const runtimes = {
    forProject: async () => ({
      startTurn: async () => { startedTurns += 1; },
    } as unknown as AgentRuntime),
  };
  const notifications: Harness["notifications"] = [];
  const projections: SessionProjection[] = [];
  const sessions = createSessionService({
    store,
    projects,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    runtimes,
    broadcast: { event: () => {}, projection: (projection) => { projections.push(projection); } },
    queue: store,
    org: store,
    notify: { personMessage: (input) => { notifications.push(input as Harness["notifications"][number]); } },
  });

  await store.upsertProjection({
    id: SESSION_ID,
    projectId: project.id,
    spaceId: "spc_home",
    title: "Team chat",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  const projectOperation = randomUUID();
  security.resources.begin({
    operationId: projectOperation,
    resourceId: project.id,
    kind: "project",
    orgId: "org_home",
    spaceId: "spc_home",
    ownerPrincipalId: "usr_ann",
    createdBy: "usr_ann",
    visibility: "space",
  });
  security.resources.recordDomainReady(projectOperation, JSON.stringify({ id: project.id }));
  const projectRow = security.resources.resource(project.id)!;
  security.resources.activate(projectOperation, projectRow.revision);

  const operationId = randomUUID();
  security.resources.begin({
    operationId,
    resourceId: SESSION_ID,
    kind: "session",
    orgId: "org_home",
    spaceId: "spc_home",
    parentId: project.id,
    ownerPrincipalId: "usr_ann",
    createdBy: "usr_ann",
    visibility: "restricted",
  });
  security.resources.recordDomainReady(operationId, JSON.stringify({ id: SESSION_ID }));
  const row = security.resources.resource(SESSION_ID)!;
  security.resources.activate(operationId, row.revision);
  security.sharing.share({
    resourceId: SESSION_ID,
    orgId: "org_home",
    spaceId: "spc_home",
    actor: "usr_ann",
    visibility: "restricted",
    grants: [
      { principalId: "usr_bea", access: "collaborate" },
      { principalId: "usr_cara", access: "view" },
    ],
  });

  const ctx = (userId: string, role: SpaceContext["role"], spaceId = "spc_home"): SpaceContext => ({
    spaceId, spaceSlug: spaceId, userId, role, deployment: "local-trusted", storageDir: join(root, spaceId),
  });
  const people = createSessionPeople(store);
  return {
    root, security, store, sessions, project, projects, startedTurns, people, ctx, notifications, projections,
    events: () => store.events(SESSION_ID),
  };
}

const author = (userId: string, name: string) => ({ userId, name });

test("posting appends a canonical event, never starts a turn, and ignores a caller-supplied author", async (t) => {
  const h = await harness(t);
  const result = await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "  hello team  ", author: { userId: "usr_bea" } } as never,
    { author: author("usr_ann", "Ann") },
  );
  const events = await h.events();
  const messages = events.filter((event) => event.type === "person/message");
  assert.equal(messages.length, 1);
  assert.equal(result.seq, messages[0]!.seq);
  assert.equal((messages[0]!.data as { text: string }).text, "hello team");
  assert.deepEqual((messages[0]!.data as { author: unknown }).author, author("usr_ann", "Ann"));
  // No turn, no runtime contact.
  assert.equal(h.startedTurns, 0);
  assert.equal(events.some((event) => event.type === "turn/started"), false);
  // Missing author is invalid input, and an empty message is refused.
  await assert.rejects(
    h.sessions.postPersonMessage!(SESSION_ID, { text: "x" } as never, {}),
    { code: "invalid-input" },
  );
  await assert.rejects(
    h.sessions.postPersonMessage!(SESSION_ID, { text: "   " } as never, { author: author("usr_ann", "Ann") }),
    { code: "invalid-input" },
  );
});

test("posting works while the session is working and while archived it is refused", async (t) => {
  const h = await harness(t);
  await h.store.patchProjection!(SESSION_ID, (current) => ({ ...current, status: "working" }));
  await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "side conversation" },
    { author: author("usr_ann", "Ann") },
  );
  assert.equal((await h.events()).filter((event) => event.type === "person/message").length, 1);

  await h.store.patchProjection!(SESSION_ID, (current) => ({ ...current, status: "archived" }));
  await assert.rejects(
    h.sessions.postPersonMessage!(SESSION_ID, { text: "too late" }, { author: author("usr_ann", "Ann") }),
    { code: "conflict" },
  );
});

test("mentions keep only Space members who can open the session, exclude the author and dedupe", async (t) => {
  const h = await harness(t);
  const result = await h.sessions.postPersonMessage!(
    SESSION_ID,
    {
      text: "ping",
      mentions: ["usr_bea", "usr_bea", "usr_cara", "usr_outsider", "usr_ghost", "usr_ann"],
    },
    { author: author("usr_ann", "Ann") },
  );
  assert.deepEqual(result.mentions, ["usr_bea", "usr_cara"]);
  const message = (await h.events()).find((event) => event.type === "person/message")!;
  assert.deepEqual(
    (message.data as { mentions: Array<{ userId: string; name?: string }> }).mentions,
    [{ userId: "usr_bea", name: "Bea" }, { userId: "usr_cara", name: "Cara" }],
  );
  // Mention metadata is persisted per mentioned person only.
  assert.equal(h.store.personStates([SESSION_ID], "usr_bea")[SESSION_ID]?.lastMentionSeq, message.seq);
  assert.equal(h.store.personStates([SESSION_ID], "usr_cara")[SESSION_ID]?.lastMentionSeq, message.seq);
  assert.equal(h.store.personStates([SESSION_ID], "usr_outsider")[SESSION_ID], undefined);
});

test("a retried clientOperationId returns the first result once", async (t) => {
  const h = await harness(t);
  const input = { text: "sent once", clientOperationId: "op-1" };
  const first = await h.sessions.postPersonMessage!(SESSION_ID, input, { author: author("usr_ann", "Ann") });
  const second = await h.sessions.postPersonMessage!(SESSION_ID, input, { author: author("usr_ann", "Ann") });
  assert.deepEqual(second, first);
  assert.equal((await h.events()).filter((event) => event.type === "person/message").length, 1);
});

test("replyToSeq must name an existing person message in this session", async (t) => {
  const h = await harness(t);
  const root = await h.sessions.postPersonMessage!(SESSION_ID, { text: "root" }, { author: author("usr_ann", "Ann") });
  const reply = await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "reply", replyToSeq: root.seq },
    { author: author("usr_bea", "Bea") },
  );
  const stored = (await h.events()).find((event) => event.seq === reply.seq)!;
  assert.equal((stored.data as { replyToSeq?: number }).replyToSeq, root.seq);
  await assert.rejects(
    h.sessions.postPersonMessage!(SESSION_ID, { text: "no", replyToSeq: root.seq + 100 }, { author: author("usr_bea", "Bea") }),
    { code: "invalid-input" },
  );
  const user = await h.store.append(SESSION_ID, "user/message", { text: "a prompt" });
  await assert.rejects(
    h.sessions.postPersonMessage!(SESSION_ID, { text: "no", replyToSeq: user.seq }, { author: author("usr_bea", "Bea") }),
    { code: "invalid-input" },
  );
});

test("mention attention follows the reader's own cursor, and mute is per person", async (t) => {
  const h = await harness(t);
  const posted = await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "for Bea", mentions: ["usr_bea"] },
    { author: author("usr_ann", "Ann") },
  );
  const base: SessionProjection = {
    ...(await h.store.projection(SESSION_ID))!,
    attention: { questions: 0, permissions: 0, unread: 0 },
  };
  const bea = h.people.personalize([base], "usr_bea")[0]!;
  assert.equal(bea.attention?.mentions, 1);
  assert.equal(h.people.personalize([base], "usr_cara")[0]?.attention?.mentions, undefined);

  await h.sessions.markRead!(SESSION_ID, posted.seq, { userId: "usr_bea" });
  // Absent or 0 both mean "no unread mentions"; the reader's own cursor clears it.
  assert.equal(h.people.personalize([base], "usr_bea")[0]?.attention?.mentions ?? 0, 0);

  await h.sessions.setPersonMute!(SESSION_ID, true, { userId: "usr_bea" });
  assert.equal(h.store.personStates([SESSION_ID], "usr_bea")[SESSION_ID]?.muted, true);
  assert.equal(h.people.personalize([base], "usr_bea")[0]?.muted, true);
  assert.equal(h.store.personStates([SESSION_ID], "usr_cara")[SESSION_ID]?.muted, undefined);
});

test("mention candidates are Space members who can open the session, reader excluded", async (t) => {
  const h = await harness(t);
  assert.deepEqual(
    sessionMentionCandidates("spc_home", SESSION_ID, "usr_ann").map((candidate) => [candidate.userId, candidate.access]),
    [["usr_bea", "collaborate"], ["usr_cara", "view"]],
  );
  const viaService = await h.sessions.mentionCandidates!(SESSION_ID, { userId: "usr_bea" });
  assert.deepEqual(viaService.map((candidate) => candidate.userId), ["usr_ann", "usr_cara"]);
  assert.equal(viaService.some((candidate) => candidate.userId === "usr_outsider"), false);
});

test("a conversation notifies mentioned people (mention) and other unmuted participants (message)", async (t) => {
  const h = await harness(t);
  await h.store.patchProjection!(SESSION_ID, (current) => ({ ...current, purpose: SESSION_PURPOSE_CONVERSATION }));
  await h.sessions.setPersonMute!(SESSION_ID, true, { userId: "usr_cara" });
  await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "status update", mentions: ["usr_bea"] },
    { author: author("usr_ann", "Ann") },
  );
  assert.equal(h.notifications.length, 1);
  const notice = h.notifications[0]!;
  assert.deepEqual(notice.mentions.map((person) => person.userId), ["usr_bea"]);
  // Cara is unmuted? No: muted conversations still get nothing but mentions,
  // and she was not mentioned. The author is never a recipient.
  assert.deepEqual(notice.audience, []);
  assert.equal(notice.author.userId, "usr_ann");

  // Unmute: the next message reaches her as `message`, while Bea is mentioned.
  await h.sessions.setPersonMute!(SESSION_ID, false, { userId: "usr_cara" });
  await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "another update", mentions: ["usr_bea"] },
    { author: author("usr_ann", "Ann") },
  );
  const second = h.notifications[1]!;
  assert.deepEqual(second.mentions.map((person) => person.userId), ["usr_bea"]);
  assert.deepEqual(second.audience.map((person) => person.userId), ["usr_cara"]);
  assert.equal(second.audience.some((person) => person.userId === "usr_ann"), false);
  assert.equal(second.audience.some((person) => person.userId === "usr_bea"), false);
});

test("a message republishes the chat: newer updatedAt and each reader's own unread and mention counts", async (t) => {
  const h = await harness(t);
  await h.store.patchProjection!(SESSION_ID, (current) => ({ ...current, purpose: SESSION_PURPOSE_CONVERSATION }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.projections.length = 0;
  const posted = await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "lunch at one?", mentions: ["usr_bea"] },
    { author: author("usr_ann", "Ann") },
  );
  const deadline = Date.now() + 2_000;
  while (h.projections.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.projections.length, 1, "one projection per message");
  const published = h.projections[0]!;
  const message = (await h.events()).find((event) => event.seq === posted.seq)!;
  assert.equal(published.id, SESSION_ID);
  assert.ok(published.updatedAt >= message.time, "the chat moves up the navigator");
  // The WS personalizes this row per socket: each reader gets their own view.
  const view = (userId: string) => h.people.personalize([published], userId)[0]!;
  assert.equal(view("usr_bea").attention?.unread, 1);
  assert.equal(view("usr_bea").attention?.mentions, 1, "the mention cursor is written before the fan-out");
  assert.equal(view("usr_cara").attention?.unread, 1);
  assert.equal(view("usr_cara").attention?.mentions ?? 0, 0);
  assert.equal(view("usr_ann").attention?.unread ?? 0, 0, "one's own message is never unread");
});

test("an ordinary chat delivers no conversation audience notifications", async (t) => {
  const h = await harness(t);
  await h.sessions.postPersonMessage!(
    SESSION_ID,
    { text: "just us" },
    { author: author("usr_ann", "Ann") },
  );
  assert.equal(h.notifications[0]!.audience.length, 0);
});

test("access level gates carrying to the agent: view posts, view+carry is forbidden", async (t) => {
  const h = await harness(t);
  const cara = accessControlledSessionService(h.ctx("usr_cara", "member"), h.sessions);
  const posted = await cara.postPersonMessage!(SESSION_ID, { text: "view can post" }, { author: author("usr_cara", "Cara") });
  assert.ok(posted.seq > 0);
  await assert.rejects(
    cara.postPersonMessage!(SESSION_ID, { text: "carry", carryToAgent: true }, { author: author("usr_cara", "Cara") }),
    { code: "forbidden" },
  );
  // A collaborator may carry.
  const bea = accessControlledSessionService(h.ctx("usr_bea", "member"), h.sessions);
  await bea.postPersonMessage!(SESSION_ID, { text: "carry", carryToAgent: true }, { author: author("usr_bea", "Bea") });
});

test("a foreign Space or non-member session id is not-found with no leak", async (t) => {
  const h = await harness(t);
  const outsider = accessControlledSessionService(h.ctx("usr_outsider", "member", "spc_work"), h.sessions);
  await assert.rejects(
    outsider.postPersonMessage!(SESSION_ID, { text: "x" }, { author: author("usr_outsider", "Outsider") }),
    { code: "not-found" },
  );
  await assert.rejects(
    outsider.mentionCandidates!(SESSION_ID),
    { code: "not-found" },
  );
});

test("sessionAudience names only members who can open the chat", async (t) => {
  const h = await harness(t);
  assert.deepEqual(
    sessionAudience("spc_home", SESSION_ID).map((member) => [member.userId, member.access]),
    [["usr_ann", "manage"], ["usr_bea", "collaborate"], ["usr_cara", "view"]],
  );
  assert.deepEqual(sessionAudience("spc_work", SESSION_ID), []);
});
