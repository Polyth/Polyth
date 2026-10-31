import test from "node:test";
import assert from "node:assert/strict";
import type { BtwRequest } from "../src/shared.ts";
import { createBtwStore, threadBefore, type BtwEntry } from "../widgets/store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const calls: Array<{ sessionId: string; request: BtwRequest; signal: AbortSignal; reply: ReturnType<typeof deferred<{ answer: string }>> }> = [];
  const store = createBtwStore({
    ask: (sessionId, request, signal) => {
      const reply = deferred<{ answer: string }>();
      calls.push({ sessionId, request, signal, reply });
      return reply.promise;
    },
    describeError: (error) => (error as Error).message,
  });
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  return { store, calls, notified: () => notified };
}

test("follow-ups run in order and carry the answered thread before them", async () => {
  const h = harness();
  h.store.ask("s1", "  which file?  ");
  h.store.ask("s1", "and why?");
  await settle();
  assert.equal(h.calls.length, 1, "the follow-up waits for the first answer");
  assert.deepEqual(h.calls[0]!.request, { question: "which file?", thread: [] });
  assert.deepEqual(h.store.get("s1")!.entries.map((entry) => entry.status), ["pending", "pending"]);
  h.calls[0]!.reply.resolve({ answer: "src/login.ts" });
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1]!.request, { question: "and why?", thread: [{ question: "which file?", answer: "src/login.ts" }] });
  h.calls[1]!.reply.resolve({ answer: "Because." });
  await settle();
  assert.deepEqual(h.store.get("s1")!.entries.map((entry) => [entry.status, entry.answer]), [["answered", "src/login.ts"], ["answered", "Because."]]);
});

test("threads are per chat, and blank questions are ignored", async () => {
  const h = harness();
  h.store.ask("s1", "   ");
  assert.equal(h.store.get("s1"), undefined);
  h.store.ask("s1", "one");
  h.store.ask("s2", "two");
  await settle();
  assert.deepEqual(h.calls.map((call) => call.sessionId), ["s1", "s2"], "different chats do not wait on each other");
  assert.equal(h.store.get("s2")!.entries[0]!.question, "two");
});

test("a failure is shown in place and retried with the same thread", async () => {
  const h = harness();
  h.store.ask("s1", "q");
  await settle();
  h.calls[0]!.reply.reject(new Error("The model did not answer in time"));
  await settle();
  const failed = h.store.get("s1")!.entries[0]!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The model did not answer in time");
  h.store.retry("s1", failed.id);
  assert.equal(h.store.get("s1")!.entries[0]!.status, "pending");
  await settle();
  assert.equal(h.calls.length, 2);
  h.calls[1]!.reply.resolve({ answer: "ok" });
  await settle();
  assert.equal(h.store.get("s1")!.entries[0]!.answer, "ok");
  h.store.retry("s1", failed.id);
  assert.equal(h.calls.length, 2, "an answered entry is not retried");
});

test("closing forgets the thread and drops a late answer", async () => {
  const h = harness();
  h.store.ask("s1", "q");
  await settle();
  const signal = h.calls[0]!.signal;
  h.store.close("s1");
  assert.equal(signal.aborted, true);
  assert.equal(h.store.get("s1"), undefined);
  h.calls[0]!.reply.resolve({ answer: "late" });
  await settle();
  assert.equal(h.store.get("s1"), undefined, "the late answer does not resurrect the card");
  h.store.ask("s1", "fresh");
  await settle();
  assert.equal(h.store.get("s1")!.entries.length, 1, "a new thread starts clean");
});

test("dispose aborts every thread and stops notifying", async () => {
  const h = harness();
  h.store.ask("s1", "a");
  h.store.ask("s2", "b");
  await settle();
  const before = h.notified();
  h.store.dispose();
  assert.ok(h.calls.every((call) => call.signal.aborted));
  assert.equal(h.store.get("s1"), undefined);
  assert.equal(h.notified(), before + 1);
  h.store.ask("s3", "c");
  assert.equal(h.notified(), before + 1, "listeners are gone");
});

test("the thread sent along keeps the newest answered entries only", () => {
  const entries: BtwEntry[] = Array.from({ length: 9 }, (_, index) => ({
    id: `e${index}`, question: `q${index}`, status: index === 3 ? "failed" : "answered", answer: `a${index}`,
  }));
  const thread = threadBefore(entries, "e8");
  assert.deepEqual(thread.map((entry) => entry.question), ["q1", "q2", "q4", "q5", "q6", "q7"]);
});
