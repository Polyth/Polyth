import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_LIMITS, appSource, applyStorageChange, compareApps, parseAppView, parseStorageChange, sourceKey, type AppView } from "../src/apps.ts";

const view = (patch: Partial<AppView> = {}): AppView => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Budget",
  version: 1,
  hash: "a".repeat(64),
  bytes: 10,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

test("a source is a few bounded references, never free text", () => {
  assert.deepEqual(appSource({ sessionId: " s1 ", projectId: "p1", from: "a/b.html", other: "x" }), { sessionId: "s1", projectId: "p1", from: "a/b.html" });
  assert.equal(appSource({ sessionId: "x".repeat(APP_LIMITS.sourceChars + 1) }), undefined);
  assert.equal(appSource({ sessionId: "a\nb" }), undefined);
  assert.equal(appSource({ sessionId: 5 }), undefined);
  assert.equal(appSource("s1"), undefined);
  assert.equal(appSource(null), undefined);
});

test("the same project file, or the same chat and title, is the same app", () => {
  assert.equal(sourceKey({ projectId: "p", from: "a.html", sessionId: "s1" }, "One"), sourceKey({ projectId: "p", from: "a.html", sessionId: "s2" }, "Two"));
  assert.notEqual(sourceKey({ projectId: "p", from: "a.html" }, "One"), sourceKey({ projectId: "q", from: "a.html" }, "One"));
  assert.equal(sourceKey({ sessionId: "s1" }, "Budget"), sourceKey({ sessionId: "s1" }, "BUDGET"));
  assert.notEqual(sourceKey({ sessionId: "s1" }, "Budget"), sourceKey({ sessionId: "s2" }, "Budget"));
  assert.equal(sourceKey({ from: "a.html" }, "One"), null, "a file needs its project");
  assert.equal(sourceKey({ projectId: "p" }, "One"), null);
  assert.equal(sourceKey(undefined, "One"), null);
});

test("a record read from disk is checked field by field", () => {
  assert.deepEqual(parseAppView(view({ source: { sessionId: "s1" } })), view({ source: { sessionId: "s1" } }));
  for (const bad of [
    null, [], "x",
    { ...view(), id: "../x" },
    { ...view(), title: "" },
    { ...view(), version: 0 },
    { ...view(), version: 1.5 },
    { ...view(), hash: "zz" },
    { ...view(), bytes: -1 },
    { ...view(), updatedAt: "now" },
  ]) assert.equal(parseAppView(bad), null);
  assert.deepEqual(parseAppView({ ...view(), source: "junk", extra: 1 }), view());
});

test("apps list newest first, then by name", () => {
  const sorted = [view({ id: "a", title: "B", updatedAt: 1 }), view({ id: "b", title: "A", updatedAt: 1 }), view({ id: "c", title: "Z", updatedAt: 5 })].sort(compareApps);
  assert.deepEqual(sorted.map((app) => app.title), ["Z", "A", "B"]);
});

test("a storage change applies clear, then removals, then values, within the limits", () => {
  const next = applyStorageChange({ a: "1", b: "2" }, parseStorageChange({ remove: ["a"], set: { c: "3" } }));
  assert.deepEqual({ ...next }, { b: "2", c: "3" });
  assert.deepEqual({ ...applyStorageChange({ a: "1" }, parseStorageChange({ clear: true, set: { z: "9" } })) }, { z: "9" });
  assert.deepEqual({ ...applyStorageChange({ a: "1" }, parseStorageChange({})) }, { a: "1" });
  // A key named like a prototype member is only a key.
  const proto = applyStorageChange({}, parseStorageChange(JSON.parse('{"set":{"__proto__":"x","constructor":"y"}}')));
  assert.deepEqual(Object.keys(proto).sort(), ["__proto__", "constructor"]);
  assert.equal(({} as Record<string, unknown>).x, undefined);

  const many = Object.fromEntries(Array.from({ length: APP_LIMITS.storageKeys }, (_, index) => [`k${index}`, "v"]));
  assert.equal(Object.keys(applyStorageChange({}, parseStorageChange({ set: many }))).length, APP_LIMITS.storageKeys);
  assert.throws(() => applyStorageChange(many, parseStorageChange({ set: { more: "v" } })), { code: "too-large" });
  assert.throws(() => parseStorageChange({ set: { ...many, more: "v" } }), { code: "too-large" });
  assert.throws(() => parseStorageChange({ set: { a: 5 } }), { code: "invalid-input" });
  assert.throws(() => parseStorageChange({ set: ["a"] }), { code: "invalid-input" });
  assert.throws(() => parseStorageChange({ remove: [5] }), { code: "invalid-input" });
  assert.throws(() => parseStorageChange("clear"), { code: "invalid-input" });
});
