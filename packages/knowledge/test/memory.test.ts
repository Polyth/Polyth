import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMemoryStore, type MemoryScope } from "../src/memory.ts";

const scope: MemoryScope = { spaceId: "space-a", projectId: "project-a", principalId: "user-a" };

test("review activates candidates and archive removes them from recall with CAS", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const created = store.create(scope, { projectId: scope.projectId, title: "SQLite", body: "Use WAL for durable storage.", lifecycle: "candidate" });
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "SQLite" }).status, "empty");
  const reviewed = store.review(scope, created.memoryId!, 1, "active");
  assert.equal(store.get(scope, created.memoryId!)?.lifecycle, "active");
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "SQLite" }).status, "selected");
  assert.throws(() => store.review(scope, created.memoryId!, 1, "archived"), /changed since/);
  store.review(scope, created.memoryId!, reviewed.revision!, "archived");
  assert.equal(store.get(scope, created.memoryId!)?.lifecycle, "archived");
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "SQLite" }).status, "empty");
  assert.throws(() => store.update(scope, { id: created.memoryId!, projectId: scope.projectId, expectedRevision: 3, patch: { lifecycle: "forgotten" } }), /use forget/);
  store.forget(scope, { id: created.memoryId!, projectId: scope.projectId, expectedRevision: 3 });
  assert.throws(() => store.review(scope, created.memoryId!, 4, "active"), /explicit restoration/);
  db.close();
});

test("natural-language recall ranks matching terms and excludes other projects and inactive records", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const wanted = store.create(scope, { projectId: scope.projectId, title: "Database decision", body: "Use SQLite WAL for durable memory.", lifecycle: "active" });
  store.create(scope, { projectId: scope.projectId, title: "Other", body: "Render the menu.", lifecycle: "active" });
  store.create(scope, { projectId: scope.projectId, title: "Candidate", body: "SQLite WAL", lifecycle: "candidate" });
  const foreign = { ...scope, projectId: "project-b" };
  store.create(foreign, { projectId: foreign.projectId, title: "Foreign", body: "SQLite WAL", lifecycle: "active" });
  const recalled = store.recall(scope, { projectId: scope.projectId, intent: "Please fix the SQLite WAL connection after a restart" });
  assert.deepEqual(recalled.selected.map((item) => item.memoryId), [wanted.memoryId]);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "unrelated zebra" }).status, "empty");
  db.close();
});

test("agent search matches any term like recall, honours exclusions, other projects and mode off", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  let policy = store.getPolicy(scope);
  policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const wanted = store.create(scope, { projectId: scope.projectId, title: "Database decision", body: "Use SQLite WAL for durable memory.", lifecycle: "active" });
  store.create(scope, { projectId: scope.projectId, title: "Excluded", body: "SQLite from an excluded session.", lifecycle: "active", sources: [{ kind: "session", sessionId: "s-excluded" }] });
  store.create(scope, { projectId: scope.projectId, title: "Candidate", body: "SQLite WAL", lifecycle: "candidate" });
  const foreign = { ...scope, projectId: "project-b" };
  store.create(foreign, { projectId: foreign.projectId, title: "Foreign", body: "SQLite WAL", lifecycle: "active" });
  policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { exclusions: { sessions: ["s-excluded"], sources: [], paths: [] } } });
  // The management list keeps its whole-phrase filter; search does not.
  assert.equal(store.list(scope, { q: "SQLite connection restart" }).total, 0);
  const found = store.search(scope, { q: "SQLite connection restart" });
  assert.deepEqual(found.items.map((item) => item.id), [wanted.memoryId]);
  assert.equal(found.total, 1);
  assert.equal(store.search(scope, { q: "the and of" }).total, 0);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "off" } });
  assert.equal(store.search(scope, { q: "SQLite" }).total, 0);
  db.close();
});

test("new policies default to automatic activation while existing manual preferences persist", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  assert.equal(policy.reviewPolicy, "low-risk-auto-active");
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { reviewPolicy: "manual", mode: "auto" } });
  assert.equal(createMemoryStore(db, scope.spaceId).getPolicy(scope).reviewPolicy, "manual");
  db.close();
});

test("memory store enforces scoped CAS, bounded recall, locks, and durable leases", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId, () => 100);
  let policy = store.getPolicy(scope);
  policy = store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: { mode: "auto", contextBudget: { maxRecords: 1, maxBytes: 200 } },
  });
  const created = store.create(scope, {
    projectId: scope.projectId,
    title: "Database decision",
    body: "Use SQLite with WAL for durable memory.",
    category: "decision",
    lifecycle: "active",
    evidence: "user-stated",
  });
  assert.equal(created.status, "committed");
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "SQLite WAL" }).status, "selected");
  assert.throws(() => store.update(scope, {
    id: created.memoryId!, projectId: scope.projectId, expectedRevision: 0, patch: { body: "stale" },
  }), /changed since/);
  const updated = store.update(scope, {
    id: created.memoryId!, projectId: scope.projectId, expectedRevision: 1, patch: { body: "Updated body" },
  });
  assert.equal(updated.revision, 2);
  assert.throws(() => store.update(scope, {
    id: created.memoryId!, projectId: scope.projectId, expectedRevision: 2, patch: { body: "agent overwrite" },
  }, "agent"), /locked/);
  const job = store.enqueueHarvest(scope, {
    jobKey: "session-a:1-2", spaceId: scope.spaceId, projectId: scope.projectId, sessionId: "session-a",
    sourceStartSeq: 1, sourceEndSeq: 2, sourceDigest: "digest", policyGeneration: policy.generation, extractorVersion: "v1",
  });
  const leased = store.claimHarvest(scope, "worker-a", 10, 100);
  assert.equal(leased?.jobKey, job.jobKey);
  assert.equal(store.completeHarvest(scope, job.jobKey, "worker-a", "receipt-a", "checkpoint-a"), true);
  assert.equal(store.completeHarvest(scope, job.jobKey, "worker-a", "receipt-a", "checkpoint-a"), false);
  db.close();
});

test("off and clear rotate generation and stale harvest jobs", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const original = store.getPolicy(scope);
  const job = store.enqueueHarvest(scope, {
    jobKey: "session-b:1-1", spaceId: scope.spaceId, projectId: scope.projectId, sessionId: "session-b",
    sourceStartSeq: 1, sourceEndSeq: 1, sourceDigest: "digest", policyGeneration: original.generation, extractorVersion: "v1",
  });
  assert.equal(job.status, "pending");
  const cleared = store.clear(scope, original.generation);
  assert.equal(cleared.status, "committed");
  assert.notEqual(cleared.generation, original.generation);
  assert.equal(store.claimHarvest(scope, "worker-b"), undefined);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "anything" }).status, "blocked");
  db.close();
});

test("legacy memory rows migrate into the scoped store and imports stay bounded", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, title TEXT, body TEXT, tags TEXT, source TEXT, source_session_id TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER)");
  db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("legacy-1", "project-a", "memory", "Legacy", "Keep WAL enabled", "[\"sqlite\"]", "user", "session-old", 1, 1, 1);
  const store = createMemoryStore(db, scope.spaceId, () => 100);
  assert.equal(store.get(scope, "legacy-1")?.evidence, "user-stated");
  const exported = store.exportProject(scope, { includeCandidates: true });
  assert.equal(exported.records.length, 1);
  assert.equal(store.importPreview(scope, exported).duplicates, 1);
  assert.throws(() => store.importRecords(scope, { ...exported, records: Array.from({ length: 1001 }, () => exported.records[0]!) }), /invalid memory import/);
  db.close();
});

test("recall keeps the complete model-visible envelope within the UTF-8 budget", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: { mode: "auto", contextBudget: { maxRecords: 1, maxBytes: 256 } },
  });
  store.create(scope, {
    projectId: scope.projectId,
    title: "Secrets rule",
    body: `Never send secrets. ${"é".repeat(200)}.`,
    lifecycle: "active",
    evidence: "user-stated",
  });
  const contribution = store.recall(scope, { projectId: scope.projectId, intent: "secrets" });
  assert.ok(contribution.modelVisibleText);
  assert.ok(contribution.modelVisibleText!.includes("Never send secrets."));
  assert.ok(contribution.estimate.bytes <= 256);
  assert.equal(Buffer.byteLength(contribution.modelVisibleText!, "utf8"), contribution.estimate.bytes);
  db.close();
});

test("utility harvesting becomes ready only from explicit consent and an exact allowlist", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  let policy = store.getPolicy(scope);
  policy = store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: {
      utilityModel: { providerID: "local", modelID: "small" },
      utilityAllowlist: [{ providerID: "local", modelID: "small" }],
      utilityBudget: { maxCalls: 3 },
      utilityModelAllowed: true,
      consentRequired: false,
    },
  });
  assert.equal(policy.utilityStatus, "ready");
  assert.throws(() => store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: { utilityModel: { providerID: "other", modelID: "paid" }, utilityStatus: "ready" },
  }), /explicit consent/);
  db.close();
});

const autoStore = () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId);
  const enable = (target: MemoryScope) => {
    const policy = store.getPolicy(target);
    return store.updatePolicy(target, { projectId: target.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  };
  enable(scope);
  const add = (target: MemoryScope, title: string, body: string, extra: Partial<Parameters<typeof store.create>[1]> = {}) =>
    store.create(target, { projectId: target.projectId, title, body, lifecycle: "active", ...extra }).memoryId!;
  return { db, store, enable, add };
};

test("search and recall find inflected words by their stem, in English and Ukrainian", () => {
  const { db, store, add } = autoStore();
  const english = add(scope, "Cat symptom", "Vomiting after a food change.");
  const ukrainian = add(scope, "Діагноз", "У кота хронічний гастрит, дієта без лактози.");
  add(scope, "Unrelated", "Render the menu.");
  assert.deepEqual(store.search(scope, { q: "symptoms" }).items.map((item) => item.id), [english]);
  assert.deepEqual(store.search(scope, { q: "гастриту" }).items.map((item) => item.id), [ukrainian]);
  assert.deepEqual(store.recall(scope, { projectId: scope.projectId, intent: "які симптоми гастриту?" }).selected.map((item) => item.memoryId), [ukrainian]);
  // Short words and numbers stay exact: "cat" must not find "category".
  add(scope, "Category list", "Categories of menus.");
  assert.deepEqual(store.search(scope, { q: "cat" }).items.map((item) => item.id), [english]);
  db.close();
});

test("a title match outranks a passing mention in another record's body", () => {
  const { db, store, add } = autoStore();
  // Unweighted bm25 ranks the two repeated body mentions first.
  const mention = add(scope, "Deploy", "The gateway is down; restart the gateway and read the logs of the service.");
  const titled = add(scope, "Gateway notes for the home lab and its other services", "Port 8080 and the proxy settings live in the router config.");
  for (const [title, body] of [["Menu", "Render the menu."], ["Fonts", "Bundle the fonts."], ["Tests", "Run the tests."], ["Docs", "Write the docs."]]) add(scope, title!, body!);
  assert.deepEqual(store.search(scope, { q: "gateway" }).items.map((item) => item.id), [titled, mention]);
  db.close();
});

test("agent search adds substring matches that recall never injects", () => {
  const { db, store, add } = autoStore();
  const record = add(scope, "MemPalace retired", "All drawers were migrated into Polyth memory.");
  assert.deepEqual(store.search(scope, { q: "palace" }).items.map((item) => item.id), [record]);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "palace" }).status, "empty");
  db.close();
});

test("cross-project search ranks the listed projects together and respects each project's policy", () => {
  const { db, store, enable, add } = autoStore();
  const other = { ...scope, projectId: "project-b" };
  const off = { ...scope, projectId: "project-off" };
  const never = { ...scope, projectId: "project-never" };
  enable(other);
  const own = add(scope, "Router address", "The router is at 192.168.1.1.");
  const shared = add(other, "Router admin", "Router admin over ssh as root.");
  const hidden = add(other, "Router excluded", "Router note from an excluded session.", { sources: [{ kind: "session", sessionId: "s-hidden" }] });
  add(other, "Router candidate", "Router candidate note.", { lifecycle: "candidate" });
  enable(off);
  add(off, "Router off", "Router note in a project whose memory is off.");
  const offPolicy = store.getPolicy(off);
  store.updatePolicy(off, { projectId: off.projectId, expectedSettingsRevision: offPolicy.settingsRevision, patch: { mode: "off" } });
  // A project that never enabled memory has no policy row; reading it creates none.
  db.prepare("INSERT INTO memory_records(id,space_id,project_id,title,body,category,tags,aliases,applicability,sources,lifecycle,evidence,freshness,pinned,user_locked,revision,created_at,updated_at) VALUES('raw','space-a','project-never','Router raw','Router raw','observation','[]','[]','{}','[]','active','inferred','unknown',0,0,1,1,1)").run();
  const otherPolicy = store.getPolicy(other);
  store.updatePolicy(other, { projectId: other.projectId, expectedSettingsRevision: otherPolicy.settingsRevision, patch: { exclusions: { sessions: ["s-hidden"], sources: [], paths: [] } } });
  const result = store.searchProjects(scope, { q: "router", projectIds: [scope.projectId, other.projectId, off.projectId, never.projectId] });
  assert.deepEqual(new Set(result.items.map((item) => item.id)), new Set([own, shared]));
  assert.deepEqual(result.searchedProjectIds, [scope.projectId, other.projectId]);
  assert.ok(!result.items.some((item) => item.id === hidden));
  assert.equal(db.prepare("SELECT count(*) AS count FROM memory_policy WHERE project_id='project-never'").get()!.count, 0);
  // Only the listed projects, and never another Space's.
  assert.deepEqual(store.searchProjects(scope, { q: "router", projectIds: [other.projectId] }).items.map((item) => item.id), [shared]);
  assert.throws(() => store.searchProjects({ ...scope, spaceId: "space-b" }, { q: "router", projectIds: [other.projectId] }), /Space scope/);
  db.close();
});

test("cross-project recall policy defaults to ask and accepts only off, ask or allow", () => {
  const { db, store } = autoStore();
  let policy = store.getPolicy(scope);
  assert.equal(policy.crossProjectRecall, "ask");
  policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { crossProjectRecall: "allow" } });
  assert.equal(policy.crossProjectRecall, "allow");
  assert.throws(() => store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { crossProjectRecall: "always" as never } }), /cross-project recall is invalid/);
  db.close();
});

test("an existing store gets its substring index filled once", () => {
  const db = new DatabaseSync(":memory:");
  const first = createMemoryStore(db, scope.spaceId);
  const policy = first.getPolicy(scope);
  first.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const id = first.create(scope, { projectId: scope.projectId, title: "MemPalace retired", body: "Moved.", lifecycle: "active" }).memoryId!;
  db.exec("DELETE FROM memory_fts_tri");
  const reopened = createMemoryStore(db, scope.spaceId);
  assert.deepEqual(reopened.search(scope, { q: "palace" }).items.map((item) => item.id), [id]);
  // A writer that knows nothing about the index (an older server) keeps it current.
  db.prepare("UPDATE memory_records SET title='Notebook retired', body='Moved to Polyth.' WHERE id=?").run(id);
  assert.equal(reopened.search(scope, { q: "palace" }).total, 0);
  assert.equal(Number((db.prepare("SELECT count(*) AS count FROM memory_fts_tri WHERE text LIKE '%Notebook%'").get() as { count: number }).count), 1);
  db.close();
});
