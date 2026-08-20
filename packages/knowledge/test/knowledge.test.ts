// WP10: project knowledge — CRUD, revisions, limits, Unicode search, snippets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore, knowledgeDigest } from "../src/index.ts";

const fresh = () => createKnowledgeStore(join(mkdtempSync(join(tmpdir(), "polyth-know-")), "k.db"));

test("create/get/list round-trip; list carries snippets, never full bodies", async () => {
  const store = fresh();
  const item = await store.create({
    projectId: "p1", kind: "note", title: "Deploy runbook",
    body: "Step 1: build.\nStep 2: verify.\n" + "x".repeat(500),
    tags: ["ops", "deploy", "ops"], // duplicate folds silently
  });
  assert.equal(item.revision, 1);
  assert.deepEqual(item.tags, ["ops", "deploy"]);

  const got = await store.get(item.id);
  assert.equal(got!.body.length, item.body.length);

  const { items, total } = await store.list({ projectId: "p1" });
  assert.equal(total, 1);
  assert.ok(!("body" in items[0]!), "list DTO has no body field");
  assert.ok(items[0]!.snippet.length <= 200);
  assert.equal(items[0]!.bodyBytes, Buffer.byteLength(item.body));
  store.close();
});

test("update bumps revision; stale revision conflicts; delete is idempotent", async () => {
  const store = fresh();
  const a = await store.create({ projectId: "p", kind: "plan", title: "Plan A", body: "v1" });
  const up = await store.update(a.id, { body: "v2" }, 1);
  assert.equal(up.revision, 2);
  assert.equal(up.body, "v2");
  await assert.rejects(
    () => store.update(a.id, { body: "v3" }, 1),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
  assert.equal(await store.remove(a.id), true);
  assert.equal(await store.remove(a.id), false);
  store.close();
});

test("limits: title length, body bytes, tag count", async () => {
  const store = fresh();
  await assert.rejects(() => store.create({ projectId: "p", kind: "note", title: "x".repeat(201), body: "" }), /title exceeds/);
  await assert.rejects(() => store.create({ projectId: "p", kind: "note", title: "t", body: "x".repeat(256 * 1024 + 1) }), /256 KiB/);
  await assert.rejects(
    () => store.create({ projectId: "p", kind: "note", title: "t", body: "", tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }),
    /at most 32/,
  );
  store.close();
});

test("search: Unicode/diacritic folding across title, body, and tags", async () => {
  const store = fresh();
  await store.create({ projectId: "p", kind: "note", title: "Résumé template", body: "plain body" });
  await store.create({ projectId: "p", kind: "note", title: "other", body: "Der schöne Ölberg" });
  await store.create({ projectId: "p", kind: "plan", title: "third", body: "x", tags: ["Kyïv"] });
  await store.create({ projectId: "other-project", kind: "note", title: "resume", body: "" });

  const byTitle = await store.list({ projectId: "p", q: "resume" });
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.items[0]!.title, "Résumé template");

  const byBody = await store.list({ projectId: "p", q: "SCHONE" });
  assert.equal(byBody.total, 1);
  assert.ok(byBody.items[0]!.snippet.includes("schöne"), "snippet centers on the hit");

  const byTag = await store.list({ projectId: "p", q: "kyiv" });
  assert.equal(byTag.total, 1);
  assert.equal(byTag.items[0]!.kind, "plan");
  store.close();
});

test("kind filter and pagination", async () => {
  const store = fresh();
  for (let i = 0; i < 7; i++) {
    await store.create({ projectId: "p", kind: i % 2 ? "plan" : "note", title: `t${i}`, body: "" });
  }
  const notes = await store.list({ projectId: "p", kind: "note" });
  assert.equal(notes.total, 4);
  const page = await store.list({ projectId: "p", limit: 3, offset: 3 });
  assert.equal(page.total, 7);
  assert.equal(page.items.length, 3);
  store.close();
});

test("digest is stable and content-derived (attach event contract)", () => {
  assert.equal(knowledgeDigest("hello"), knowledgeDigest("hello"));
  assert.notEqual(knowledgeDigest("hello"), knowledgeDigest("hello!"));
  assert.equal(knowledgeDigest("hello").length, 16);
});
