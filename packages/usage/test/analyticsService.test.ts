import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonObject, Project, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import { createUsageAnalyticsService } from "../src/analytics/service.ts";

const space = (id: string, storageDir: string): SpaceContext => ({
  spaceId: id,
  spaceSlug: id,
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir,
});
const project = (id: string): Project => ({ id, name: id, path: `/${id}`, createdAt: 1 });
const session = (id: string, projectId: string, updatedAt: number): SessionProjection => ({
  id,
  projectId,
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt,
  lastTurnAt: updatedAt,
  resolvedHarnessId: "claude",
  model: { providerID: "claude", modelID: "sonnet" },
});
const event = (sessionId: string, seq: number, time: number, type: string, data: JsonObject): SessionEvent => ({
  id: `${sessionId}-${seq}`,
  sessionId,
  seq,
  time,
  type,
  data,
  v: 1,
});
const usageEvents = (sessionId: string, time: number): SessionEvent[] => [
  event(sessionId, 1, time - 1000, "turn/started", { turnId: "turn-1", harnessId: "claude" }),
  event(sessionId, 2, time, "usage/recorded", { model: { providerID: "claude", modelID: "sonnet" }, tokens: { input: 10, output: 2 }, cost: .01 }),
  event(sessionId, 3, time + 1000, "turn/stopped", { turnId: "turn-1", reason: "completed" }),
];

test("analytics service backfills canonical logs, persists a checkpoint, and removes deleted sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-"));
  const context = space("space-a", root);
  const a = session("a", "project-a", 2_000);
  const b = session("b", "project-b", 2_000);
  const events = new Map([
    ["a", usageEvents("a", Date.UTC(2026, 6, 1, 12))],
    ["b", usageEvents("b", Date.UTC(2026, 6, 2, 12))],
  ]);
  let eventReads = 0;
  const source = {
    projections: async (requestedSpace: SpaceContext) =>
      requestedSpace.spaceId === "space-a" ? [a, b] : [],
    events: async (_space: SpaceContext, id: string) => {
      eventReads += 1;
      return events.get(id) ?? [];
    },
  };
  const service = createUsageAnalyticsService({
    source,
    storageDir: () => root,
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-a",
  });
  const projects = [project("project-a"), project("project-b")];
  const all = await service.query(context, projects, { range: "30d", timezone: "UTC" });
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.totals.tokens.total, 24);
  assert.equal(eventReads, 2);
  service.stop();

  const restored = createUsageAnalyticsService({
    source,
    storageDir: () => root,
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-b",
  });
  const restoredReport = await restored.query(context, projects, { range: "30d", timezone: "UTC" });
  assert.equal(restoredReport.totals.tokens.total, 24);
  assert.equal(eventReads, 2, "unchanged sessions are not rescanned from the checkpoint");

  const deleted = createUsageAnalyticsService({
    source: { ...source, projections: async () => [a] },
    storageDir: () => root,
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-c",
  });
  const afterDelete = await deleted.query(context, projects, { range: "30d", timezone: "UTC" });
  assert.equal(afterDelete.totals.sessions, 1);
  deleted.stop();
  rmSync(root, { recursive: true, force: true });
});

test("analytics query never includes a projection from another Space", async () => {
  const context = space("space-a", "/tmp/polyth-usage-space-a");
  const own = { ...session("own", "project-a", 2_000), spaceId: "space-a" };
  const foreign = { ...session("foreign", "project-b", 2_000), spaceId: "space-b" };
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => [own, foreign],
      events: async (_space, id) => usageEvents(id, Date.UTC(2026, 6, 1)),
    },
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-a",
  });
  const result = await service.query(context, [project("project-a"), project("project-b")], { range: "30d", timezone: "UTC" });
  assert.equal(result.totals.sessions, 1);
  assert.deepEqual(result.sessions.map((item) => item.id), ["own"]);
  service.stop();
});


test("session and single-project queries avoid cold event scans outside their scope", async () => {
  const context = space("space-a", "/tmp/polyth-usage-scoped-sync");
  const rows = [
    session("a", "project-a", 2_000),
    session("b", "project-a", 2_000),
    session("c", "project-b", 2_000),
  ];
  const projectionCalls: Array<{ projectId?: string; sessionIds?: string[] }> = [];
  const eventReads: string[] = [];
  const service = createUsageAnalyticsService({
    source: {
      projections: async (_space, scope) => {
        projectionCalls.push({ projectId: scope?.projectId, sessionIds: scope?.sessionIds ? [...scope.sessionIds] : undefined });
        return rows.filter((row) =>
          (!scope?.projectId || row.projectId === scope.projectId)
          && (!scope?.sessionIds || scope.sessionIds.has(row.id)));
      },
      events: async (_space, id) => {
        eventReads.push(id);
        return usageEvents(id, Date.UTC(2026, 6, 1, 12));
      },
    },
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-scoped",
  });
  const projects = [project("project-a"), project("project-b")];

  const sessionReport = await service.query(context, projects, {
    range: "all",
    timezone: "UTC",
    sessionIds: ["b"],
  });
  assert.equal(sessionReport.totals.sessions, 1);
  assert.deepEqual(eventReads, ["b"]);
  assert.deepEqual(projectionCalls[0], { projectId: undefined, sessionIds: ["b"] });

  rows.splice(rows.findIndex((row) => row.id === "b"), 1);
  const deletedSession = await service.query(context, projects, {
    range: "all",
    timezone: "UTC",
    sessionIds: ["b"],
  });
  assert.equal(deletedSession.totals.sessions, 0, "scoped sync evicts a deleted cached session");

  eventReads.length = 0;
  const projectReport = await service.query(context, projects, {
    range: "30d",
    timezone: "UTC",
    projectIds: ["project-b"],
  });
  assert.equal(projectReport.totals.sessions, 1);
  assert.deepEqual(eventReads, ["c"]);
  assert.deepEqual(projectionCalls.at(-1), { projectId: "project-b", sessionIds: undefined });

  service.stop();
});

test("warm tail checks use bounded concurrency and catch events ahead of projections", async () => {
  const context = space("tails", "/unused");
  const rows = Array.from({ length: 12 }, (_, index) => session(String(index), "p", 2_000));
  let active = 0;
  let maximum = 0;
  let reads = 0;
  let advanced = false;
  const service = createUsageAnalyticsService({
    concurrency: 3,
    source: {
      projections: async () => rows,
      events: async (_space, id) => {
        reads += 1;
        return advanced && id === "0" ? usageEvents(id, Date.UTC(2026, 6, 1)) : [];
      },
      latestSeq: async (_space, id) => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return advanced && id === "0" ? 3 : 0;
      },
    },
    now: () => Date.UTC(2026, 6, 10),
  });
  try {
    const query = { range: "30d", timezone: "UTC" } as const;
    await service.query(context, [project("p")], query);
    await service.query(context, [project("p")], query);
    assert.equal(maximum, 3, "warm reads overlap without exceeding the configured bound");
    assert.equal(reads, 12, "unchanged event logs are reused");
    advanced = true;
    const result = await service.query(context, [project("p")], query);
    assert.equal(reads, 13, "only the advanced session log is rebuilt");
    assert.equal(result.totals.tokens.total, 12);
  } finally {
    service.stop();
  }
});

test("concurrent exact reports share a sync, stay Space-scoped, and retry after failures", async () => {
  let listings = 0;
  let fail = true;
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => {
        listings += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (fail) throw new Error("source unavailable");
        return [];
      },
      events: async () => [],
    },
  });
  const a = space("a", "/unused/a");
  const b = space("b", "/unused/b");
  const query = { range: "30d", timezone: "UTC" } as const;
  try {
    const rejected = await Promise.allSettled([service.query(a, [], query), service.query(a, [], query)]);
    assert.ok(rejected.every((result) => result.status === "rejected"));
    assert.equal(listings, 1);
    fail = false;
    const results = await Promise.all([service.query(a, [], query), service.query(a, [], query), service.query(b, [], query)]);
    assert.equal(listings, 3);
    assert.equal(results[0], results[1]);
    assert.equal(results[2]!.spaceId, "b");
    await service.query(a, [], query);
    assert.equal(listings, 4, "a later request revalidates rather than keeping a stale report");
  } finally {
    service.stop();
  }
});

test("a scoped report materializes only its sessions after warming the whole Space", async () => {
  const rows = [session("a", "p", 1), session("b", "q", 1)];
  const service = createUsageAnalyticsService({
    source: {
      projections: async (_space, scope) => rows.filter((row) => !scope?.sessionIds || scope.sessionIds.has(row.id)),
      events: async (_space, id) => usageEvents(id, Date.UTC(2026, 6, 1)),
    },
    now: () => Date.UTC(2026, 6, 10),
  });
  try {
    const context = space("scoped-warm", "/unused");
    const projects = [project("p"), project("q")];
    const global = await service.query(context, projects, { range: "all", timezone: "UTC" });
    assert.equal(global.coverage.syncedSessions, 2);
    const scoped = await service.query(context, projects, { range: "all", timezone: "UTC", sessionIds: ["a"] });
    assert.equal(scoped.coverage.syncedSessions, 1);
    assert.equal(scoped.totals.tokens.total, 12);
  } finally {
    service.stop();
  }
});

test("a status or title flip neither re-reads the event log nor rebuilds the report", async () => {
  const context = space("flip", "/unused");
  const row = session("live", "p", 2_000);
  let reads = 0;
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => [{ ...row }],
      events: async (_space, id) => {
        reads += 1;
        return usageEvents(id, Date.UTC(2026, 6, 1));
      },
      latestSeq: async () => 3,
    },
    now: () => Date.UTC(2026, 6, 10),
  });
  try {
    const query = { range: "30d", timezone: "UTC", detailLimit: 10 } as const;
    const first = await service.query(context, [project("p")], query);
    assert.equal(reads, 1);
    assert.equal(first.sessions[0]?.status, "idle");
    // A working session flips status and updatedAt on every tick.
    row.status = "working";
    row.updatedAt = 3_000;
    row.title = "Renamed";
    const second = await service.query(context, [project("p")], query);
    assert.equal(reads, 1, "metadata-only changes reuse the collected observations");
    assert.equal(second.totals, first.totals, "and the built aggregate");
    assert.equal(second.sessions[0]?.status, "working", "while the drill-down row is relabelled");
    assert.equal(second.sessions[0]?.title, "Renamed");
    assert.equal(second.turns[0]?.sessionTitle, "Renamed");
    // A moved session (new project or model) is collected again.
    row.model = { providerID: "openai", modelID: "gpt-5" };
    await service.query(context, [project("p")], query);
    assert.equal(reads, 2, "fields the collector reads still invalidate the session");
  } finally {
    service.stop();
  }
});

test("a checkpoint written with the status-bearing fingerprint is upgraded without rescanning", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-legacy-"));
  const context = space("legacy", root);
  const row = session("a", "p", 2_000);
  const legacyFingerprint = JSON.stringify([
    row.projectId, "", "", row.status, row.updatedAt, row.lastTurnAt ?? 0, row.resolvedHarnessId ?? "",
    row.model?.providerID ?? "", row.model?.modelID ?? "", row.model?.variant ?? "",
    null, null, null, null, null, null,
  ]);
  const events = usageEvents("a", Date.UTC(2026, 6, 1));
  const observation = {
    id: "usage:a-2", timestamp: Date.UTC(2026, 6, 1), projectId: "p", sessionId: "a", turnId: "turn-1",
    providerId: "claude", modelId: "sonnet", harnessId: "claude", agentKind: "main",
    tokens: { input: 10, output: 2, reasoning: null, cacheRead: null, cacheWrite: null }, cost: .01, costSource: "exact", quality: "exact",
  };
  writeFileSync(join(root, "analytics-v1.json"), JSON.stringify({
    version: 1, spaceId: "legacy",
    sessions: [{ id: "a", title: "a", status: "idle", fingerprint: legacyFingerprint, seq: 3, observations: [observation] }],
  }));
  let reads = 0;
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => [{ ...row, status: "working", updatedAt: 9_000 }],
      events: async () => { reads += 1; return events; },
      latestSeq: async () => 3,
    },
    storageDir: () => root,
    now: () => Date.UTC(2026, 6, 10),
  });
  try {
    const report = await service.query(context, [project("p")], { range: "30d", timezone: "UTC" });
    assert.equal(reads, 0, "the old fingerprint is recognised and upgraded in place");
    assert.equal(report.totals.tokens.total, 12);
    assert.equal(report.sessions[0]?.status, "working");
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("people in one Space share the index but each report shows only chats its reader may open", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-readers-"));
  const ann = { ...space("space-a", root), userId: "usr_ann" };
  const bea = { ...space("space-a", root), userId: "usr_bea" };
  const mine = session("mine", "project-a", 2_000);
  const theirs = { ...session("theirs", "project-a", 2_000), title: "Bea's private plans" };
  let eventReads = 0;
  const visibleTo: Record<string, string[]> = { usr_ann: ["mine"], usr_bea: ["mine", "theirs"] };
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => [mine, theirs],
      events: async (_space: SpaceContext, id: string) => {
        eventReads += 1;
        return usageEvents(id, Date.UTC(2026, 6, 1, 12));
      },
      visibleSessions: async (reader: SpaceContext) => new Set(visibleTo[reader.userId] ?? []),
    },
    storageDir: () => root,
    now: () => Date.UTC(2026, 6, 10),
  });
  try {
    const projects = [project("project-a")];
    const forBea = await service.query(bea, projects, { range: "30d", timezone: "UTC" });
    const forAnn = await service.query(ann, projects, { range: "30d", timezone: "UTC" });
    assert.equal(forBea.totals.sessions, 2);
    assert.equal(forAnn.totals.sessions, 1);
    assert.doesNotMatch(JSON.stringify(forAnn), /theirs|private plans/);
    assert.equal(eventReads, 2, "one shared index, read once");
    const asked = await service.query(ann, projects, { range: "30d", timezone: "UTC", sessionIds: ["theirs"] });
    assert.equal(asked.totals.sessions, 0, "naming a chat does not open it");
    assert.equal((await service.observations(ann, 0)).every((row) => row.sessionId === "mine"), true);

    // Sharing changes what the same reader sees without a reindex.
    visibleTo.usr_ann = ["mine", "theirs"];
    assert.equal((await service.query(ann, projects, { range: "30d", timezone: "UTC" })).totals.sessions, 2);
    assert.equal(eventReads, 2);
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
