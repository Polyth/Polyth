// Mentioning someone who cannot open the chat (Spaces §14.8): the sender's own
// sharing rights open it together with the message, or whoever can share is
// asked and their answer delivers the mention. Real canonical identity, real
// store, real session and sharing services, behind the real access layer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  PersonAccessResolvedData,
  PersonMessageData,
  Project,
  ProjectService,
  SessionVisibility,
  SpaceContext,
} from "@polyth/contracts";
import { PERSON_ACCESS_RESOLVED_EVENT, PERSON_MESSAGE_EVENT } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { accessControlledSessionService } from "../src/sessionResourceAccess.ts";
import { createSessionService } from "../src/sessions.ts";
import { createSessionSharingService, sessionAccess } from "../src/sessionSharing.ts";

const ROLES = { usr_ann: "owner", usr_bea: "member", usr_cara: "member", usr_dan: "viewer", usr_far: "member" } as const;
type Person = keyof typeof ROLES;

interface Delivered {
  sessionId: string;
  seq: number;
  author: { userId: string };
  text: string;
  mentions: Array<{ userId: string; name?: string }>;
  audience: Array<{ userId: string }>;
  accessRequest?: { approver: { userId: string }; people: Array<{ userId: string }> };
}

async function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-mention-access-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true, now: () => 1_000 });
  security.control.transaction(() => {
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_work"]) {
      security.control.run(
        "INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)",
        space, space, space,
      );
    }
    const add = (id: string, name: string, role: string, space: string) => {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,?,1)", space, id, role);
    };
    add("usr_ann", "Ann", ROLES.usr_ann, "spc_home");
    add("usr_bea", "Bea", ROLES.usr_bea, "spc_home");
    add("usr_cara", "Cara Bell", ROLES.usr_cara, "spc_home");
    add("usr_dan", "Dan", ROLES.usr_dan, "spc_home");
    add("usr_far", "Far", ROLES.usr_far, "spc_home");
    add("usr_outsider", "Outsider", "member", "spc_work");
  });
  const binding = bindCanonicalSecurity(security);
  const store = createStore(join(root, "sessions.db"));
  t.after(() => {
    void store.close();
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project: Project = { id: "prj_home", path: join(root, "project"), name: "Home", createdAt: 1, spaceId: "spc_home" };
  const projects: ProjectService = {
    async list() { return [project]; },
    async add() { return project; },
    async create() { return project; },
    async remove() {},
    async get(id) { return id === project.id ? project : undefined; },
  };
  const delivered: Delivered[] = [];
  const sessions = createSessionService({
    store,
    projects,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    runtimes: { forProject: async () => ({ startTurn: async () => {} } as unknown as AgentRuntime) },
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    org: store,
    notify: { personMessage: (input) => { delivered.push(input as Delivered); } },
  });
  const accessChanged: string[][] = [];
  const sharing = createSessionSharingService({
    projection: (sessionId) => store.projection(sessionId),
    accessChanged: (rows) => { accessChanged.push(rows.map((row) => row.id)); },
    hasPersonalMcpServers: (userId) => userId === "usr_ann",
  });

  const resource = (input: { id: string; kind: "project" | "session"; owner: string; visibility: string; parentId?: string; accessParentId?: string }) => {
    const operationId = randomUUID();
    security.resources.begin({
      operationId,
      resourceId: input.id,
      kind: input.kind,
      orgId: "org_home",
      spaceId: "spc_home",
      ownerPrincipalId: input.owner,
      createdBy: input.owner,
      visibility: input.visibility as SessionVisibility,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.accessParentId ? { accessParentId: input.accessParentId } : {}),
    });
    security.resources.recordDomainReady(operationId, JSON.stringify({ id: input.id }));
    security.resources.activate(operationId, security.resources.resource(input.id)!.revision);
  };
  resource({ id: project.id, kind: "project", owner: "usr_ann", visibility: "space" });

  const chat = async (id: string, owner: Person, grants: Array<[Person, "view" | "collaborate" | "manage"]> = []) => {
    await store.upsertProjection({ id, projectId: project.id, spaceId: "spc_home", title: "Team", status: "idle", createdAt: 1, updatedAt: 1 });
    resource({ id, kind: "session", owner, visibility: grants.length > 0 ? "restricted" : "private", parentId: project.id });
    if (grants.length > 0) {
      security.sharing.share({
        resourceId: id, orgId: "org_home", spaceId: "spc_home", actor: owner, visibility: "restricted",
        grants: grants.map(([principalId, access]) => ({ principalId, access })),
      });
    }
    return id;
  };

  const ctx = (userId: string, spaceId = "spc_home"): SpaceContext => ({
    spaceId, spaceSlug: spaceId, userId,
    role: (ROLES as Record<string, SpaceContext["role"]>)[userId] ?? "member",
    deployment: "local-trusted", storageDir: join(root, spaceId),
  });
  /** What the Space facade hands the service: this person, their own rights. */
  const as = (userId: string, spaceId = "spc_home") => {
    const context = ctx(userId, spaceId);
    const service = accessControlledSessionService(context, sessions);
    const admission = (sessionId: string) => ({
      author: { userId, name: userId },
      openChatTo: (people: Parameters<typeof sharing.addPeople>[2]) => sharing.addPeople(context, sessionId, people),
    });
    return {
      post: (sessionId: string, input: Parameters<NonNullable<typeof service.postPersonMessage>>[1]) =>
        service.postPersonMessage!(sessionId, input, admission(sessionId)),
      decide: (sessionId: string, seq: number, input: Parameters<NonNullable<typeof service.decidePersonAccess>>[2]) =>
        service.decidePersonAccess!(sessionId, seq, input, admission(sessionId)),
      outsiders: (sessionId: string) => sharing.outsiders(context, sessionId),
      newChat: (projectId: string) => sharing.newChatPeople(context, projectId),
    };
  };
  const messages = async (sessionId: string) => (await store.events(sessionId))
    .filter((event) => event.type === PERSON_MESSAGE_EVENT)
    .map((event) => ({ seq: event.seq, data: event.data as unknown as PersonMessageData }));
  const answers = async (sessionId: string) => (await store.events(sessionId))
    .filter((event) => event.type === PERSON_ACCESS_RESOLVED_EVENT)
    .map((event) => event.data as unknown as PersonAccessResolvedData);
  const levelOf = (userId: string, sessionId: string) => sessionAccess(userId, "spc_home", sessionId)?.level;
  const visibility = (sessionId: string) => sharing.state(ctx("usr_ann"), sessionId).visibility;
  return { security, store, sharing, chat, as, messages, answers, levelOf, visibility, delivered, accessChanged, resource };
}

test("the people outside a chat: the owner may share, others are told who can", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "collaborate"]]);

  const forOwner = h.as("usr_ann").outsiders(id);
  assert.deepEqual(forOwner.people.map((person) => person.userId), ["usr_cara", "usr_dan", "usr_far"]);
  assert.equal(forOwner.people[0]!.name, "Cara Bell");
  assert.equal(forOwner.action, "share");
  assert.deepEqual(forOwner.levels, ["view", "collaborate", "manage"]);
  // Already shared: the personal MCP servers are gone either way.
  assert.equal(forOwner.personalMcpDetachedOnShare, undefined);

  const forMember = h.as("usr_bea").outsiders(id);
  assert.equal(forMember.action, "request");
  assert.deepEqual(forMember.levels, []);
  assert.equal(forMember.approver?.userId, "usr_ann");
  assert.equal(forMember.approver?.name, "Ann");
  // Another Space's people never appear, whoever asks.
  assert.ok(!forMember.people.some((person) => person.userId === "usr_outsider"));

  const privateChat = await h.chat("sess_b", "usr_ann");
  assert.equal(h.as("usr_ann").outsiders(privateChat).personalMcpDetachedOnShare, true);
});

test("a chat nobody can open up says so, and the policy caps the levels offered", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_bea", [["usr_cara", "view"]]);
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { maxMemberAccess: "collaborate" } });
  assert.deepEqual(h.as("usr_bea").outsiders(id).levels, ["view", "collaborate"]);

  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { membersMayShare: false } });
  const forOwner = h.as("usr_bea").outsiders(id);
  assert.equal(forOwner.action, "none");
  assert.equal(forOwner.approver, undefined);
  // A Space admin gets nothing on a private chat, so they cannot be asked.
  assert.equal(h.as("usr_cara").outsiders(id).action, "none");
});

test("a chat of another Space, or one the reader cannot open, answers not-found", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann");
  assert.throws(() => h.as("usr_outsider", "spc_work").outsiders(id), (error: { code?: string }) => error.code === "not-found");
  assert.throws(() => h.as("usr_cara").outsiders(id), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(
    h.as("usr_outsider", "spc_work").decide(id, 1, { decision: "share" }),
    (error: { code?: string }) => error.code === "not-found",
  );
});

test("the first words to a person name a chat nothing else has named", async (t) => {
  const h = await harness(t);
  const untitled = await h.chat("sess_untitled", "usr_ann");
  await h.store.upsertProjection({ ...(await h.store.projection(untitled))!, title: "" });
  await h.as("usr_ann").post(untitled, { text: "Please check the budget" });
  assert.equal((await h.store.projection(untitled))?.title, "Please check the budget");
  await h.as("usr_ann").post(untitled, { text: "And one more thing" });
  assert.equal((await h.store.projection(untitled))?.title, "Please check the budget", "only the first");

  const named = await h.chat("sess_named", "usr_ann");
  await h.as("usr_ann").post(named, { text: "Please check the budget" });
  assert.equal((await h.store.projection(named))?.title, "Team", "a chat with a name keeps it");
});

test("a chat not started yet: its owner-to-be may share it with the rest of the Space", async (t) => {
  const h = await harness(t);
  const forAnn = h.as("usr_ann").newChat("prj_home");
  assert.equal(forAnn.action, "share");
  assert.deepEqual(forAnn.levels, ["view", "collaborate", "manage"]);
  assert.deepEqual(forAnn.people.map((person) => person.userId).sort(), ["usr_bea", "usr_cara", "usr_dan", "usr_far"]);
  assert.equal(forAnn.people.find((person) => person.userId === "usr_cara")?.name, "Cara Bell");
  assert.deepEqual(forAnn.inside, []);
  assert.equal(forAnn.personalMcpDetachedOnShare, true);
  assert.equal(h.as("usr_bea").newChat("prj_home").personalMcpDetachedOnShare, undefined);
});

test("a chat not started yet follows the policy and never offers to ask", async (t) => {
  const h = await harness(t);
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { maxMemberAccess: "collaborate" } });
  assert.deepEqual(h.as("usr_bea").newChat("prj_home").levels, ["view", "collaborate"]);
  assert.equal(h.as("usr_dan").newChat("prj_home").action, "none", "a viewer cannot share");

  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { membersMayShare: false } });
  const forMember = h.as("usr_bea").newChat("prj_home");
  assert.equal(forMember.action, "none");
  assert.deepEqual(forMember.levels, []);
  assert.equal(forMember.approver, undefined);
  assert.equal(forMember.people.length, 4, "they can still be named, and the line says nobody can share");
  assert.equal(h.as("usr_ann").newChat("prj_home").action, "share");
});

test("where new chats follow their project, its people are inside from the start", async (t) => {
  const h = await harness(t);
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { defaultVisibility: "space" } });
  const answer = h.as("usr_ann").newChat("prj_home");
  assert.deepEqual(answer.people, []);
  assert.deepEqual(answer.inside.map((person) => person.userId).sort(), ["usr_bea", "usr_cara", "usr_dan", "usr_far"]);
  assert.equal(answer.inside.find((person) => person.userId === "usr_dan")?.access, "view");
  assert.equal(answer.personalMcpDetachedOnShare, undefined, "such a chat never was private");
});

test("a chat not started yet in a project the reader cannot open answers not-found", async (t) => {
  const h = await harness(t);
  const notFound = (error: unknown) => (error as { code?: string }).code === "not-found";
  assert.throws(() => h.as("usr_ann").newChat("prj_nope"), notFound);
  assert.throws(() => h.as("usr_ann").newChat(""), notFound);
  assert.throws(() => h.as("usr_outsider", "spc_work").newChat("prj_home"), notFound, "another Space's project does not exist here");
});

test("sharing with a message opens the chat first, so the mention lands", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann");
  assert.equal(h.levelOf("usr_cara", id), undefined);

  const result = await h.as("usr_ann").post(id, {
    text: "@Cara have a look",
    mentions: ["usr_cara"],
    shareWith: [{ userId: "usr_cara", access: "view" }],
  });

  assert.deepEqual(result.mentions, ["usr_cara"]);
  assert.equal(h.levelOf("usr_cara", id), "view");
  assert.deepEqual(h.accessChanged, [[id]]);
  const [message] = await h.messages(id);
  assert.deepEqual(message!.data.mentions, [{ userId: "usr_cara", name: "Cara Bell" }]);
  assert.equal(message!.data.accessRequest, undefined);
  assert.deepEqual(h.delivered.map((entry) => entry.mentions.map((person) => person.userId)), [["usr_cara"]]);
  assert.equal(h.delivered[0]!.accessRequest, undefined);
  assert.equal(h.visibility(id), "restricted");
});

test("sharing with a message honours the chosen level and keeps earlier people", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "collaborate"]]);
  await h.as("usr_ann").post(id, {
    text: "@Cara please edit",
    mentions: ["usr_cara"],
    shareWith: [{ userId: "usr_cara", access: "collaborate" }],
  });
  assert.equal(h.levelOf("usr_cara", id), "collaborate");
  assert.equal(h.levelOf("usr_bea", id), "collaborate");
});

test("without the right to share the whole message is refused and nothing changes", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "collaborate"]]);
  await assert.rejects(
    h.as("usr_bea").post(id, { text: "hi", mentions: ["usr_cara"], shareWith: [{ userId: "usr_cara", access: "view" }] }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.equal(h.levelOf("usr_cara", id), undefined);
  assert.equal((await h.messages(id)).length, 0);
  assert.equal(h.delivered.length, 0);

  // A level above the Space's cap for members refuses it the same way.
  const own = await h.chat("sess_b", "usr_bea");
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { maxMemberAccess: "view" } });
  await assert.rejects(
    h.as("usr_bea").post(own, { text: "hi", shareWith: [{ userId: "usr_cara", access: "manage" }] }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.equal(h.levelOf("usr_cara", own), undefined);
});

test("a sent message leaves its author's draft, and only while it still holds those words", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_draft", "usr_ann");
  const draftOf = (userId: string) => h.store.personStates!([id], userId)[id]?.draft;

  await h.store.savePersonDraft!(id, "usr_ann", "  @Cara have a look ", 10);
  await h.store.savePersonDraft!(id, "usr_bea", "@Cara have a look", 10);
  await h.as("usr_ann").post(id, { text: "@Cara have a look", mentions: ["usr_cara"], shareWith: [{ userId: "usr_cara", access: "view" }] });
  assert.equal(draftOf("usr_ann"), undefined, "the sent words are gone, whatever whitespace they kept");
  assert.equal(draftOf("usr_bea"), "@Cara have a look", "another person's draft is theirs");

  await h.store.savePersonDraft!(id, "usr_ann", "and one more thing", 20);
  await h.as("usr_ann").post(id, { text: "something else" });
  assert.equal(draftOf("usr_ann"), "and one more thing", "newer typing stays");
});

test("a message that fails on its own terms opens nothing", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann");
  const share = [{ userId: "usr_cara", access: "view" as const }];
  await assert.rejects(h.as("usr_ann").post(id, { text: "   ", shareWith: share }), (error: { code?: string }) => error.code === "invalid-input");
  await assert.rejects(
    h.as("usr_ann").post(id, { text: "bad file", shareWith: share, attachments: [{ id: "x" } as never] }),
  );
  await assert.rejects(
    h.as("usr_ann").post(id, { text: "bad level", shareWith: [{ userId: "usr_cara", access: "owner" as never }] }),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  assert.equal(h.levelOf("usr_cara", id), undefined);
  assert.equal((await h.messages(id)).length, 0);
});

test("an id outside the Space opens nothing, reveals nothing and the message still lands", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann");
  const result = await h.as("usr_ann").post(id, {
    text: "hello",
    mentions: ["usr_outsider", "usr_ghost"],
    shareWith: [{ userId: "usr_outsider", access: "view" }, { userId: "usr_ghost", access: "view" }],
  });
  assert.deepEqual(result.mentions, []);
  assert.equal(h.accessChanged.length, 0);
  assert.equal(h.levelOf("usr_outsider", id), undefined);
  assert.equal(h.visibility(id), "private");
});

test("a retried share returns the first result once", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann");
  const input = { text: "@Cara", mentions: ["usr_cara"], shareWith: [{ userId: "usr_cara", access: "view" as const }], clientOperationId: "op-1" };
  const first = await h.as("usr_ann").post(id, input);
  const second = await h.as("usr_ann").post(id, input);
  assert.equal(second.seq, first.seq);
  assert.equal((await h.messages(id)).length, 1);
  assert.equal(h.accessChanged.length, 1);
  assert.equal(h.delivered.length, 1);
});

test("a person who cannot share asks: nobody outside is told until the answer", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"]]);
  const result = await h.as("usr_bea").post(id, { text: "@Cara look", mentions: ["usr_cara"], requestAccessFor: ["usr_cara"] });

  assert.deepEqual(result.mentions, []);
  assert.deepEqual(result.requested, ["usr_cara"]);
  assert.equal(h.levelOf("usr_cara", id), undefined, "asking opens nothing");
  const [message] = await h.messages(id);
  assert.deepEqual(message!.data.accessRequest, {
    people: [{ userId: "usr_cara", name: "Cara Bell" }],
    approver: { userId: "usr_ann", name: "Ann" },
  });
  assert.deepEqual(h.delivered.map((entry) => entry.mentions.map((person) => person.userId)), [[]]);
  assert.equal(h.delivered[0]!.accessRequest?.approver.userId, "usr_ann");
  assert.deepEqual(h.delivered[0]!.accessRequest?.people.map((person) => person.userId), ["usr_cara"]);
  const state = h.store.personStates?.([id], "usr_ann")[id];
  assert.equal(state?.lastMentionSeq, message!.seq, "the approver's chat carries the mention mark");
});

test("the approver hears once even when the message also names them", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"]]);
  await h.as("usr_bea").post(id, { text: "@Ann @Cara", mentions: ["usr_ann", "usr_cara"], requestAccessFor: ["usr_cara"] });
  const [message] = await h.messages(id);
  assert.deepEqual(message!.data.mentions.map((person) => person.userId), ["usr_ann"], "the chip stays");
  assert.deepEqual(h.delivered[0]!.mentions, [], "the request is the one alert");
});

test("a request for someone inside the chat, or for nobody real, is dropped", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"], ["usr_cara", "view"]]);
  const result = await h.as("usr_bea").post(id, {
    text: "hi",
    requestAccessFor: ["usr_cara", "usr_outsider", "usr_ghost", "usr_bea"],
  });
  assert.equal(result.requested, undefined);
  const [message] = await h.messages(id);
  assert.equal(message!.data.accessRequest, undefined);
  assert.equal(h.delivered[0]!.accessRequest, undefined);
});

test("with nobody able to answer, a request is dropped rather than left hanging", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_bea", [["usr_cara", "view"]]);
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { membersMayShare: false } });
  const result = await h.as("usr_cara").post(id, { text: "hi", requestAccessFor: ["usr_far"] });
  assert.equal(result.requested, undefined);
});

test("sharing on a request opens the chat and delivers the mention, once", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"]]);
  const { seq } = await h.as("usr_bea").post(id, { text: "@Cara look", mentions: ["usr_cara"], requestAccessFor: ["usr_cara"] });
  h.delivered.length = 0;

  const answer = await h.as("usr_ann").decide(id, seq, { decision: "share" });
  assert.deepEqual(answer, { outcome: "shared", people: ["usr_cara"] });
  assert.equal(h.levelOf("usr_cara", id), "view");
  const resolved = await h.answers(id);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.messageSeq, seq);
  assert.equal(resolved[0]!.outcome, "shared");
  assert.equal(resolved[0]!.by.userId, "usr_ann");
  assert.deepEqual(resolved[0]!.people, [{ userId: "usr_cara", name: "Cara Bell" }]);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.seq, seq);
  assert.equal(h.delivered[0]!.author.userId, "usr_bea", "the words stay the author's");
  assert.equal(h.delivered[0]!.text, "@Cara look");
  assert.deepEqual(h.delivered[0]!.mentions.map((person) => person.userId), ["usr_cara"]);
  const state = h.store.personStates?.([id], "usr_cara")[id];
  assert.equal(state?.lastMentionSeq, seq);

  const again = await h.as("usr_ann").decide(id, seq, { decision: "decline" });
  assert.deepEqual(again, { outcome: "shared", people: ["usr_cara"] }, "the first answer stands");
  assert.equal((await h.answers(id)).length, 1);
  assert.equal(h.delivered.length, 1);
});

test("the approver may choose the level", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"]]);
  const { seq } = await h.as("usr_bea").post(id, { text: "x", requestAccessFor: ["usr_cara"] });
  await h.as("usr_ann").decide(id, seq, { decision: "share", access: "collaborate" });
  assert.equal(h.levelOf("usr_cara", id), "collaborate");
});

test("declining opens nothing, tells nobody outside and stands", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "view"]]);
  const { seq } = await h.as("usr_bea").post(id, { text: "x", requestAccessFor: ["usr_cara"] });
  h.delivered.length = 0;

  assert.deepEqual(await h.as("usr_ann").decide(id, seq, { decision: "decline" }), { outcome: "declined", people: ["usr_cara"] });
  assert.equal(h.levelOf("usr_cara", id), undefined);
  assert.equal(h.delivered.length, 0);
  assert.deepEqual(await h.as("usr_ann").decide(id, seq, { decision: "share" }), { outcome: "declined", people: ["usr_cara"] });
  assert.equal(h.levelOf("usr_cara", id), undefined);
});

test("only someone who manages the chat answers, and only a real request", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_ann", [["usr_bea", "collaborate"], ["usr_far", "manage"]]);
  const { seq } = await h.as("usr_bea").post(id, { text: "x", requestAccessFor: ["usr_cara"] });
  await assert.rejects(h.as("usr_bea").decide(id, seq, { decision: "share" }), (error: { code?: string }) => error.code === "forbidden");
  await assert.rejects(h.as("usr_cara").decide(id, seq, { decision: "share" }), (error: { code?: string }) => error.code === "not-found");
  assert.equal(h.levelOf("usr_cara", id), undefined);

  const plain = await h.as("usr_bea").post(id, { text: "no request" });
  await assert.rejects(h.as("usr_ann").decide(id, plain.seq, { decision: "share" }), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(h.as("usr_ann").decide(id, 999, { decision: "share" }), (error: { code?: string }) => error.code === "not-found");

  // Someone else who manages it may answer too.
  assert.equal((await h.as("usr_far").decide(id, seq, { decision: "share" })).outcome, "shared");
});

test("an answer that has lost the right to share changes nothing", async (t) => {
  const h = await harness(t);
  const id = await h.chat("sess_a", "usr_bea", [["usr_cara", "view"]]);
  const { seq } = await h.as("usr_cara").post(id, { text: "x", requestAccessFor: ["usr_far"] });
  h.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_ann", patch: { membersMayShare: false } });
  await assert.rejects(h.as("usr_bea").decide(id, seq, { decision: "share" }), (error: { code?: string }) => error.code === "forbidden");
  assert.equal(h.levelOf("usr_far", id), undefined);
  assert.equal((await h.answers(id)).length, 0, "the request stays open");
});

test("a delegated subagent's chat opens through the chat it follows", async (t) => {
  const h = await harness(t);
  const parent = await h.chat("sess_parent", "usr_ann");
  await h.store.upsertProjection({ id: "sess_child", projectId: "prj_home", spaceId: "spc_home", title: "Child", status: "idle", createdAt: 1, updatedAt: 1 });
  h.resource({ id: "sess_child", kind: "session", owner: "usr_ann", visibility: "inherit", parentId: "prj_home", accessParentId: parent });
  assert.equal(h.as("usr_ann").outsiders("sess_child").action, "share");

  const result = await h.as("usr_ann").post("sess_child", {
    text: "@Cara",
    mentions: ["usr_cara"],
    shareWith: [{ userId: "usr_cara", access: "view" }],
  });
  assert.deepEqual(result.mentions, ["usr_cara"]);
  assert.equal(h.levelOf("usr_cara", parent), "view");
  assert.equal(h.levelOf("usr_cara", "sess_child"), "view");
});
