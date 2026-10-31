import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  highlightRanges,
  matchesSessionSearchFacets,
  parseSessionSearchQuery,
  segmentHighlights,
  toggleSessionSearchFacet,
} from "../src/sessionSearchQuery.ts";

const session = (
  status: SessionProjection["status"],
  attention?: SessionProjection["attention"],
): SessionProjection => ({
  id: `session-${status}`,
  projectId: "project-1",
  title: status,
  status,
  createdAt: 1,
  updatedAt: 1,
  ...(attention ? { attention } : {}),
});

test("session search parses waiting and running tokens without sending them remotely", () => {
  assert.deepEqual(parseSessionSearchQuery("  crash  is:waiting  logs IS:RUNNING "), {
    text: "crash logs",
    waiting: true,
    running: true,
    archived: false,
  });
  assert.deepEqual(parseSessionSearchQuery("is:waiting"), {
    text: "",
    waiting: true,
    running: false,
    archived: false,
  });
});

test("session search parses archived and author facets; unknown facets stay text", () => {
  assert.deepEqual(parseSessionSearchQuery("deploy is:archived from:me"), {
    text: "deploy",
    waiting: false,
    running: false,
    archived: true,
    role: "user",
  });
  assert.equal(parseSessionSearchQuery("x from:agent").role, "assistant");
  assert.equal(parseSessionSearchQuery("x FROM:Assistant").role, "assistant");
  assert.equal(parseSessionSearchQuery("x from:nobody").text, "x from:nobody");
  assert.equal(parseSessionSearchQuery("x is:tomorrow").text, "x is:tomorrow");
  // `is:` inside a word is ordinary text (e.g. a URL fragment).
  assert.equal(parseSessionSearchQuery("this:waiting").text, "this:waiting");
});

test("facet toggling preserves free text and keeps from: exclusive", () => {
  assert.equal(toggleSessionSearchFacet("", "is:waiting"), "is:waiting");
  assert.equal(toggleSessionSearchFacet("crash logs", "is:waiting"), "crash logs is:waiting");
  assert.equal(toggleSessionSearchFacet("crash is:waiting logs", "is:waiting"), "crash logs");
  assert.equal(toggleSessionSearchFacet("crash IS:WAITING", "is:waiting"), "crash");
  assert.equal(toggleSessionSearchFacet("crash from:me", "from:agent"), "crash from:agent");
  assert.equal(toggleSessionSearchFacet("crash from:me", "from:me"), "crash");
});

test("session search facets use projection status and durable attention", () => {
  assert.equal(matchesSessionSearchFacets(session("working"), { running: true, waiting: false }), true);
  assert.equal(matchesSessionSearchFacets(session("idle"), { running: true, waiting: false }), false);
  assert.equal(matchesSessionSearchFacets(session("waiting"), { running: false, waiting: true }), true);
  assert.equal(matchesSessionSearchFacets(session("idle", {
    questions: 1,
    permissions: 0,
    unread: 0,
  }), { running: false, waiting: true }), true);
  assert.equal(matchesSessionSearchFacets(session("idle"), { running: false, waiting: true }), false);
});

test("archived chats stay searchable by default and is:archived narrows to them", () => {
  const base = { running: false, waiting: false };
  assert.equal(matchesSessionSearchFacets(session("archived"), { ...base, archived: false }), true);
  assert.equal(matchesSessionSearchFacets(session("idle"), { ...base, archived: false }), true);
  assert.equal(matchesSessionSearchFacets(session("archived"), { ...base, archived: true }), true);
  assert.equal(matchesSessionSearchFacets(session("idle"), { ...base, archived: true }), false);
});

test("highlight ranges fold case and diacritics, merge overlaps and segment text", () => {
  assert.deepEqual(highlightRanges("Fix Café login", ["cafe", "LOG"]), [[4, 8], [9, 12]]);
  assert.deepEqual(highlightRanges("abcabc", ["abc", "bca"]), [[0, 6]]);
  assert.deepEqual(highlightRanges("nothing", ["zzz"]), []);
  assert.deepEqual(highlightRanges("", ["a"]), []);
  assert.deepEqual(segmentHighlights("Fix Café login", [[4, 8]]), [
    { text: "Fix ", hit: false },
    { text: "Café", hit: true },
    { text: " login", hit: false },
  ]);
  // Out-of-bounds or overlapping ranges never duplicate or drop characters.
  const segs = segmentHighlights("abc", [[1, 10], [0, 2]]);
  assert.equal(segs.map((s) => s.text).join(""), "abc");
});
