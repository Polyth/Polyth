import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  matchesSessionSearchFacets,
  parseSessionSearchQuery,
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
  });
  assert.deepEqual(parseSessionSearchQuery("is:waiting"), {
    text: "",
    waiting: true,
    running: false,
  });
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
  assert.equal(matchesSessionSearchFacets(session("working"), { running: true, waiting: true }), false);
});
