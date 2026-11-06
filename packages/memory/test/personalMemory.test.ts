// Personal memory in a shared project (Spaces §14.6): a chat's real audience, and
// nothing a request or a model says, decides whose notes it can reach.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCapabilityContribution, SessionPrivacy, SpaceContext } from "@polyth/contracts";
import { createMemoryRuntimeService, createMemoryService, memoryRoutes, registerMemoryTool } from "../src/service.ts";
import { createMemoryStore } from "../../knowledge/src/memory.ts";

const OLIA = "usr_olia";
const TARAS = "usr_taras";
const ADMIN = "usr_admin";
const SPACE = "space-a";
const person = (userId: string, role: SpaceContext["role"] = "member"): SpaceContext => ({
  spaceId: SPACE, spaceSlug: SPACE, userId, role, deployment: "local-trusted", storageDir: join(tmpdir(), SPACE),
});
const system = { ...person("system:polyth-runtime", "owner") };

const readers = (...ids: string[]) => ids.map((userId) => ({ userId, name: userId.slice(4) }));
const PRIVACY: Record<string, SessionPrivacy> = {
  shared: { audience: readers(OLIA, TARAS), projectAudience: 3 },
  oliaChat: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 3, othersHere: true },
  tarasChat: { privateTo: TARAS, audience: readers(TARAS), projectAudience: 3, othersHere: true },
  oliaChat2: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 3, othersHere: true },
  oliaAloneChat: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 3 },
  roomChat: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 3, inPrivateRoom: true },
  soloChat: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 1 },
};

function fixture() {
  const store = createMemoryStore(new DatabaseSync(":memory:"), SPACE);
  const PROJECTS: Record<string, { id: string; name: string; parentProjectId?: string; personal?: true }> = {
    wellness: { id: "wellness", name: "Wellness" },
    room: { id: "room", name: "Wellness", parentProjectId: "wellness" },
    solo: { id: "solo", name: "Solo" },
    oliaWork: { id: "oliaWork", name: "Olia's work" },
    personal: { id: "personal", name: "Personal", personal: true },
  };
  const LISTS: Record<string, string[]> = {
    [OLIA]: ["wellness", "oliaWork", "personal", "solo"],
    [TARAS]: ["wellness"],
    [ADMIN]: ["wellness", "oliaWork", "solo"],
  };
  const contributions = new Map<string, AgentCapabilityContribution>();
  const registry = { register(_owner: string, value: AgentCapabilityContribution) { contributions.set((value.descriptor as { name?: string; id: string }).name ?? value.descriptor.id, value); return { dispose() {} }; } };
  const exposed: string[] = [];
  const events = new Map<string, Array<Record<string, unknown>>>();
  const prompts: string[] = [];
  const host = {
    forSpace(ctx: SpaceContext) {
      const openable = (id: string) => ctx.userId.startsWith("system:") || LISTS[ctx.userId]?.includes(PROJECTS[id]?.parentProjectId ?? id);
      return {
        projects: {
          get: async (id: string) => openable(id) ? PROJECTS[id] : undefined,
          list: async () => Object.values(PROJECTS).filter((project) => !project.parentProjectId && openable(project.id)),
          privateRooms: async (id: string) => Object.values(PROJECTS).filter((project) => project.parentProjectId === id),
        },
        sessions: {
          list: async (id: string) => [...events.keys()].filter((key) => key.startsWith(`${id}:`)).map((key) => ({ id: key.split(":")[1] })),
          events: async (id: string) => [...events.entries()].find(([key]) => key.endsWith(`:${id}`))?.[1] ?? [],
        },
      };
    },
    systemSpaceContext: () => system,
    personSpaceContext: (userId: string) => person(userId),
    sessionPrivacy: (_space: string, sessionId: string) => PRIVACY[sessionId],
    markPersonalContext: async (sessionId: string) => { exposed.push(sessionId); },
    services: { get(key: { id: string }) { return key.id === "polyth.service.harness.capabilities" ? registry : undefined; } },
    store: { latestSeq: async (id: string) => [...events.entries()].find(([key]) => key.endsWith(`:${id}`))?.[1]?.length ?? 0, projection: async () => undefined },
    projects: { list: async () => [{ ...PROJECTS.wellness, spaceId: SPACE }] },
    resolveSessionRuntime: async () => ({ rt: {}, cwd: "/tmp" }),
    smallModelInputBudget: async () => 24_000,
    smallModelComplete: async (_rt: unknown, options: { prompt: string }) => {
      prompts.push(options.prompt);
      return { text: JSON.stringify({ memories: [{ title: "Sleep", body: "Olia sleeps badly.", category: "observation", about: "Olia" }] }) };
    },
  } as never;
  const service = createMemoryService(host, { async prepareProject() { return { memory: store }; } });
  registerMemoryTool(host, service);
  const runtime = createMemoryRuntimeService(host, service);
  const route = memoryRoutes(host, service);
  const shared = { spaceId: SPACE, projectId: "wellness", principalId: system.userId };
  store.updatePolicy(shared, { projectId: "wellness", expectedSettingsRevision: store.getPolicy(shared).settingsRevision, patch: { mode: "auto" } });
  const tool = (name: string) => contributions.get(name)!;
  const inChat = (sessionId: string, projectId = "wellness", actorUserId = OLIA) => ({ spaceId: SPACE, projectId, cwd: "/tmp", sessionId, actorUserId });
  const call = async (space: SpaceContext, method: string, path: string, body?: Record<string, unknown>, query: Record<string, string> = {}) => {
    const url = new URL(`http://x${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let answer: { code: number; body: unknown } | undefined;
    const handled = await route({ path, method, url, space, body: async () => body ?? {}, json: (code: number, payload: unknown) => { answer = { code, body: payload }; } } as never);
    return { handled, ...(answer ?? { code: 0, body: undefined }) };
  };
  return { store, tool, inChat, runtime, call, exposed, service, events, prompts, shared, host };
}

const remember = (f: ReturnType<typeof fixture>, input: Record<string, unknown>, ctx: ReturnType<ReturnType<typeof fixture>["inChat"]>) =>
  f.tool("memory_remember").execute!({ title: "Ferritin", body: "Ferritin is 9, retest in three months.", ...input }, ctx);

test("a private chat saves to its owner's notes; a shared chat can't, and can't read them", async () => {
  const f = fixture();
  const saved = JSON.parse((await remember(f, {}, f.inChat("oliaChat"))).output) as { memoryId: string };
  const scopeOfRecord = { ...f.shared, layers: [{ layer: "person" as const, userId: OLIA, projectId: "wellness" }] };
  assert.equal(f.store.get(scopeOfRecord, saved.memoryId)?.ownerId, OLIA);
  assert.equal(f.store.get(f.shared, saved.memoryId), undefined, "not in the shared memory");

  // The chat others read: search, get and recall see nothing.
  const shared = f.inChat("shared");
  assert.deepEqual(JSON.parse((await f.tool("memory_search").execute!({ query: "ferritin" }, shared)).output).items, []);
  await assert.rejects(f.tool("memory_get").execute!({ memoryId: saved.memoryId }, shared), /not found/);
  const sharedRecall = await f.runtime.recall({ spaceId: SPACE, projectId: "wellness", principalId: "session:shared" }, { sessionId: "shared", intent: "ferritin retest" });
  assert.deepEqual(sharedRecall.selected, []);
  // Nor can a model argument reach for them there.
  await assert.rejects(remember(f, { target: "personal" }, shared), /private to one person/);
  await assert.rejects(remember(f, { target: "about-me" }, shared), /private to one person/);

  // Another person's private chat, an admin's included, sees nothing either.
  const taras = f.inChat("tarasChat", "wellness", TARAS);
  assert.deepEqual(JSON.parse((await f.tool("memory_search").execute!({ query: "ferritin" }, taras)).output).items, []);
  await assert.rejects(f.tool("memory_get").execute!({ memoryId: saved.memoryId }, taras), /not found/);
  await assert.rejects(f.tool("memory_feedback").execute!({ memoryId: saved.memoryId, expectedRevision: 1, action: "forget" }, taras), /not found/);

  // Its owner gets it back, labelled, and the chat is marked for it.
  const recall = await f.runtime.recall({ spaceId: SPACE, projectId: "wellness", principalId: "session:oliaChat" }, { sessionId: "oliaChat", intent: "ferritin retest" });
  assert.equal(recall.selected[0]?.layer, "person");
  assert.match(recall.modelVisibleText ?? "", /· personal\]/);
  assert.deepEqual(f.exposed, []);
  await f.tool("memory_search").execute!({ query: "ferritin" }, f.inChat("oliaChat"));
  assert.deepEqual(f.exposed, ["oliaChat"]);
});

test("someone working alone in a project keeps the project memory", async () => {
  const f = fixture();
  const access = await f.service.chatAccess(system, "solo", "soloChat");
  assert.deepEqual(access.writeTo, { layer: "project" });
  assert.equal(access.sharedProject, false);
  assert.equal(access.personal?.userId, OLIA, "their own notes are still within reach");
});

test("a chat in a private room reads the project's memory and saves to the owner", async () => {
  const f = fixture();
  f.store.create(f.shared, { projectId: "wellness", title: "Dinner", body: "Dinner is at 19:00, ferritin aside.", lifecycle: "active" });
  const room = f.inChat("roomChat", "room");
  const saved = JSON.parse((await remember(f, {}, room)).output) as { memoryId: string };
  assert.equal(f.store.get(f.shared, saved.memoryId), undefined);
  const found = JSON.parse((await f.tool("memory_search").execute!({ query: "ferritin" }, room)).output).items as Array<{ title: string; layer: string }>;
  assert.deepEqual(found.map((item) => item.layer).sort(), ["person", "project"]);
  const recall = await f.runtime.recall({ spaceId: SPACE, projectId: "room", principalId: "session:roomChat" }, { sessionId: "roomChat", intent: "ferritin dinner" });
  assert.equal(recall.selected.length, 2);
  assert.equal(await f.runtime.checkFence({ spaceId: SPACE, projectId: "room", principalId: "session:roomChat" }, { generation: recall.generation, settingsRevision: recall.settingsRevision }), true, "the room shares its project's policy");
});

test("with nobody else working in the project, a note for the shared memory stays a working personal note", async () => {
  const f = fixture();
  const chat = f.inChat("oliaAloneChat");
  const saved = JSON.parse((await f.tool("memory_remember").execute!({ title: "Dinner time", body: "Dinner moved to 19:30.", target: "shared" }, chat)).output) as { memoryId: string; status: string; message: string };
  assert.notEqual(saved.status, "skipped");
  assert.match(saved.message, /not offered.*nobody else works/);
  // Nothing to decide, others can't read it, and its person's chats recall it.
  const page = await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" });
  assert.deepEqual((page.body as { proposals: unknown[] }).proposals, []);
  assert.equal(f.store.get(f.shared, saved.memoryId), undefined);
  const found = JSON.parse((await f.tool("memory_search").execute!({ query: "dinner moved" }, chat)).output) as { items: Array<{ id: string }> };
  assert.deepEqual(found.items.map((item) => item.id), [saved.memoryId]);
});

test("publishing is one way and takes the person: the agent only proposes", async () => {
  const f = fixture();
  const chat = f.inChat("oliaChat");
  const proposed = JSON.parse((await f.tool("memory_remember").execute!({ title: "More red meat", body: "Olia asks for more red meat at dinner.", target: "shared" }, chat)).output) as { memoryId: string; status: string; message: string };
  assert.match(proposed.message, /lets them share it/);
  assert.equal(f.store.get(f.shared, proposed.memoryId), undefined);
  assert.deepEqual(JSON.parse((await f.tool("memory_search").execute!({ query: "red meat" }, f.inChat("shared"))).output).items, []);

  const page = await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" });
  const [proposal] = (page.body as { proposals: Array<{ id: string; revision: number; body: string }> }).proposals;
  assert.equal(proposal?.body, "Olia asks for more red meat at dinner.");

  // Nobody else can see or publish it, an admin included.
  const adminPage = await f.call(person(ADMIN, "admin"), "GET", "/api/memory/personal", undefined, { projectId: "wellness" });
  assert.deepEqual((adminPage.body as { proposals: unknown[] }).proposals, []);
  await assert.rejects(f.call(person(ADMIN, "admin"), "POST", `/api/memory/personal/${proposal!.id}/publish`, { projectId: "wellness", expectedRevision: proposal!.revision }), /not found/);
  await assert.rejects(f.call(person(TARAS), "POST", `/api/memory/personal/${proposal!.id}/keep`, { projectId: "wellness", expectedRevision: proposal!.revision }), /not found/);

  const published = await f.call(person(OLIA), "POST", `/api/memory/personal/${proposal!.id}/publish`, { projectId: "wellness", expectedRevision: proposal!.revision });
  const copy = f.store.get(f.shared, (published.body as { memoryId: string }).memoryId)!;
  assert.equal(copy.body, proposal!.body);
  assert.equal(copy.layer, "project");
  assert.deepEqual(copy.authoredBy, { kind: "person", userId: OLIA });
  assert.equal(copy.approvedBy?.userId, OLIA);
  assert.equal(((await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" })).body as { proposals: unknown[] }).proposals.length, 0);
  // Publishing copies: the personal note is not the shared one.
  assert.notEqual(copy.id, proposal!.id);
});

test("an offer costs nothing to ignore: the note works at once, and a chat makes one short offer", async () => {
  const f = fixture();
  const chat = f.inChat("oliaChat");
  const offers = async () => ((await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" })).body as { proposals: Array<{ title: string }>; here: Array<{ title: string }> });
  const first = JSON.parse((await f.tool("memory_remember").execute!({ title: "Dinner time", body: "Dinner moved to 19:30.", target: "shared" }, chat)).output) as { message: string };
  assert.match(first.message, /lets them share it/);
  const found = JSON.parse((await f.tool("memory_search").execute!({ query: "dinner moved" }, chat)).output) as { items: unknown[] };
  assert.equal(found.items.length, 1, "their own agent recalls it without any decision");

  const second = JSON.parse((await f.tool("memory_remember").execute!({ title: "Breakfast", body: "Breakfast moved to 8:00.", target: "shared" }, chat)).output) as { message: string };
  assert.match(second.message, /not offered.*already made its offer/);
  const long = JSON.parse((await f.tool("memory_remember").execute!({ title: "Everything", body: "x ".repeat(301), target: "shared" }, f.inChat("oliaChat2"))).output) as { message: string };
  assert.match(long.message, /not offered.*600/);

  const page = await offers();
  assert.deepEqual(page.proposals.map((note) => note.title), ["Dinner time"]);
  assert.deepEqual(page.here.map((note) => note.title).sort(), ["Breakfast", "Dinner time", "Everything"]);
});

test("in a private room with nobody else in the project, nothing is offered", async () => {
  const f = fixture();
  const saved = JSON.parse((await f.tool("memory_remember").execute!({ title: "Dinner time", body: "Dinner moved to 19:30.", target: "shared" }, f.inChat("roomChat", "room"))).output) as { message: string };
  assert.match(saved.message, /not offered.*nobody else works/);
  const page = await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "room" });
  assert.deepEqual((page.body as { proposals: unknown[] }).proposals, []);
});

test("Undo takes back the person's own copy while it is still what they shared", async () => {
  const f = fixture();
  const chat = f.inChat("oliaChat");
  const { memoryId } = JSON.parse((await f.tool("memory_remember").execute!({ title: "Dinner time", body: "Dinner moved to 19:30.", target: "shared" }, chat)).output) as { memoryId: string };
  const publish = await f.call(person(OLIA), "POST", `/api/memory/personal/${memoryId}/publish`, { projectId: "wellness", expectedRevision: 1 });
  const sharedId = (publish.body as { memoryId: string }).memoryId;
  const here = async () => ((await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" })).body as { here: Array<{ id: string }> }).here.map((note) => note.id);
  assert.deepEqual(await here(), [], "shared notes leave Only me");

  // Someone else can't, and neither can they once the copy has changed.
  await assert.rejects(f.call(person(TARAS), "POST", `/api/memory/personal/${memoryId}/unpublish`, { projectId: "wellness", sharedId }), /not found/);
  const copy = f.store.get(f.shared, sharedId)!;
  const edited = f.store.update(f.shared, { id: sharedId, projectId: "wellness", expectedRevision: copy.revision, patch: { body: "Dinner moved to 20:00." } });
  await assert.rejects(f.call(person(OLIA), "POST", `/api/memory/personal/${memoryId}/unpublish`, { projectId: "wellness", sharedId }), /not found/);
  f.store.update(f.shared, { id: sharedId, projectId: "wellness", expectedRevision: edited.revision!, patch: { body: "Dinner moved to 19:30." } });

  await f.call(person(OLIA), "POST", `/api/memory/personal/${memoryId}/unpublish`, { projectId: "wellness", sharedId });
  assert.equal(f.store.get(f.shared, sharedId)?.lifecycle ?? "forgotten", "forgotten");
  assert.deepEqual(await here(), [memoryId], "it works as their note again");
  assert.deepEqual(((await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" })).body as { proposals: unknown[] }).proposals, [], "and isn't offered again");
});

test("no route gives an admin another person's notes", async () => {
  const f = fixture();
  const saved = JSON.parse((await remember(f, {}, f.inChat("oliaChat"))).output) as { memoryId: string };
  const about = JSON.parse((await remember(f, { title: "Short replies", body: "Olia prefers short replies.", target: "about-me" }, f.inChat("oliaChat"))).output) as { memoryId: string };
  const admin = person(ADMIN, "owner");

  const listed = await f.call(admin, "GET", "/api/memory", undefined, { projectId: "wellness" });
  assert.equal((listed.body as { total: number }).total, 0);
  const mine = await f.call(admin, "GET", "/api/memory/personal", undefined, { projectId: "wellness", userId: OLIA, ownerId: OLIA });
  assert.deepEqual((mine.body as { here: unknown[]; aboutMe: unknown[] }).here, []);
  assert.deepEqual((mine.body as { here: unknown[]; aboutMe: unknown[] }).aboutMe, []);
  for (const id of [saved.memoryId, about.memoryId]) {
    await assert.rejects(f.call(admin, "GET", `/api/memory/${id}`, undefined, { projectId: "wellness" }), /not found/);
    await assert.rejects(f.call(admin, "PATCH", `/api/memory/${id}`, { projectId: "wellness", expectedRevision: 1, patch: { title: "x" } }), /not found/);
    await assert.rejects(f.call(admin, "PATCH", `/api/memory/personal/${id}`, { projectId: "wellness", expectedRevision: 1, patch: { title: "x" }, userId: OLIA }), /not found/);
    await assert.rejects(f.call(admin, "DELETE", `/api/memory/personal/${id}`, { projectId: "wellness", expectedRevision: 1 }), /not found/);
  }
  const exported = await f.call(admin, "GET", "/api/memory/export", undefined, { projectId: "wellness" });
  assert.deepEqual((exported.body as { records: unknown[] }).records, []);
  // A system context has no notes of its own and asks for nobody else's.
  await assert.rejects(f.call(system, "GET", "/api/memory/personal", undefined, { projectId: "wellness" }), /belong to a person/);
  // Olia herself reads, edits and deletes them.
  const own = await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" });
  assert.deepEqual((own.body as { here: Array<{ id: string }> }).here.map((row) => row.id), [saved.memoryId]);
  assert.deepEqual((own.body as { aboutMe: Array<{ id: string }> }).aboutMe.map((row) => row.id), [about.memoryId]);
  const edited = await f.call(person(OLIA), "PATCH", `/api/memory/personal/${saved.memoryId}`, { projectId: "wellness", expectedRevision: 1, patch: { title: "Ferritin retest" } });
  assert.equal((edited.body as { revision: number }).revision, 2);
  const made = await f.call(person(OLIA), "POST", "/api/memory/personal", { projectId: "wellness", where: "about-me", title: "Language", body: "Ukrainian." });
  assert.equal(f.store.get({ ...f.shared, layers: [{ layer: "person", userId: OLIA }] }, (made.body as { memoryId: string }).memoryId)?.authoredBy?.kind, "person");
  // Someone else's id in a body or query changes nothing.
  const smuggled = await f.call(person(TARAS), "POST", "/api/memory/personal", { projectId: "wellness", where: "about-me", title: "Mine", body: "Tarasʼs note.", userId: OLIA, ownerId: OLIA, placement: { layer: "person", userId: OLIA } });
  assert.equal(f.store.get({ ...f.shared, layers: [{ layer: "person", userId: OLIA }] }, (smuggled.body as { memoryId: string }).memoryId), undefined);
});

test("a person opens and edits their own note by id; nobody else can, not even an admin", async () => {
  const f = fixture();
  const body = "Ferritin is 9, retest in three months. ".repeat(20).trim();
  const saved = JSON.parse((await remember(f, { body }, f.inChat("oliaChat"))).output) as { memoryId: string };
  const path = `/api/memory/personal/${saved.memoryId}`;
  const query = { projectId: "wellness" };

  const opened = await f.call(person(OLIA), "GET", path, undefined, query);
  const note = opened.body as { body: string; revision: number };
  assert.equal(note.body, body, "the whole note, not a snippet");
  const edited = await f.call(person(OLIA), "PATCH", path, { projectId: "wellness", expectedRevision: note.revision, patch: { title: "Ferritin", body: "Ferritin is 12 now." } });
  assert.equal(edited.code, 200);
  assert.equal(((await f.call(person(OLIA), "GET", path, undefined, query)).body as { body: string }).body, "Ferritin is 12 now.");

  for (const who of [person(TARAS), person(ADMIN, "owner")]) {
    await assert.rejects(f.call(who, "GET", path, undefined, query), { code: "not-found" });
    await assert.rejects(f.call(who, "PATCH", path, { projectId: "wellness", expectedRevision: note.revision + 1, patch: { body: "changed" } }), { code: "not-found" });
  }
  assert.equal(((await f.call(person(OLIA), "GET", path, undefined, query)).body as { body: string }).body, "Ferritin is 12 now.");
});

test("a note from a person's private chat comes up for their review, and only theirs", async () => {
  const f = fixture();
  const fromOlia = f.store.create(f.shared, { projectId: "wellness", title: "Old analysis", body: "Ferritin was 9.", lifecycle: "active", sources: [{ kind: "session", sessionId: "oliaChat" }] });
  f.store.create(f.shared, { projectId: "wellness", title: "From a shared chat", body: "Dinner at 19:00.", lifecycle: "active", sources: [{ kind: "session", sessionId: "shared" }] });
  const review = async (space: SpaceContext) => ((await f.call(space, "GET", "/api/memory/personal", undefined, { projectId: "wellness" })).body as { review: Array<{ title: string; id: string; revision: number }> }).review;
  assert.deepEqual((await review(person(TARAS))).map((row) => row.title), []);
  assert.deepEqual((await review(person(ADMIN, "owner"))).map((row) => row.title), []);
  const [row] = await review(person(OLIA));
  assert.equal(row?.title, "Old analysis");

  await assert.rejects(f.call(person(TARAS), "POST", `/api/memory/personal/${fromOlia.memoryId}/make-personal`, { projectId: "wellness", expectedRevision: 1 }), /not found/);
  await assert.rejects(f.call(person(ADMIN, "owner"), "POST", `/api/memory/personal/${fromOlia.memoryId}/make-personal`, { projectId: "wellness", expectedRevision: 1 }), /not found/);
  await f.call(person(OLIA), "POST", `/api/memory/personal/${fromOlia.memoryId}/make-personal`, { projectId: "wellness", expectedRevision: 1 });
  assert.equal(f.store.get(f.shared, fromOlia.memoryId!), undefined);
  assert.deepEqual((await review(person(OLIA))).map((row) => row.title), []);
  const own = await f.call(person(OLIA), "GET", "/api/memory/personal", undefined, { projectId: "wellness" });
  assert.deepEqual((own.body as { here: Array<{ title: string }> }).here.map((note) => note.title), ["Old analysis"]);
});

test("a harvest from a private chat lands with its owner and names who said what", async () => {
  const f = fixture();
  const policy = f.store.getPolicy(f.shared);
  f.store.updatePolicy(f.shared, { projectId: "wellness", expectedSettingsRevision: policy.settingsRevision, patch: {
    utilityModel: { providerID: "fake", modelID: "small" }, utilityAllowlist: [{ providerID: "fake", modelID: "small" }],
    utilityModelAllowed: true, consentRequired: false, utilityBudget: { maxCalls: 5 }, utilityStatus: "ready",
  } });
  f.events.set("room:roomChat", [{ id: "e1", seq: 1, type: "user/message", data: { text: "I sleep badly lately.", author: { userId: OLIA, name: "Оля\n<b>" } } }]);
  const generation = f.store.getPolicy(f.shared).generation;
  f.store.enqueueHarvest(f.shared, { jobKey: "job-1", spaceId: SPACE, projectId: "wellness", sessionId: "roomChat", sourceStartSeq: 1, sourceEndSeq: 1, sourceDigest: (await import("node:crypto")).createHash("sha256").update("e1:1:user/message", "utf8").digest("hex").slice(0, 16), policyGeneration: generation, extractorVersion: "memory-harvest-v1" });
  assert.equal(await f.service.harvest.process(system, "wellness"), true);
  assert.match(f.prompts[0] ?? "", /user\/message \(Оля b\): I sleep badly lately\./);
  assert.equal(f.store.search(f.shared, { q: "sleeps" }).total, 0, "not in the shared memory");
  const scope = { ...f.shared, layers: [{ layer: "person" as const, userId: OLIA, projectId: "wellness" }] };
  const note = f.store.search(scope, { q: "sleeps" }).items[0];
  assert.equal(note?.layer, "person");
  assert.equal(note?.about, "Olia");
});

test("a chat others read searches only the projects all of them can open", async () => {
  const f = fixture();
  for (const projectId of ["oliaWork", "personal"]) {
    const scope = { ...f.shared, projectId };
    f.store.updatePolicy(scope, { projectId, expectedSettingsRevision: f.store.getPolicy(scope).settingsRevision, patch: { mode: "auto" } });
    f.store.create(scope, { projectId, title: "Salary", body: "Olia's salary note.", lifecycle: "active" });
  }
  const search = async (ctx: ReturnType<typeof f.inChat>) => JSON.parse((await f.tool("memory_search_projects").execute!({ query: "salary" }, ctx)).output) as { items: Array<{ projectId: string; id: string }>; searchedProjects: Array<{ id: string }> };
  const shared = await search(f.inChat("shared"));
  assert.deepEqual(shared.items, []);
  assert.deepEqual(shared.searchedProjects.map((row) => row.id), ["wellness"]);
  const own = await search(f.inChat("oliaChat"));
  assert.deepEqual(own.items.map((row) => row.projectId).sort(), ["oliaWork", "personal"]);
  await assert.rejects(f.tool("memory_get_project").execute!({ projectId: "personal", memoryId: own.items.find((row) => row.projectId === "personal")!.id }, f.inChat("shared")), /not found/);
});

test("a personal note never retires a shared one, and account removal erases only that person's notes", async () => {
  const f = fixture();
  const shared = f.store.create(f.shared, { projectId: "wellness", title: "Dinner", body: "Dinner at 19:00.", lifecycle: "active" });
  await assert.rejects(remember(f, { supersedes: [shared.memoryId] }, f.inChat("oliaChat")), /another memory/);
  await remember(f, {}, f.inChat("oliaChat"));
  await remember(f, {}, f.inChat("tarasChat", "wellness", TARAS));
  const { erasePersonMemory } = await import("../src/service.ts");
  await erasePersonMemory(f.host, f.service, OLIA);
  const has = (userId: string) => f.store.personalBytes(f.shared, userId) > 0;
  assert.equal(has(OLIA), false);
  assert.equal(has(TARAS), true);
  assert.equal(f.store.get(f.shared, shared.memoryId!)?.title, "Dinner");
});
