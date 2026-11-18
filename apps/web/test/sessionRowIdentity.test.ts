// A live projection frame is the most frequent store write there is: one per
// change of any running chat, plus whole batches on every reconnect. Lists
// render from `state.sessions`, so a row the server repeats unchanged must
// keep its object (lists skip it) and a frame that changes nothing must not
// publish at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, location: dom.location });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.fetch = async () => { throw new Error("projection frames must not fetch"); };
register("./tsxHooks.mjs", import.meta.url);

const store = await import("../src/store.ts");
const { handleProjectionBatch } = await import("../src/init.ts");

const row = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "p", title: `chat ${id}`, status: "idle", createdAt: 1, updatedAt: 1, summary: true,
  attention: { questions: 0, permissions: 0, unread: 0 }, labelIds: ["a", "b"], ...extra,
} as SessionProjection);
const fresh = (rows: readonly SessionProjection[]): SessionProjection[] => structuredClone(rows) as SessionProjection[];
const byId = (id: string) => store.getState().sessions.find((session) => session.id === id)!;

test("a batch that repeats what is already shown publishes nothing and keeps every row", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`same-${i}`));
  handleProjectionBatch(rows);
  const before = store.getState().sessions;
  const first = byId("same-0");
  let publications = 0;
  const off = store.subscribeStore(() => { publications++; });
  try {
    // A reconnect re-sends the page as new objects with the same content.
    handleProjectionBatch(fresh(rows));
    store.upsertSessions(fresh(rows));
    store.upsertSession(fresh([rows[3]!])[0]!);
    assert.equal(publications, 0, "nothing changed, so no subscriber runs");
    assert.equal(store.getState().sessions, before, "the list itself is the same array");
    assert.equal(byId("same-0"), first);
  } finally { off(); }
});

test("one changed row in a batch publishes once and only that row is a new object", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`mixed-${i}`));
  handleProjectionBatch(rows);
  const kept = byId("mixed-1");
  const stale = byId("mixed-7");
  let publications = 0;
  const off = store.subscribeStore(() => { publications++; });
  try {
    const next = fresh(rows);
    next[7] = { ...next[7]!, status: "working", updatedAt: 2 };
    handleProjectionBatch(next);
    assert.equal(publications, 1);
    assert.equal(byId("mixed-1"), kept, "an unchanged row keeps its identity");
    assert.notEqual(byId("mixed-7"), stale);
    assert.equal(byId("mixed-7").status, "working");
  } finally { off(); }
});

test("every kind of difference still reaches the list", () => {
  handleProjectionBatch([row("diff")]);
  const cases: Array<[string, Partial<SessionProjection>]> = [
    ["a nested count", { attention: { questions: 0, permissions: 1, unread: 0 } } as Partial<SessionProjection>],
    ["a list that lost an item", { labelIds: ["a"] }],
    ["a list in another order", { labelIds: ["b", "a"] }],
    ["a field that appeared", { pinned: { position: 0 } } as Partial<SessionProjection>],
    ["a title", { title: "renamed" }],
  ];
  for (const [name, change] of cases) {
    handleProjectionBatch([row("diff")]);
    let publications = 0;
    const off = store.subscribeStore(() => { publications++; });
    try {
      handleProjectionBatch([row("diff", change)]);
      assert.equal(publications, 1, `${name} publishes`);
    } finally { off(); }
  }
  // A field the server stopped sending is a change too (a removed pin).
  handleProjectionBatch([row("diff", { pinned: { position: 0 } } as Partial<SessionProjection>)]);
  assert.ok(byId("diff").pinned);
  handleProjectionBatch([row("diff")]);
  assert.equal(byId("diff").pinned, undefined);
});

test("a row this client had not seen still publishes", () => {
  handleProjectionBatch([row("known")]);
  let publications = 0;
  const off = store.subscribeStore(() => { publications++; });
  try {
    handleProjectionBatch([row("known"), row("arrived")]);
    assert.equal(publications, 1, "a row this client had not seen");
    assert.ok(byId("arrived"));
  } finally { off(); }
});

test("a frame keeps the runtime features of listed chats and drops those of chats that left", () => {
  handleProjectionBatch([row("tracked"), row("other")]);
  store.setRuntimeFeatures("tracked", {} as never);
  store.setRuntimeFeatures("gone", {} as never);
  handleProjectionBatch([row("other", { updatedAt: 5 })]);
  const features = store.getState().runtimeFeatures;
  assert.ok(Object.hasOwn(features, "tracked"), "a listed chat keeps its features");
  assert.ok(!Object.hasOwn(features, "gone"), "a chat that is no longer listed loses them");
  // Many tracked chats take the set path; the result is the same.
  for (let i = 0; i < 30; i++) store.setRuntimeFeatures(`gone-${i}`, {} as never);
  handleProjectionBatch([row("other", { updatedAt: 6 })]);
  assert.deepEqual(Object.keys(store.getState().runtimeFeatures), ["tracked"]);
});

test.after(async () => { await dom.happyDOM.close(); });
