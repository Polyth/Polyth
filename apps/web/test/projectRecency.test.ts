import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectRecencyScores, rankProjectsByRecentSessions } from "../src/projectRecency.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const projects = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }, { id: "delta" }];
let next = 0;
const chat = (projectId: string, daysAgo: number, extra: { parentId?: string; id?: string } = {}) => ({
  id: extra.id ?? `s${next++}`,
  projectId,
  createdAt: NOW - daysAgo * DAY,
  lastTurnAt: NOW - daysAgo * DAY,
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
});
const ids = (list: readonly { id: string }[]) => list.map((project) => project.id);

test("projects with more recent chats come first; the rest keep registry order", () => {
  const ranked = rankProjectsByRecentSessions(projects, [
    chat("gamma", 1), chat("gamma", 2), chat("gamma", 3),
    chat("beta", 0),
  ], NOW);
  assert.deepEqual(ids(ranked), ["gamma", "beta", "alpha", "delta"]);
});

test("older chats count less, and chats past the window not at all", () => {
  const ranked = rankProjectsByRecentSessions(projects, [
    chat("alpha", 20), chat("alpha", 21), chat("alpha", 22),
    chat("beta", 0), chat("beta", 1),
    chat("delta", 45), chat("delta", 46), chat("delta", 47), chat("delta", 48),
  ], NOW);
  assert.deepEqual(ids(ranked), ["beta", "alpha", "gamma", "delta"]);
  assert.equal(projectRecencyScores([chat("delta", 45)], NOW).has("delta"), false);
});

test("equal scores fall back to the most recent chat", () => {
  const ranked = rankProjectsByRecentSessions(projects, [
    { id: "a", projectId: "alpha", createdAt: NOW - DAY },
    { id: "b", projectId: "beta", createdAt: NOW - DAY, lastTurnAt: NOW - DAY + 1 },
  ], NOW);
  assert.equal(ranked[0]?.id, "beta");
});

test("delegated children and duplicate rows do not inflate a project", () => {
  const scores = projectRecencyScores([
    chat("alpha", 0, { id: "root" }),
    chat("alpha", 0, { id: "root" }),
    chat("alpha", 0, { parentId: "root" }),
  ], NOW);
  assert.equal(scores.get("alpha")?.score, 1);
});

test("the new-session context bar lists projects in recency order", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /useRecentlyActiveProjects\(projects, !session, spaceId\)/);
  assert.match(composer, /projectChoices: ProjectContextChoice\[\] = rankedProjects\.map/);
});
