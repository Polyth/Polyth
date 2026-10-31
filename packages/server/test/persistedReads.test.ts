import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectService } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";
import { createSessionJobs } from "../src/sessionJobs.ts";

test("history/snapshot/list read persisted data with a down harness and do not dispatch a queue", async () => {
  const store = createStore(":memory:");
  let attaches = 0;
  const sessions = createSessionService({ store, queue: store,
    projects: { get: async () => ({ id: "p", path: "/tmp", name: "p", createdAt: 1 }), list: async () => [] } as unknown as ProjectService,
    permissions: { evaluate: () => "ask" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    runtimes: { async forProject() { attaches++; throw new Error("harness down"); } },
  });
  try {
    await store.upsertProjection({ id: "s", projectId: "p", title: "Persisted", backendSessionId: "native", status: "unknown", createdAt: 1, updatedAt: 1, lastTurnAt: 1 });
    await store.append("s", "user/message", { text: "persisted" });
    await store.enqueue("s", "queued", "queue");
    const history = await sessions.events("s", 0, { limit: 400, prefetch: false });
    assert.equal(history.length, 1);
    assert.equal((await sessions.snapshot("s")).title, "Persisted");
    assert.equal((await sessions.list("p")).length, 1);
    assert.equal(attaches, 0);
    assert.equal((await store.queueList("s")).length, 1);
    assert.equal((await sessions.replayPage!("s", 0)).cursor, 1);
    assert.equal(attaches, 0);
  } finally { sessions.dispose(); await store.close(); }
});

test("lifecycle jobs have bounded concurrency, single-flight and teardown", async () => {
  let active = 0;
  let max = 0;
  const releases: Array<() => void> = [];
  const jobs = createSessionJobs(async (_id, signal) => {
    active++; max = Math.max(max, active);
    await new Promise<void>((resolve) => { releases.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
    active--;
  }, 2, 3);
  const one = jobs.enqueue("one");
  assert.equal(jobs.enqueue("one"), one);
  const all = Promise.allSettled([one, jobs.enqueue("two"), jobs.enqueue("three")]);
  await assert.rejects(jobs.enqueue("four"), /unavailable/);
  await Promise.resolve();
  assert.equal(max, 2);
  jobs.dispose();
  await all;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(jobs.size(), 0);
  assert.equal(active, 0);
});

test("completed lifecycle jobs release their cancellation scope over repeated batches", async () => {
  let completedAborts = 0;
  let previous: AbortSignal | undefined;
  let reused = 0;
  const jobs = createSessionJobs(async (_id, signal) => {
    if (signal === previous) reused++;
    previous = signal;
    signal.addEventListener("abort", () => { completedAborts++; }, { once: true });
  });
  for (let batch = 0; batch < 100; batch++) {
    for (let job = 0; job < 16; job++) await jobs.enqueue(`${batch}-${job}`);
    assert.equal(jobs.size(), 0, "post-batch job occupancy must return to zero");
  }
  jobs.dispose();
  assert.equal(completedAborts, 0, "owner teardown must not retain or cancel completed jobs");
  assert.equal(reused, 0, "a completed job's abort listeners cannot accumulate on the owner");
});
