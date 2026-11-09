import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMemoryStore, type MemoryCreateInput, type MemoryLayerGrant, type MemoryScope } from "../src/memory.ts";

const scope: MemoryScope = { spaceId: "space-a", projectId: "project-a", principalId: "user-a" };
const all: MemoryLayerGrant[] = [{ layer: "project" }, { layer: "space" }, { layer: "agent", agentId: "agent-1" }, { layer: "person", userId: "user-a" }];
const granted = (layers: MemoryLayerGrant[], base: MemoryScope = scope): MemoryScope => ({ ...base, layers });

/** `spaceId: null` opens a store that is not bound to one Space. */
function autoStore(db = new DatabaseSync(":memory:"), spaceId: string | null = scope.spaceId) {
  const store = createMemoryStore(db, spaceId ?? undefined, () => 1_000);
  for (const target of [scope, { ...scope, projectId: "project-b" }]) {
    store.updatePolicy(target, { projectId: target.projectId, expectedSettingsRevision: store.getPolicy(target).settingsRevision, patch: { mode: "auto" } });
  }
  return { db, store };
}

const record = (title: string, body = "Keep SQLite in WAL mode."): MemoryCreateInput =>
  ({ projectId: scope.projectId, title, body, lifecycle: "active" });

test("a store from before layers upgrades in place: old rows are project records with no author", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE memory_records (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    category TEXT NOT NULL, tags TEXT NOT NULL, aliases TEXT NOT NULL, applicability TEXT NOT NULL, sources TEXT NOT NULL,
    lifecycle TEXT NOT NULL, evidence TEXT NOT NULL, freshness TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    user_locked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "old-1", "space-a", "project-a", "Old rule", "Keep SQLite in WAL mode.", "convention", "[]", "[]", "{}", "[]", "active", "user-stated", "current", 1, 1, 1, 1, 1,
  );
  const first = createMemoryStore(db, scope.spaceId);
  const columns = (db.prepare("PRAGMA table_info(memory_records)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const name of ["layer", "owner_id", "authored_by", "approved_by"]) assert.ok(columns.includes(name), name);
  const item = first.get(scope, "old-1");
  assert.equal(item?.layer, "project");
  assert.equal(item?.ownerId, undefined);
  assert.equal(item?.authoredBy, undefined);
  assert.equal(item?.approvedBy, undefined);
  assert.equal(first.list(scope).total, 1);
  // Reopening runs the migration again without changing anything.
  const second = createMemoryStore(db, scope.spaceId);
  assert.deepEqual(second.get(scope, "old-1"), item);
  db.close();
});

test("without grants every read sees exactly the project layer, as before layers", () => {
  const { db, store } = autoStore();
  const project = store.create(scope, record("Project rule"));
  for (const placement of all.slice(1)) store.create(granted(all), record(`${placement.layer} rule`), { placement });
  const intent = "SQLite WAL";
  assert.deepEqual(store.list(scope).items.map((item) => item.id), [project.memoryId]);
  assert.deepEqual(store.search(scope, { q: intent }).items.map((item) => item.id), [project.memoryId]);
  assert.deepEqual(store.recall(scope, { projectId: scope.projectId, intent }).selected.map((item) => item.memoryId), [project.memoryId]);
  const hidden = store.list(granted(all)).items.find((item) => item.layer === "person")!;
  assert.equal(store.get(scope, hidden.id), undefined);
  assert.throws(() => store.update(scope, { id: hidden.id, projectId: scope.projectId, expectedRevision: 1, patch: { body: "x" } }), /not found/);
  assert.throws(() => store.forget(scope, { id: hidden.id, projectId: scope.projectId, expectedRevision: 1 }), /not found/);
  assert.throws(() => store.review(scope, hidden.id, 1, "archived"), /not found/);
  db.close();
});

test("grants select layers; agent and person records stay with their owner, Space records span projects", () => {
  const { db, store } = autoStore();
  const space = store.create(granted(all), record("Space rule"), { placement: { layer: "space" } });
  const mine = store.create(granted(all), record("My rule"), { placement: { layer: "person", userId: "user-a" } });
  const agent = store.create(granted(all), record("Agent rule"), { placement: { layer: "agent", agentId: "agent-1" } });
  store.create(granted([{ layer: "person", userId: "user-b" }]), record("Their rule"), { placement: { layer: "person", userId: "user-b" } });
  store.create(granted([{ layer: "agent", agentId: "agent-2" }]), record("Other agent"), { placement: { layer: "agent", agentId: "agent-2" } });
  const otherProject = { ...scope, projectId: "project-b" };
  store.create(otherProject, { ...record("Project B rule"), projectId: "project-b" });

  const ids = (target: MemoryScope) => store.list(target).items.map((item) => item.id).sort();
  assert.deepEqual(ids(granted([{ layer: "person", userId: "user-a" }])), [mine.memoryId]);
  assert.deepEqual(ids(granted([{ layer: "agent", agentId: "agent-1" }])), [agent.memoryId]);
  // Space, agent and person records are reachable from any project of the Space.
  assert.deepEqual(ids(granted([{ layer: "space" }, { layer: "person", userId: "user-a" }], otherProject)), [space.memoryId, mine.memoryId].sort());
  // The project layer stays bound to its own project.
  assert.deepEqual(store.list(granted([{ layer: "project" }], otherProject)).items.map((item) => item.title), ["Project B rule"]);
  const recalled = store.recall(granted(all), { projectId: scope.projectId, intent: "SQLite WAL" }).selected.map((item) => item.memoryId).sort();
  assert.deepEqual(recalled, [space.memoryId, mine.memoryId, agent.memoryId].sort());
  assert.equal(store.get(granted(all), mine.memoryId!)?.ownerId, "user-a");
  assert.equal(store.get(granted(all), space.memoryId!)?.projectId, "");
  assert.deepEqual(granted([]).layers, []);
  assert.equal(store.list(granted([])).total, 0);
  db.close();
});

test("a store shared by Spaces never shows one Space's layered records to another", () => {
  const { db, store } = autoStore(new DatabaseSync(":memory:"), null);
  store.create(granted(all), record("Space A rule"), { placement: { layer: "space" } });
  store.create(granted(all), record("Space A person"), { placement: { layer: "person", userId: "user-a" } });
  const foreign: MemoryScope = { spaceId: "space-b", projectId: "project-a", principalId: "user-a", layers: all };
  store.updatePolicy(foreign, { projectId: foreign.projectId, expectedSettingsRevision: store.getPolicy(foreign).settingsRevision, patch: { mode: "auto" } });
  assert.equal(store.list(foreign).total, 0);
  assert.equal(store.recall(foreign, { projectId: foreign.projectId, intent: "SQLite WAL" }).selected.length, 0);
  db.close();
});

test("writes need a granted layer, and layer and author never come from the create input", () => {
  const { db, store } = autoStore();
  assert.throws(() => store.create(scope, record("Space"), { placement: { layer: "space" } }), /not granted/);
  assert.throws(() => store.create(granted([{ layer: "person", userId: "user-b" }]), record("Me"), { placement: { layer: "person", userId: "user-a" } }), /not granted/);
  assert.throws(() => store.list(granted([{ layer: "person", userId: " " }])), /grant owner is invalid/);
  assert.throws(() => store.list(granted([{ layer: "everyone" } as unknown as MemoryLayerGrant])), /grant is invalid/);
  assert.throws(() => store.list(granted(Array.from({ length: 9 }, (_, index) => ({ layer: "agent" as const, agentId: `a${index}` })))), /grants are invalid/);
  assert.throws(() => store.create(scope, record("Bad author"), { authoredBy: { kind: "person" } as never }), /authoredBy/);
  // A request body spread into the input cannot move a record or claim an author.
  const smuggled = { ...record("Smuggled"), layer: "person", ownerId: "user-a", authoredBy: { kind: "person", userId: "user-z" } } as MemoryCreateInput;
  const receipt = store.create(scope, smuggled);
  const stored = store.get(scope, receipt.memoryId!)!;
  assert.equal(stored.layer, "project");
  assert.equal(stored.ownerId, undefined);
  assert.equal(stored.authoredBy, undefined);
  db.close();
});

test("the same text in two layers is two records; a duplicate is per layer and owner", () => {
  const { db, store } = autoStore();
  const project = store.create(scope, record("Same"));
  const person = store.create(granted(all), record("Same"), { placement: { layer: "person", userId: "user-a" } });
  assert.equal(person.status, "committed");
  assert.notEqual(person.memoryId, project.memoryId);
  assert.equal(store.create(granted(all), record("Same"), { placement: { layer: "person", userId: "user-a" } }).status, "duplicate");
  db.close();
});

test("provenance: author on create, approver on activation, both kept through edits and restore", () => {
  const { db, store } = autoStore();
  const target = granted(all);
  const created = store.create(target, { ...record("Draft"), lifecycle: "candidate" }, {
    placement: { layer: "agent", agentId: "agent-1" }, authoredBy: { kind: "agent", sessionId: "session-1", agentId: "agent-1" },
  });
  assert.deepEqual(store.get(target, created.memoryId!)?.authoredBy, { kind: "agent", sessionId: "session-1", agentId: "agent-1" });
  store.review(target, created.memoryId!, 1, "active", { userId: "user-a" });
  const approved = store.get(target, created.memoryId!)!;
  assert.deepEqual(approved.approvedBy, { userId: "user-a", at: 1_000 });
  store.update(target, { id: approved.id, projectId: scope.projectId, expectedRevision: 2, patch: { body: "Keep SQLite in WAL mode, always." } });
  const edited = store.get(target, approved.id)!;
  assert.equal(edited.layer, "agent");
  assert.equal(edited.ownerId, "agent-1");
  assert.deepEqual(edited.authoredBy, approved.authoredBy);
  assert.deepEqual(edited.approvedBy, approved.approvedBy);
  store.restore(target, approved.id, 3, 1);
  const restored = store.get(target, approved.id)!;
  assert.equal(restored.body, "Keep SQLite in WAL mode.");
  assert.equal(restored.lifecycle, "candidate");
  assert.equal(restored.layer, "agent");
  assert.deepEqual(restored.authoredBy, approved.authoredBy);
  // Archiving is not an approval.
  const other = store.create(scope, record("Archive me"), { authoredBy: { kind: "person", userId: "user-a" } });
  store.review(scope, other.memoryId!, 1, "archived", { userId: "user-a" });
  assert.equal(store.get(scope, other.memoryId!)?.approvedBy, undefined);
  assert.deepEqual(store.get(scope, other.memoryId!)?.authoredBy, { kind: "person", userId: "user-a" });
  db.close();
});

test("harvested and imported records name the system as their author", () => {
  const { db, store } = autoStore();
  const policy = store.getPolicy(scope);
  const job = store.enqueueHarvest(scope, {
    jobKey: "session-a:1-2", spaceId: scope.spaceId, projectId: scope.projectId, sessionId: "session-a",
    sourceStartSeq: 1, sourceEndSeq: 2, sourceDigest: "digest", policyGeneration: policy.generation, extractorVersion: "v1",
  });
  store.claimHarvest(scope, "worker-a", 10_000, 1_000);
  store.commitHarvest(scope, job.jobKey, "worker-a", policy.generation, [{ title: "Harvested", body: "Keep SQLite in WAL mode.", lifecycle: "active", idempotencyKey: "k1", requestFingerprint: "f1" }], "receipt", "checkpoint", 3);
  const harvested = store.list(scope).items.find((item) => item.title === "Harvested")!;
  assert.deepEqual(harvested.authoredBy, { kind: "system", via: "harvest" });
  assert.equal(harvested.layer, "project");
  const exported = store.exportProject(scope);
  exported.records = exported.records.map((item) => ({ ...item, id: "imported-1", title: "Imported" }));
  store.importRecords(scope, exported, "merge");
  assert.deepEqual(store.get(scope, "imported-1")?.authoredBy, { kind: "system", via: "import" });
  db.close();
});

test("clear, export and import touch only the project's own layer", () => {
  const { db, store } = autoStore();
  const project = store.create(scope, record("Project rule"));
  const mine = store.create(granted(all), record("My rule"), { placement: { layer: "person", userId: "user-a" } });
  const exported = store.exportProject(scope, { includeArchived: true });
  assert.deepEqual(exported.records.map((item) => item.id), [project.memoryId]);
  // An import cannot overwrite a personal record by reusing its id.
  const hijack = { ...exported, records: [{ ...exported.records[0]!, id: mine.memoryId!, body: "Overwritten" }] };
  assert.throws(() => store.importRecords(scope, hijack, "replace"), /already in use/);
  assert.equal(store.get(granted(all), mine.memoryId!)?.body, "Keep SQLite in WAL mode.");
  store.clear(scope, store.getPolicy(scope).generation);
  assert.equal(store.get(scope, project.memoryId!)?.lifecycle, "forgotten");
  assert.equal(store.get(granted(all), mine.memoryId!)?.lifecycle, "active");
  db.close();
});

// ---- personal memory in a shared project (Spaces §14.6)

const olia = "user-olia";
const taras = "user-taras";
const here = (userId: string): MemoryLayerGrant => ({ layer: "person", userId, projectId: scope.projectId });
const aboutMe = (userId: string): MemoryLayerGrant => ({ layer: "person", userId });
const privateChat = (userId: string): MemoryScope => granted([{ layer: "project" }, here(userId), aboutMe(userId)]);

test("a person's notes reach only a scope granted to that person, and a shared chat sees neither", () => {
  const { store } = autoStore();
  store.create(privateChat(olia), record("Ferritin 9", "Ferritin 9, retest in three months."), { placement: here(olia) });
  store.create(privateChat(olia), record("Prefers short replies", "Reply briefly in Ukrainian."), { placement: aboutMe(olia) });
  store.create(scope, record("Dinner time", "The family has dinner at 19:00."));

  const shared = store.list(scope);
  assert.deepEqual(shared.items.map((item) => item.title), ["Dinner time"]);
  assert.equal(store.search(scope, { q: "ferritin" }).total, 0);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "ferritin retest" }).selected.length, 0);

  // Taras's private chat is just as blind to Olia's notes as a shared one.
  const tarasChat = privateChat(taras);
  assert.equal(store.search(tarasChat, { q: "ferritin" }).total, 0);
  const noted = store.search(privateChat(olia), { q: "ferritin" }).items[0]!;
  assert.equal(store.get(tarasChat, noted.id), undefined);
  assert.equal(store.get(scope, noted.id), undefined);
  assert.throws(() => store.update(tarasChat, { id: noted.id, projectId: scope.projectId, expectedRevision: 1, patch: { title: "x" } }), /not found/);
  assert.throws(() => store.forget(granted([{ layer: "project" }]), { id: noted.id, projectId: scope.projectId, expectedRevision: 1 }), /not found/);

  // Olia sees all three, and clearing the project leaves her notes alone.
  assert.equal(store.list(privateChat(olia)).total, 3);
  store.clear(scope, store.getPolicy(scope).generation);
  assert.equal(store.list(privateChat(olia)).items.filter((item) => item.lifecycle === "active").length, 2);
});

test("notes in one project stay out of a person's chats in another project; about-me notes follow them", () => {
  const { store } = autoStore();
  store.create(privateChat(olia), record("Only here", "A note bound to project-a."), { placement: here(olia) });
  store.create(privateChat(olia), record("Everywhere", "A note about Olia."), { placement: aboutMe(olia) });
  const other: MemoryScope = { ...scope, projectId: "project-b", layers: [{ layer: "project" }, { layer: "person", userId: olia, projectId: "project-b" }, aboutMe(olia)] };
  assert.deepEqual(store.list(other).items.map((item) => item.title), ["Everywhere"]);
});

test("recall labels a personal note and who a note is about, and the export never carries personal notes", () => {
  const { store } = autoStore();
  store.create(privateChat(olia), { ...record("Ferritin 9", "Ferritin 9, retest in three months."), about: "Оля" }, { placement: here(olia) });
  store.create(scope, { ...record("Nut allergy", "Marta has a nut allergy, ferritin unrelated."), about: "Марта <b>\n" });
  const recall = store.recall(privateChat(olia), { projectId: scope.projectId, intent: "ferritin allergy" });
  assert.match(recall.modelVisibleText ?? "", /· personal · about Оля\]/);
  assert.match(recall.modelVisibleText ?? "", /· about Марта b\]/);
  assert.equal(recall.selected.find((item) => item.layer === "person")?.about, "Оля");
  const exported = store.exportProject(privateChat(olia));
  assert.deepEqual(exported.records.map((item) => item.title), ["Nut allergy"]);
});

test("an offer works as its owner's note from the start, and only that owner can settle it", () => {
  const { store } = autoStore();
  const receipt = store.create(privateChat(olia), record("More red meat", "Olia asks for more red meat at dinner."), { placement: here(olia), shareProposed: true });
  const dinner = { projectId: scope.projectId, intent: "red meat dinner" };
  assert.equal(store.recall(privateChat(olia), dinner).selected.length, 1);
  assert.equal(store.recall(privateChat(taras), dinner).selected.length, 0);
  assert.equal(store.shareProposals(scope).length, 0);
  assert.equal(store.shareProposals(privateChat(taras)).length, 0);
  const [proposal] = store.shareProposals(privateChat(olia));
  assert.equal(proposal?.id, receipt.memoryId);
  assert.throws(() => store.settleShareProposal(privateChat(taras), proposal!.id, proposal!.revision, "published"), /not found/);
  store.settleShareProposal(privateChat(olia), proposal!.id, proposal!.revision, "kept");
  assert.equal(store.shareProposals(privateChat(olia)).length, 0);
  assert.equal(store.get(privateChat(olia), proposal!.id)?.lifecycle, "active");
  assert.equal(store.get(privateChat(olia), proposal!.id)?.shareProposedAt, undefined);
  assert.throws(() => store.create(scope, record("x"), { shareProposed: true }), /personal note/);
});

test("offers an older version left waiting become working notes when the store opens", () => {
  const db = new DatabaseSync(":memory:");
  const dinner = { projectId: scope.projectId, intent: "red meat dinner" };
  const { store } = autoStore(db);
  const { memoryId } = store.create(privateChat(olia), { ...record("More red meat", "Olia asks for more red meat at dinner."), lifecycle: "candidate" }, { placement: here(olia), shareProposed: true });
  assert.equal(store.recall(privateChat(olia), dinner).selected.length, 0);
  const { store: reopened } = autoStore(db);
  const note = reopened.get(privateChat(olia), memoryId!);
  assert.equal(note?.lifecycle, "active");
  assert.equal(note?.shareProposedAt, undefined);
  assert.equal(reopened.recall(privateChat(olia), dinner).selected.length, 1);
  assert.equal(reopened.recall(privateChat(taras), dinner).selected.length, 0);
});

test("moving an old shared note to personal takes it, with history, out of the shared memory", () => {
  const { store } = autoStore();
  const receipt = store.create(scope, { ...record("Analysis", "My ferritin is 9."), sources: [{ kind: "session", sessionId: "private-chat" }] });
  assert.equal(store.sessionSourcedRecords(scope).length, 1);
  assert.throws(() => store.moveToLayer(scope, receipt.memoryId!, 1, here(olia)), /not granted/);
  const moved = store.moveToLayer(privateChat(olia), receipt.memoryId!, 1, here(olia));
  assert.equal(moved.revision, 2);
  assert.equal(store.get(scope, receipt.memoryId!), undefined);
  assert.equal(store.search(scope, { q: "ferritin" }).total, 0);
  assert.equal(store.sessionSourcedRecords(scope).length, 0);
  assert.equal(store.get(privateChat(olia), receipt.memoryId!)?.layer, "person");
  assert.equal(store.get(privateChat(olia), receipt.memoryId!)?.ownerId, olia);
  store.restore(privateChat(olia), receipt.memoryId!, 2, 1);
  assert.equal(store.get(privateChat(olia), receipt.memoryId!)?.layer, "person", "restoring an older revision never moves it back");
});

test("a harvest lands in the granted layer and purge removes one person's notes only", () => {
  const { store } = autoStore();
  const chat = privateChat(olia);
  const generation = store.getPolicy(chat).generation;
  store.enqueueHarvest(chat, { jobKey: "job-1", spaceId: scope.spaceId, projectId: scope.projectId, sessionId: "s1", sourceStartSeq: 1, sourceEndSeq: 2, sourceDigest: "d", policyGeneration: generation, extractorVersion: "v" });
  assert.ok(store.claimHarvest(chat, "lease", 1_000, 1_000));
  const input = { title: "Sleep", body: "Olia sleeps badly.", lifecycle: "active" as const, idempotencyKey: "k1", requestFingerprint: "f1" };
  assert.throws(() => store.commitHarvest(scope, "job-1", "lease", generation, [input], "r", "c", 3, here(olia)), /not granted/);
  store.commitHarvest(chat, "job-1", "lease", generation, [input], "r", "c", 3, here(olia));
  assert.equal(store.search(scope, { q: "sleeps" }).total, 0);
  const found = store.search(chat, { q: "sleeps" }).items[0];
  assert.equal(found?.layer, "person");
  assert.equal(found?.authoredBy?.kind, "system");

  store.create(privateChat(taras), record("Taras's note", "Taras keeps this."), { placement: here(taras) });
  assert.ok(store.personalBytes(chat, olia) > 0);
  assert.equal(store.purgePerson(chat, olia), 1);
  assert.equal(store.personalBytes(chat, olia), 0);
  assert.equal(store.search(chat, { q: "sleeps" }).total, 0);
  assert.equal(store.get(chat, found!.id), undefined);
  assert.equal(store.list(privateChat(taras)).items.filter((item) => item.layer === "person").length, 1);
});
