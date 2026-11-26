// The list filters' shared rule and their "found in messages" lookup.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionSearchResult } from "@polyth/session/web-api";
import { searchTerms } from "@polyth/session/search-text";
import { messageOnlyHits, metadataHitProjectIds, projectMatchesSearch, sessionMatchesSearch } from "../src/chatSearchHits.ts";

const result = (sessionId: string, projectId: string, fields: Array<"title" | "branch" | "label" | "message">): SessionSearchResult => ({
  sessionId, projectId, title: sessionId, status: "idle", updatedAt: 1, messageHits: fields.filter((f) => f === "message").length,
  matches: fields.map((field) => ({ field, snippet: field })),
});

test("the list filter folds Cyrillic case and matches words across title, branch and worktree", () => {
  const session = { title: "Пошук у чатах", branch: "fix/search", worktreePath: "/w/polyth" };
  assert.ok(sessionMatchesSearch(session, searchTerms("ПОШУК search")));
  assert.ok(sessionMatchesSearch(session, searchTerms("polyth пошуку")));
  assert.ok(!sessionMatchesSearch(session, searchTerms("пошук deploy")));
  assert.ok(projectMatchesSearch({ name: "Сайт", path: "/repos/site" }, searchTerms("сайт repos")));
});

test("only chats found through messages alone count for the messages row", () => {
  const hits = [
    result("title", "p1", ["title", "message"]),
    result("branch", "p1", ["branch"]),
    result("message", "p2", ["message"]),
    result("label", "p2", ["label"]),
  ];
  assert.deepEqual(messageOnlyHits(hits).map((r) => r.sessionId), ["message"]);
  assert.deepEqual([...metadataHitProjectIds(hits)].sort(), ["p1"]);
});
