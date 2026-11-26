// What a running app stores: mirrored at once, sent as one request per burst,
// one request at a time, and a failure reported instead of swallowed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStorageWriter } from "../widgets/client.ts";

const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };

test("a burst of changes travels as one request and the mirror follows at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: unknown[] = [];
  const writer = createStorageWriter("app-1", { a: "1", old: "x" }, () => assert.fail("no error expected"), async (body) => { sent.push(body); });
  writer.push({ op: "set", key: "b", value: "2" });
  writer.push({ op: "set", key: "b", value: "3" });
  writer.push({ op: "remove", key: "old" });
  writer.push({ op: "set", key: "gone", value: "soon" });
  writer.push({ op: "remove", key: "gone" });
  assert.deepEqual(writer.values(), { a: "1", b: "3" }, "the page's next load starts from this, sent or not");
  assert.deepEqual(sent, []);
  t.mock.timers.tick(400);
  await settle();
  assert.deepEqual(sent, [{ id: "app-1", remove: ["old", "gone"], set: { b: "3" } }]);

  writer.push({ op: "set", key: "c", value: "4" });
  writer.push({ op: "clear" });
  writer.push({ op: "set", key: "d", value: "5" });
  assert.deepEqual(writer.values(), { d: "5" });
  t.mock.timers.tick(400);
  await settle();
  assert.deepEqual(sent[1], { id: "app-1", clear: true, set: { d: "5" } });
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(sent.length, 2, "nothing pending, nothing sent");
});

test("requests go out one at a time, in order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order: string[] = [];
  let release: (() => void) | null = null;
  const writer = createStorageWriter("app-1", {}, () => {}, (body) => {
    const key = Object.keys((body as { set: Record<string, string> }).set)[0]!;
    order.push(`start ${key}`);
    return new Promise<void>((done) => { release = () => { order.push(`end ${key}`); done(); }; });
  });
  writer.push({ op: "set", key: "first", value: "1" });
  t.mock.timers.tick(400);
  await settle();
  writer.push({ op: "set", key: "second", value: "2" });
  t.mock.timers.tick(400);
  await settle();
  assert.deepEqual(order, ["start first"]);
  release!();
  await settle();
  assert.deepEqual(order, ["start first", "end first", "start second"]);
  release!();
});

test("leaving flushes what is pending with a request that outlives the page", async () => {
  const sent: Array<{ body: unknown; keepalive: boolean }> = [];
  const writer = createStorageWriter("app-1", {}, () => {}, async (body, keepalive) => { sent.push({ body, keepalive }); });
  writer.push({ op: "set", key: "a", value: "1" });
  writer.flush();
  await settle();
  assert.deepEqual(sent, [{ body: { id: "app-1", set: { a: "1" } }, keepalive: true }]);
  // Too large to outlive the page: still sent, as an ordinary request.
  writer.push({ op: "set", key: "big", value: "x".repeat(60 * 1024) });
  writer.dispose();
  await settle();
  assert.equal(sent[1]!.keepalive, false);
  writer.push({ op: "set", key: "late", value: "1" });
  writer.flush();
  await settle();
  assert.equal(sent.length, 2, "a disposed writer takes nothing more");
});

test("a refused write is reported and the mirror keeps the value for this window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  let fail = true;
  const sent: unknown[] = [];
  const writer = createStorageWriter("app-1", {}, (cause) => { errors.push(cause); }, async (body) => {
    if (fail) throw Object.assign(new Error("full"), { status: 413 });
    sent.push(body);
  });
  writer.push({ op: "set", key: "a", value: "1" });
  t.mock.timers.tick(400);
  await settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(writer.values(), { a: "1" });
  fail = false;
  writer.push({ op: "set", key: "b", value: "2" });
  t.mock.timers.tick(400);
  await settle();
  assert.deepEqual(sent, [{ id: "app-1", set: { b: "2" } }], "a later write still goes out");
});

test("drain sends what is pending and resolves once the server has answered", async () => {
  const order: string[] = [];
  let release: (() => void) | null = null;
  const writer = createStorageWriter("app-1", {}, () => {}, () => {
    order.push("sent");
    return new Promise<void>((done) => { release = () => { order.push("answered"); done(); }; });
  });
  writer.push({ op: "set", key: "a", value: "1" });
  const drained = writer.drain().then(() => { order.push("drained"); });
  await settle();
  assert.deepEqual(order, ["sent"], "no waiting for the burst timer");
  release!();
  await drained;
  assert.deepEqual(order, ["sent", "answered", "drained"]);
  await writer.drain();
  assert.deepEqual(order, ["sent", "answered", "drained"], "nothing pending: nothing sent");
  writer.dispose();
});
