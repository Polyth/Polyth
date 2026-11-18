// Hot paths reuse compiled statements: repeated calls must not compile again,
// and shaped (variable-length) SQL stays inside a bounded cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

const proj = (id: string): SessionProjection => ({
  id, projectId: "p", title: id, status: "idle", createdAt: 1, updatedAt: 1,
});

/** Count compilations while `run` executes. */
async function compiles(run: () => Promise<void>): Promise<string[]> {
  const proto = DatabaseSync.prototype as unknown as { prepare: (sql: string) => unknown };
  const original = proto.prepare;
  const seen: string[] = [];
  proto.prepare = function (this: unknown, sql: string) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try { await run(); } finally { proto.prepare = original; }
  return seen;
}

const TYPES = ["user/message", "assistant/message", "turn/started", "turn/stopped"];

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-stmt-reuse-"));
  const store = createStore(join(dir, "s.db"));
  await store.upsertProjection(proj("a"));
  await store.upsertProjection(proj("b"));
  for (let i = 0; i < 12; i++) {
    await store.append("a", TYPES[i % TYPES.length]!, { text: `a${i}` });
  }
  await store.append("b", "question/asked", { requestId: "q1" });
  return { dir, store };
}

test("repeating hot calls compiles a constant number of statements", async () => {
  const { dir, store } = await seeded();
  try {
    const round = async () => {
      await store.eventsOfTypes!("a", TYPES, 0, 100);
      await store.eventsOfTypes!("a", TYPES, 3, 100, 2);
      await store.attentionFor(["a", "b"]);
      await store.append("a", "assistant/chunk", { text: "x" });
    };
    await round(); // warm
    const first = await compiles(async () => { for (let i = 0; i < 5; i++) await round(); });
    assert.equal(first.length, 0, `unexpected compilations: ${first.join(" | ")}`);
    const txControl = await compiles(async () => { for (let i = 0; i < 20; i++) await store.append("a", "assistant/chunk", { text: "y" }); });
    assert.ok(!txControl.some((s) => /^(BEGIN|COMMIT|ROLLBACK)/.test(s)), "transaction control statements recompiled");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("many distinct type-list lengths stay within the cache bound and return correct rows", async () => {
  const { dir, store } = await seeded();
  try {
    const all = (await store.events("a", 0, { direction: "forward", limit: 500 })) as Array<{ seq: number; type: string }>;
    const names = Array.from({ length: 64 }, (_, i) => `x/${i}`);
    const run = async () => {
      for (let n = 1; n <= 64; n++) {
        const list = [...TYPES, ...names].slice(0, Math.max(n, 1));
        const got = await store.eventsOfTypes!("a", list, 0, 100);
        const want = all.filter((e) => list.includes(e.type)).map((e) => e.seq);
        assert.deepEqual(got.map((e) => e.seq), want);
      }
    };
    await run();
    // Cycling through 64 shapes twice more than fits keeps results right
    // (eviction happens and re-prepare is transparent).
    await run();
    const hot = await compiles(async () => { for (let i = 0; i < 10; i++) await store.eventsOfTypes!("a", TYPES, 0, 100); });
    assert.equal(hot.length, 0);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shaped cache is bounded: 200 distinct attention list sizes compile at most once each", async () => {
  const { dir, store } = await seeded();
  try {
    const ids = Array.from({ length: 200 }, (_, i) => `none-${i}`);
    ids[0] = "a";
    const seen = await compiles(async () => {
      for (let n = 1; n <= 200; n++) await store.attentionFor(ids.slice(0, n));
    });
    assert.ok(seen.length <= 400, `compiled ${seen.length}`);
    // The oldest shapes were evicted: size 1 recompiles, the newest does not.
    const again = await compiles(async () => { await store.attentionFor(ids.slice(0, 200)); });
    assert.equal(again.length, 0);
    const evicted = await compiles(async () => { await store.attentionFor(ids.slice(0, 1)); });
    assert.ok(evicted.length > 0, "cache grew past its bound");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results unchanged and a failed transaction rolls back", async () => {
  const { dir, store } = await seeded();
  try {
    const rows = await store.eventsOfTypes!("a", ["user/message", "turn/stopped"], 0, 100);
    assert.deepEqual(rows.map((e) => e.seq), [1, 4, 5, 8, 9, 12]);
    assert.deepEqual(rows.map((e) => e.type), ["user/message", "turn/stopped", "user/message", "turn/stopped", "user/message", "turn/stopped"]);
    assert.equal((await store.attentionFor(["b"]))["b"]!.questions, 1);

    const before = await store.latestSeq("a");
    // An expectedSeq mismatch throws inside the transaction; nothing persists
    // and the next append still works on the same cached BEGIN/ROLLBACK.
    await assert.rejects(store.appendBatch!("a", [{ type: "assistant/chunk", data: { text: "z" } }], { expectedSeq: before + 5 }));
    assert.equal(await store.latestSeq("a"), before);
    await store.append("a", "assistant/chunk", { text: "ok" });
    assert.equal(await store.latestSeq("a"), before + 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closed store refuses cached statements", async () => {
  const { dir, store } = await seeded();
  await store.close();
  try {
    await assert.rejects(async () => { await store.eventsOfTypes!("a", TYPES, 0, 100); }, /closed/);
    await assert.rejects(async () => { await store.append("a", "assistant/chunk", {}); }, /closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
