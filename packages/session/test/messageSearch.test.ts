// FTS5 message search: ranked, prefix and diacritic tolerant, scoped by Space
// and project through the projection join, blind to hidden internal prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionProjection } from "@polyth/contracts";
import { createStore, decodeSnippet, toFtsMatchQuery } from "../src/index.ts";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "polyth-fts-")), "s.db");
const proj = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1",
  spaceId: "space-a",
  title: over.id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("toFtsMatchQuery quotes every term as a prefix (or its stem) and neutralises operator syntax", () => {
  assert.equal(toFtsMatchQuery("search workspace"), '("search"* OR "searc"*) AND ("workspace"* OR "worksp"*)');
  assert.equal(toFtsMatchQuery('  "exact phrase"  tail '), '"exact phrase" AND "tail"*');
  assert.equal(toFtsMatchQuery('a"b OR NEAR(x) col:y -z'), '"ab"* AND "or"* AND "near(x)"* AND "col:y"* AND "-z"*');
  assert.equal(toFtsMatchQuery("Пошуків"), '("пошуків"* OR "пошук"*)');
  assert.equal(toFtsMatchQuery("   "), "");
});

test("decodeSnippet turns marker characters into ranges and bounds long excerpts", () => {
  const short = decodeSnippet("fix the \u0001needle\u0002 now");
  assert.deepEqual(short, { snippet: "fix the needle now", ranges: [[8, 14]] });
  const long = decodeSnippet(`${"x".repeat(300)} the \u0001needle\u0002 sits here ${"y".repeat(300)}`);
  assert.ok(long.snippet.length <= 162, `snippet too long: ${long.snippet.length}`);
  assert.ok(long.snippet.startsWith("…") && long.snippet.endsWith("…"));
  assert.equal(long.ranges.length, 1);
  const [a, b] = long.ranges[0]!;
  assert.equal(long.snippet.slice(a, b), "needle");
});

test("searchMessages ranks prefix matches, folds diacritics, reports seq/role/time", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "s1" }));
  await store.upsertProjection(proj({ id: "s2" }));
  const first = await store.append("s1", "user/message", { text: "Please fix the Café login bug" });
  await store.append("s1", "assistant/message", { text: "Looking at the login flow now" });
  await store.append("s2", "assistant/message", { text: "Unrelated deployment notes" });

  const hits = await store.searchMessages({ q: "cafe log", spaceId: "space-a" });
  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  assert.equal(hit.sessionId, "s1");
  assert.equal(hit.seq, first.seq);
  assert.equal(hit.role, "user");
  assert.equal(hit.time, first.time);
  assert.deepEqual(hit.ranges.map(([a, b]) => hit.snippet.slice(a, b)), ["Café", "login"]);

  const byRole = await store.searchMessages({ q: "login", spaceId: "space-a", role: "assistant" });
  assert.deepEqual(byRole.map((h) => [h.sessionId, h.role]), [["s1", "assistant"]]);
  await store.close();
});

test("searchMessages is scoped by Space and project through the projection join", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "mine", spaceId: "space-a", projectId: "p1" }));
  await store.upsertProjection(proj({ id: "other-project", spaceId: "space-a", projectId: "p2" }));
  await store.upsertProjection(proj({ id: "foreign", spaceId: "space-b", projectId: "p1" }));
  for (const id of ["mine", "other-project", "foreign"]) {
    await store.append(id, "user/message", { text: `shared keyword in ${id}` });
  }
  const space = await store.searchMessages({ q: "shared", spaceId: "space-a" });
  assert.deepEqual(space.map((h) => h.sessionId).sort(), ["mine", "other-project"]);
  const project = await store.searchMessages({ q: "shared", spaceId: "space-a", projectId: "p1" });
  assert.deepEqual(project.map((h) => h.sessionId), ["mine"]);
  // A valid foreign Space id never leaks its sessions.
  const foreign = await store.searchMessages({ q: "shared", spaceId: "space-b", projectId: "p1" });
  assert.deepEqual(foreign.map((h) => h.sessionId), ["foreign"]);
  await store.close();
});

test("hidden internal prompts and non-message events are never indexed", async () => {
  const store = createStore(freshPath());
  await store.append("s1", "user/message", { text: "visible secretword" });
  await store.append("s1", "user/message", { text: "hidden secretword", hiddenUserMessage: true });
  await store.append("s1", "user/message", { text: "resume secretword", autoResume: true });
  await store.append("s1", "user/message", { text: "conflict secretword", githubConflictResolution: true });
  await store.append("s1", "tool/result", { text: "tool secretword" });
  await store.append("s1", "assistant/message", { partId: "x", text: "" });
  const hits = await store.searchMessages({ q: "secretword" });
  assert.deepEqual(hits.map((h) => h.snippet), ["visible secretword"]);
  await store.close();
});

test("person messages are searchable but never prompts", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "s1" }));
  const posted = await store.append("s1", "person/message", {
    text: "the hidden treasure map",
    author: { userId: "usr_bea", name: "Bea" },
    mentions: [],
  });
  const hits = await store.searchMessages({ q: "treasure", spaceId: "space-a" });
  assert.deepEqual(hits.map((h) => [h.sessionId, h.seq]), [["s1", posted.seq]]);
  // Search can find it, but composer recall only ever pages `user/message`.
  assert.deepEqual(
    (await store.listPromptHistory({ spaceId: "space-a", limit: 20 })).map((entry) => entry.text),
    [],
  );
  assert.deepEqual(
    (await store.listSessionPrompts({ spaceId: "space-a", sessionId: "s1", limit: 20 })).prompts,
    [],
  );
  await store.close();
});

test("an empty or operator-only query returns nothing instead of failing", async () => {
  const store = createStore(freshPath());
  await store.append("s1", "user/message", { text: "anything" });
  assert.deepEqual(await store.searchMessages({ q: "   " }), []);
  assert.deepEqual(await store.searchMessages({ q: '"' }), []);
  assert.deepEqual(await store.searchMessages({ q: "*" }), []);
  assert.deepEqual(await store.searchMessages({ q: "(" }), []);
  await store.close();
});

test("the v20 migration backfills existing logs and later appends stay indexed", async () => {
  const path = freshPath();
  // Seed a pre-migration database: schema without the FTS mirror.
  const seed = createStore(path);
  await seed.append("old", "user/message", { text: "ancient treasure map" });
  await seed.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER trg_events_fts_insert; DROP TRIGGER trg_events_fts_delete; DROP TABLE events_fts");
  raw.exec("UPDATE schema_meta SET value = '19' WHERE key = 'version'");
  raw.close();

  const store = createStore(path);
  const backfilled = await store.searchMessages({ q: "treasure" });
  assert.deepEqual(backfilled.map((h) => h.sessionId), ["old"]);
  await store.append("new", "assistant/message", { text: "fresh treasure" });
  const after = await store.searchMessages({ q: "treasure" });
  assert.deepEqual(after.map((h) => h.sessionId).sort(), ["new", "old"]);
  await store.close();
});

test("searchMessages finds Ukrainian inflections through the stem", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "uk" }));
  await store.append("uk", "user/message", { text: "Зроби один пошук для всіх чатів" });
  const hits = await store.searchMessages({ q: "пошуків чат", spaceId: "space-a" });
  assert.deepEqual(hits.map((h) => h.sessionId), ["uk"]);
  await store.close();
});

test("broaden finds chats whose messages hold the words between them, after one-message hits", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "together" }));
  await store.upsertProjection(proj({ id: "spread" }));
  await store.upsertProjection(proj({ id: "half" }));
  await store.upsertProjection(proj({ id: "foreign", spaceId: "space-b" }));
  await store.append("together", "user/message", { text: "deploy then rollback" });
  await store.append("spread", "user/message", { text: "time to deploy" });
  await store.append("spread", "assistant/message", { text: "rollback is ready" });
  await store.append("half", "user/message", { text: "deploy only" });
  await store.append("foreign", "user/message", { text: "deploy" });
  await store.append("foreign", "assistant/message", { text: "rollback" });

  const strict = await store.searchMessages({ q: "deploy rollback", spaceId: "space-a" });
  assert.deepEqual(strict.map((h) => h.sessionId), ["together"]);
  const broad = await store.searchMessages({ q: "deploy rollback", spaceId: "space-a", broaden: { sessions: 10, scanMessages: 0 } });
  assert.equal(broad[0]!.sessionId, "together");
  assert.equal(broad[0]!.via, undefined);
  assert.deepEqual([...new Set(broad.slice(1).map((h) => h.sessionId))], ["spread"]);
  assert.ok(broad.slice(1).every((h) => h.via === "chat"));
  await store.close();
});

test("broaden finds a word inside a longer word among the newest messages", async () => {
  const store = createStore(freshPath());
  await store.upsertProjection(proj({ id: "code" }));
  await store.upsertProjection(proj({ id: "other", projectId: "p2" }));
  await store.append("code", "assistant/message", { text: "Updated SessionSearch.tsx and the OAuth flow" });
  await store.append("other", "assistant/message", { text: "PaletteSearch lives elsewhere" });

  assert.deepEqual(await store.searchMessages({ q: "search", spaceId: "space-a", projectId: "p1" }), []);
  const hits = await store.searchMessages({ q: "search auth", spaceId: "space-a", projectId: "p1", broaden: { sessions: 10, scanMessages: 100 } });
  assert.deepEqual(hits.map((h) => [h.sessionId, h.via]), [["code", "substring"]]);
  const hit = hits[0]!;
  assert.deepEqual(hit.ranges.map(([a, b]) => hit.snippet.slice(a, b)), ["Search", "Auth"]);
  // The scan window is bounded: nothing older than it is read.
  const outside = await store.searchMessages({ q: "search", spaceId: "space-a", projectId: "p1", broaden: { sessions: 10, scanMessages: 1 } });
  assert.deepEqual(outside, []);
  await store.close();
});
