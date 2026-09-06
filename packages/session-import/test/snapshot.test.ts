import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceRecord, SessionSourceProvider } from "@polyth/contracts";
import { createStore, deriveMessages, planRuntimeEpochRecovery } from "@polyth/session";
import { importSnapshot } from "../src/index.ts";
import { sourceRefs } from "../src/refs.ts";
const project = { id: "p", name: "p", path: "/tmp", spaceId: "a", createdAt: 0 };
const context = { spaceId: "a", projectId: "p", cwd: "/tmp" };
const base = { project, context, providerId: "fake", ref: "native", requestId: "request-1234567890", title: "Imported" };
const source = (records: SourceRecord[]): SessionSourceProvider => ({ list: async () => [], async *read() { yield* records; } });
test("Snapshot streams 20,000 records in bounded atomic batches and remains usable with its source gone", async () => {
    const store = createStore(":memory:");
    let reads = 0;
    let maxBatch = 0;
    const original = store.appendBatch!.bind(store);
    store.appendBatch = async (id, items, opts) => { maxBatch = Math.max(maxBatch, items.length); return original(id, items, opts); };
    const external: SessionSourceProvider = { list: async () => [], async *read() { reads++; for (let i = 0; i < 20000; i++)
            yield { role: i % 2 ? "assistant" : "user", text: `message ${i}`, time: 1000 + i }; } };
    const first = await importSnapshot({ ...base, store, source: external });
    const same = await importSnapshot({ ...base, store, source: { list: async () => [], async *read() { throw new Error("source gone"); } } });
    assert.equal(first.id, same.id);
    assert.equal(reads, 1);
    assert.ok(maxBatch <= 200);
    assert.equal((await store.projections()).length, 1);
    const events = await store.events(first.id);
    assert.equal(events[1]?.time, 1000);
    assert.equal(deriveMessages(events).length, 20000);
    const plan = planRuntimeEpochRecovery({ events, operations: [], includeWorkflow: true });
    assert.ok(plan);
    assert.ok(plan.recoveryContext.length <= 16000);
    assert.match(plan.recoveryContext, /message 19999/);
    await store.close();
});
test("malformed, oversized, whitespace-only and interrupted reads never publish a session", async () => {
    for (const records of [[{ role: "reasoning", text: "hidden" }], [{ role: "user", text: "x".repeat(1024 * 1024 + 1) }], [{ role: "user", text: " \n " }]]) {
        const store = createStore(":memory:");
        await assert.rejects(importSnapshot({ ...base, store, source: source(records as SourceRecord[]) }));
        assert.equal((await store.projections()).length, 0);
        await store.close();
    }
    const store = createStore(":memory:");
    await assert.rejects(importSnapshot({ ...base, store, source: { list: async () => [], async *read() { for (let i = 0; i < 201; i++)
                yield { role: "user", text: "valid" }; throw new Error("gone"); } } }));
    await assert.rejects(importSnapshot({ ...base, store, source: source([{ role: "user", text: "changed source" }]) }), { code: "conflict" });
    assert.equal((await store.projections()).length, 0);
    await store.close();
});
test("completed staging publishes after disk restart without reading the source; CAS rolls back all events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapshot-"));
    let store = createStore(join(dir, "events.db"));
    const original = store.appendBatch!.bind(store);
    store.appendBatch = async (id, items, opts) => { if (opts?.projection)
        throw new Error("simulated crash before publication"); return original(id, items, opts); };
    await assert.rejects(importSnapshot({ ...base, store, source: source([{ role: "user", text: "confirmed" }]) }));
    await store.close();
    store = createStore(join(dir, "events.db"));
    const result = await importSnapshot({ ...base, store, source: { list: async () => [], async *read() { throw new Error("source gone"); } } });
    const count = await store.latestSeq(result.id);
    await assert.rejects(store.appendBatch!(result.id, [{ type: "user/message", data: { text: "must roll back" } }], { expectedSeq: count - 1 }), { code: "conflict" });
    assert.equal(await store.latestSeq(result.id), count);
    assert.equal((await store.projections()).length, 1);
    await store.close();
    await rm(dir, { recursive: true, force: true });
});
test("Space validation rejects known valid other-Space ids; opaque refs survive restart and reject tampering", async () => {
    const store = createStore(":memory:");
    const external = source([{ role: "user", text: "password=hunter2\nknown-secret", time: 42 }]);
    await assert.rejects(importSnapshot({ ...base, store, source: external, context: { ...context, spaceId: "other" } }), { code: "not-found" });
    const projection = await importSnapshot({ ...base, store, source: external, redact: (s) => s.replaceAll("known-secret", "[redacted]") });
    const log = JSON.stringify(await store.events(projection.id));
    assert.doesNotMatch(log, /hunter2|known-secret/);
    const dir = await mkdtemp(join(tmpdir(), "refs-"));
    const first = await sourceRefs(join(dir, "key"));
    const value = { spaceId: "a", projectId: "p", providerId: "fake", nativeRef: "private-native-ref", title: "t", expires: Date.now() + 10000 };
    const ref = first.encode(value);
    assert.doesNotMatch(ref, /private-native-ref/);
    const reopened = await sourceRefs(join(dir, "key"));
    assert.deepEqual(reopened.decode(ref, "a", "p"), value);
    assert.throws(() => reopened.decode(ref, "other", "p"), { code: "not-found" });
    assert.throws(() => reopened.decode(ref.slice(0, -8) + "aaaaaaaa", "a", "p"), { code: "not-found" });
    await store.close();
    await rm(dir, { recursive: true, force: true });
});
