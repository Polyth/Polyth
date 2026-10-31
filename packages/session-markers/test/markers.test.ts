import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allDefinitions,
  applyMarkerChange,
  defineMarker,
  emptyMarkerDocument,
  markerSlug,
  MARKERS_PER_SESSION_MAX,
  parseMarkerDocument,
  removeMarkerDefinition,
  resolveMarker,
  updateMarker,
} from "../src/markers.ts";

const person = { kind: "person", userId: "alice" } as const;

test("marker references forgive case, spaces and punctuation in every script", () => {
  assert.equal(markerSlug("Needs review"), "needs-review");
  assert.equal(markerSlug("  NEEDS_review!! "), "needs-review");
  assert.equal(markerSlug("Чекаю клієнта"), "чекаю-клієнта");
  assert.equal(markerSlug("!!!"), "");
  const definitions = allDefinitions(emptyMarkerDocument());
  assert.equal(resolveMarker(definitions, "needs review")?.id, "needs-review");
  assert.equal(resolveMarker(definitions, "Reply later")?.id, "reply-later");
  assert.equal(resolveMarker(definitions, "important")?.id, "important");
  assert.equal(resolveMarker(definitions, "unknown"), undefined);
});

test("a custom marker is created once and keeps its id when renamed", () => {
  const first = defineMarker(emptyMarkerDocument(), { label: "Waiting for client", color: "green", icon: "clock" });
  assert.equal(first.created, true);
  assert.deepEqual(first.marker, { id: "waiting-for-client", label: "Waiting for client", color: "green", icon: "clock", builtIn: false });
  const again = defineMarker(first.document, { label: "waiting  for CLIENT" });
  assert.equal(again.created, false);
  assert.equal(again.document.definitions.length, 1);
  assert.equal(defineMarker(first.document, { label: "Needs review" }).marker.builtIn, true, "a built-in name is never duplicated");
  assert.throws(() => defineMarker(emptyMarkerDocument(), { label: "x", color: "pink" }), { code: "invalid-input" });

  const renamed = updateMarker(first.document, "waiting-for-client", { label: "Client", color: "red" });
  assert.deepEqual(renamed.definitions[0], { id: "waiting-for-client", label: "Client", color: "red", icon: "clock", builtIn: false });
  assert.throws(() => updateMarker(first.document, "waiting-for-client", { label: "Important" }), { code: "conflict" });
  assert.throws(() => updateMarker(first.document, "important", { label: "Very" }), { code: "invalid-input" });
});

test("changes add, keep, re-note, remove and clear markers per chat", () => {
  let { document } = applyMarkerChange(emptyMarkerDocument(), {
    sessionIds: ["a", "b"],
    add: [{ marker: "needs review", note: "auth change" }, { marker: "important" }],
  }, person, 100);
  assert.deepEqual(document.sessions.a, [
    { id: "needs-review", at: 100, by: person, note: "auth change" },
    { id: "important", at: 100, by: person },
  ]);
  // Re-adding keeps the original time and author; a given note replaces the old one.
  ({ document } = applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: "needs-review", note: "" }] }, { kind: "agent", sessionId: "x" }, 200));
  assert.deepEqual(document.sessions.a?.[0], { id: "needs-review", at: 100, by: person });
  ({ document } = applyMarkerChange(document, { sessionIds: ["a"], remove: ["Important"] }, person, 300));
  assert.deepEqual(document.sessions.a?.map((marker) => marker.id), ["needs-review"]);
  ({ document } = applyMarkerChange(document, { sessionIds: ["a", "b"], clear: true }, person, 400));
  assert.deepEqual(document.sessions, {});
  assert.throws(() => applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: "nope" }] }, person, 1), { code: "not-found" });
  const created = applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: "Blocked" }], create: true }, person, 1);
  assert.deepEqual(created.created.map((marker) => marker.id), ["blocked"]);
  assert.deepEqual(created.document.sessions.a?.map((marker) => marker.id), ["blocked"]);
});

test("a chat holds a bounded number of markers", () => {
  let document = emptyMarkerDocument();
  for (let index = 0; index < MARKERS_PER_SESSION_MAX; index += 1) {
    document = applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: `m${index}` }], create: true }, person, 1).document;
  }
  assert.throws(() => applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: "one more" }], create: true }, person, 1), { code: "invalid-input" });
});

test("deleting a custom marker takes it off every chat", () => {
  let document = applyMarkerChange(emptyMarkerDocument(), { sessionIds: ["a", "b"], add: [{ marker: "Blocked" }], create: true }, person, 1).document;
  document = applyMarkerChange(document, { sessionIds: ["a"], add: [{ marker: "important" }] }, person, 1).document;
  document = removeMarkerDefinition(document, "blocked");
  assert.deepEqual(document.definitions, []);
  assert.deepEqual(Object.keys(document.sessions), ["a"]);
  assert.throws(() => removeMarkerDefinition(document, "needs-review"), { code: "invalid-input" });
});

test("stored documents are read leniently and unknown versions are refused", () => {
  const parsed = parseMarkerDocument({
    version: 1,
    revision: 4,
    definitions: [{ id: "blocked", label: "Blocked", color: "pink", icon: "nope" }, { id: "needs-review", label: "Hijack" }, "junk"],
    sessions: {
      a: [{ id: "blocked", at: 5, by: { kind: "agent", sessionId: "x" } }, { id: "gone", at: 1 }, { id: "blocked", at: 6 }],
      b: "junk",
    },
  });
  assert.equal(parsed.revision, 4);
  assert.deepEqual(parsed.definitions.map((marker) => marker.id), ["blocked"]);
  assert.equal(parsed.definitions[0]?.icon, "tag");
  assert.deepEqual(parsed.sessions, { a: [{ id: "blocked", at: 5, by: { kind: "agent", sessionId: "x" } }] });
  assert.throws(() => parseMarkerDocument({ version: 2 }), { code: "storage-unavailable" });
});
