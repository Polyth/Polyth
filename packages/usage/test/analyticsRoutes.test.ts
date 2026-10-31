import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Project, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import { createUsageAnalyticsService, createUsageLimitService } from "../src/index.ts";
import registerPackage, { usageRoutes } from "../src/serverEntry.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-a",
};

const projects: Project[] = [
  { id: "project-a", name: "Project A", path: "/a", createdAt: 1 },
  { id: "project-b", name: "Project B", path: "/b", createdAt: 1 },
];

const projection = (id: string, projectId: string): SessionProjection => ({
  id,
  projectId,
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: Date.UTC(2026, 6, 1, 13),
  lastTurnAt: Date.UTC(2026, 6, 1, 12),
  model: { providerID: "claude", modelID: "sonnet" },
  resolvedHarnessId: "claude",
});

const usageEvent = (sessionId: string): SessionEvent => ({
  id: `${sessionId}-usage`,
  sessionId,
  seq: 2,
  time: Date.UTC(2026, 6, 1, 12),
  type: "usage/recorded",
  data: {
    model: { providerID: "claude", modelID: "sonnet" },
    tokens: { input: 10, output: 1 },
    cost: .01,
  } as JsonObject,
  v: 1,
});

const makeHarness = () => {
  const projections = [projection("a", "project-a"), projection("b", "project-b")];
  const analytics = createUsageAnalyticsService({
    source: {
      projections: async () => projections,
      events: async (_space, id) => [usageEvent(id)],
    },
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "route-server",
  });
  const host = {
    forSpace: () => ({ projects: { list: async () => projects } }),
  };
  return { route: usageRoutes(analytics, host as never), analytics };
};

const request = (path: string, method: string, input?: unknown) => {
  let response: { status: number; body: unknown } | null = null;
  return {
    routeRequest: {
      path,
      method,
      space,
      body: async () => input ?? {},
      json: (status: number, body: unknown) => { response = { status, body }; },
    } as never,
    read: () => response,
  };
};

test("Stats supports project and session scopes through one canonical route", async () => {
  const harness = makeHarness();

  const projectA = request("/api/usage/stats", "POST", {
    range: "30d",
    timezone: "UTC",
    projectIds: ["project-a"],
  });
  assert.equal(await harness.route(projectA.routeRequest), true);
  const projectReport = projectA.read()!.body as {
    totals: { sessions: number; tokens: { total: number | null } };
  };
  assert.equal(projectReport.totals.sessions, 1);
  assert.equal(projectReport.totals.tokens.total, 11);

  const sessionB = request("/api/usage/stats", "POST", {
    range: "all",
    timezone: "UTC",
    sessionIds: ["b"],
  });
  assert.equal(await harness.route(sessionB.routeRequest), true);
  const sessionReport = sessionB.read()!.body as {
    totals: { sessions: number; tokens: { total: number | null } };
  };
  assert.equal(sessionReport.totals.sessions, 1);
  assert.equal(sessionReport.totals.tokens.total, 11);

  harness.analytics.stop();
});

test("quota routes are no longer part of Usage", async () => {
  const harness = makeHarness();
  const quotas = request("/api/usage/quotas", "GET");
  assert.equal(await harness.route(quotas.routeRequest), false);
  assert.equal(quotas.read(), null);
  harness.analytics.stop();
});

test("Limits use a separate operational route and do not alter analytics scopes", async () => {
  const harness = makeHarness();
  let used = 25;
  const limits = createUsageLimitService({ now: () => Date.UTC(2026, 6, 10, 12) });
  limits.register({
    id: "provider",
    async fetch() {
      return {
        providerId: "provider",
        accountLabel: "Pro",
        windows: [{
          id: "weekly",
          label: "Weekly limit",
          used,
          limit: 100,
          unit: "percent",
          periodMs: 7 * 86_400_000,
          resetsAt: Date.UTC(2026, 6, 14, 12),
        }],
        fetchedAt: Date.UTC(2026, 6, 10, 12),
        stale: false,
      };
    },
  });
  await limits.refresh("provider");
  const route = usageRoutes(harness.analytics, {
    forSpace: () => ({ projects: { list: async () => projects } }),
  } as never, limits);

  const read = request("/api/usage/limits", "GET");
  assert.equal(await route(read.routeRequest), true);
  assert.equal(read.read()?.status, 200);
  const first = read.read()?.body as { providers: Array<{ providerId: string; windows: Array<{ used: number }>; balances: unknown[] }> };
  assert.equal(first.providers[0]?.providerId, "provider");
  assert.equal(first.providers[0]?.windows[0]?.used, 25);
  assert.deepEqual(first.providers[0]?.balances, []);

  used = 40;
  const refresh = request("/api/usage/limits/refresh", "POST", { providerId: "provider" });
  assert.equal(await route(refresh.routeRequest), true);
  assert.equal(refresh.read()?.status, 200);
  const refreshed = refresh.read()?.body as { providers: Array<{ windows: Array<{ used: number }> }> };
  assert.equal(refreshed.providers[0]?.windows[0]?.used, 40);

  const legacy = request("/api/usage/quotas", "GET");
  assert.equal(await route(legacy.routeRequest), false);
  harness.analytics.stop();
});

test("malformed Stats bodies are rejected as input errors", async () => {
  const harness = makeHarness();
  const result = request("/api/usage/stats", "POST", []);
  assert.equal(await harness.route(result.routeRequest), true);
  assert.equal(result.read()!.status, 400);
  assert.equal((result.read()!.body as { error: string }).error, "invalid-input");
  harness.analytics.stop();
});

test("invalid agent-kind filters are rejected instead of broadening the report", async () => {
  const harness = makeHarness();
  const result = request("/api/usage/stats", "POST", {
    range: "30d",
    timezone: "UTC",
    agentKinds: ["not-an-agent"],
  });
  assert.equal(await harness.route(result.routeRequest), true);
  assert.equal(result.read()?.status, 400);
  harness.analytics.stop();
});

test("unknown project ids are rejected without exposing whether they exist", async () => {
  const harness = makeHarness();
  const result = request("/api/usage/stats", "POST", {
    range: "30d",
    timezone: "UTC",
    projectIds: ["foreign-space-id"],
  });
  assert.equal(await harness.route(result.routeRequest), true);
  const response = result.read()! as { status: number; body: { error: string } };
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid-input");
  assert.doesNotMatch(JSON.stringify(response.body), /foreign|not found|exist/i);
  harness.analytics.stop();
});

test("registered Usage routes read only the requested Space and session", async () => {
  const reads: string[] = [];
  const own = projection("a", "project-a");
  const foreign = projection("foreign", "project-b");
  const host = {
    pluginId: "usage",
    storageDir: mkdtempSync(join(tmpdir(), "polyth-usage-routes-")),
    store: {
      projections: () => { throw new Error("unscoped store read"); },
      events: () => { throw new Error("unscoped store read"); },
    },
    services: { provide: () => {} },
    spaceStorage: () => ({ packageDir: () => "" }),
    systemSpaceContext: (spaceId: string) => ({ ...space, spaceId, userId: "system:polyth-runtime" }),
    forSpace: (requested: SpaceContext) => {
      assert.equal(requested.spaceId, space.spaceId);
      // The index is read as server work; the reader's own view decides
      // which of its sessions a report may show.
      const as = requested.userId.startsWith("system:") ? "index" : "reader";
      return {
        projects: { list: async () => projects },
        sessions: {
          list: async (projectId?: string) => {
            reads.push(`${as} list:${projectId ?? "all"}`);
            return projectId ? [own].filter((row) => row.projectId === projectId) : [own];
          },
          snapshot: async (id: string) => {
            reads.push(`${as} snapshot:${id}`);
            if (id === foreign.id) throw Object.assign(new Error("not found"), { code: "not-found" });
            if (id !== own.id) throw Object.assign(new Error("not found"), { code: "not-found" });
            return own;
          },
          events: async (id: string, _afterSeq?: number, page?: { limit?: number; prefetch?: boolean }) => {
            reads.push(`${as} events:${id}:${page?.limit ?? "all"}:${page?.prefetch === true ? "passive" : "interactive"}`);
            return [usageEvent(id)];
          },
        },
      };
    },
  };
  const pkg = registerPackage(host as never);
  const route = pkg.routes!;
  const ownRequest = () => request("/api/usage/stats", "POST", {
    range: "all", timezone: "UTC", sessionIds: ["a"],
  });
  const first = ownRequest();
  assert.equal(await route(first.routeRequest), true);
  assert.equal(first.read()?.status, 200);
  assert.equal((first.read()?.body as { totals: { sessions: number } }).totals.sessions, 1);
  assert.deepEqual(reads, ["reader list:all", "index snapshot:a", "index events:a:all:interactive"]);

  const second = ownRequest();
  assert.equal(await route(second.routeRequest), true);
  assert.equal(second.read()?.status, 200);
  assert.deepEqual(reads, [
    "reader list:all", "index snapshot:a", "index events:a:all:interactive",
    "reader list:all", "index snapshot:a", "index events:a:1:passive",
  ]);

  const denied = request("/api/usage/stats", "POST", {
    range: "all", timezone: "UTC", sessionIds: [foreign.id],
  });
  assert.equal(await route(denied.routeRequest), true);
  assert.equal(denied.read()?.status, 200);
  assert.equal((denied.read()?.body as { totals: { sessions: number } }).totals.sessions, 0);
  assert.ok(!reads.some((read) => read.includes("foreign")), "a session the reader cannot open is never read for them");
  pkg.onDisable?.();
});

test("the usage identity survives a restart and differs per storage root", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { usageServerInstanceId } = await import("../src/serverEntry.ts");
  const first = mkdtempSync(join(tmpdir(), "polyth-usage-id-"));
  const second = mkdtempSync(join(tmpdir(), "polyth-usage-id-"));
  try {
    const id = usageServerInstanceId(first);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(usageServerInstanceId(first), id, "a second process start reads the same id");
    assert.notEqual(usageServerInstanceId(second), id, "another data directory is another runtime");
    assert.notEqual(usageServerInstanceId(undefined), usageServerInstanceId(undefined), "no root degrades to a per-process id");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("legacy usage files in the shared data root are adopted and the instance id survives", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-data-"));
  const legacyId = "11111111-2222-3333-4444-555555555555";
  try {
    writeFileSync(join(root, "usage-instance-v1.json"), JSON.stringify({ id: legacyId }));
    writeFileSync(join(root, "usage-limits-v1.json"), JSON.stringify({ version: 1, snapshots: [] }));
    writeFileSync(join(root, "limits-providers.json"), "[]");
    const host = {
      pluginId: "usage",
      storageDir: root,
      spaceStorage: () => ({ packageDir: () => join(root, "space") }),
      systemSpaceContext: (spaceId: string) => ({ ...space, spaceId, userId: "system:polyth-runtime" }),
      services: { provide: () => {}, get: () => undefined },
    } as never;
    const pkg = registerPackage(host);

    for (const name of ["usage-instance-v1.json", "usage-limits-v1.json", "limits-providers.json"]) {
      assert.equal(existsSync(join(root, "packages", "usage", name)), true, `${name} moved into the package directory`);
      assert.equal(existsSync(join(root, name)), false, `${name} left the shared root`);
    }
    let identity: unknown;
    await pkg.routes!({
      space, path: "/api/usage/identity", method: "GET",
      json: (_status: number, value: unknown) => { identity = value; },
    } as never);
    assert.equal((identity as { serverInstanceId: string }).serverInstanceId, legacyId);
    pkg.onDisable?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh usage install writes only under the package directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-data-"));
  try {
    const host = {
      pluginId: "usage",
      storageDir: root,
      spaceStorage: () => ({ packageDir: () => join(root, "space") }),
      systemSpaceContext: (spaceId: string) => ({ ...space, spaceId, userId: "system:polyth-runtime" }),
      services: { provide: () => {}, get: () => undefined },
    } as never;
    const pkg = registerPackage(host);

    assert.deepEqual(readdirSync(root), ["packages"], "nothing is written to the shared root");
    assert.equal(existsSync(join(root, "packages", "usage", "usage-instance-v1.json")), true);
    assert.equal(existsSync(join(root, "usage-instance-v1.json")), false);
    pkg.onDisable?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegation routing names models from a bounded-age read of the live catalog", async (t) => {
  const { createServerServiceRegistry, SERVER_MODEL_ROUTING, SERVER_RUNTIME_CATALOG } = await import("@polyth/plugins");
  const { ROUTING_CATALOG_MAX_AGE_MS } = await import("../src/routing.ts");
  const services = createServerServiceRegistry();
  const reads: unknown[] = [];
  services.provide(SERVER_RUNTIME_CATALOG, {
    async models(options) {
      reads.push(options);
      return [
        { harnessId: "claude", providerID: "anthropic", modelID: "default", name: "Default (recommended)", resolvedModelID: "claude-opus-5-5" },
        { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus 5.5", resolvedModelID: "claude-opus-5-5" },
      ];
    },
    invalidateModels() {},
  });
  const recent = Date.now() - 60_000;
  const own = { ...projection("a", "project-a"), lastTurnAt: recent, updatedAt: recent };
  // Telemetry reports what ran, which is not a row of the Claude catalog.
  const ran = { ...usageEvent("a"), time: recent, data: { ...usageEvent("a").data, model: { providerID: "anthropic", modelID: "claude-opus-5-5" } } };
  const root = mkdtempSync(join(tmpdir(), "polyth-usage-routing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = {
    pluginId: "usage",
    storageDir: root,
    services,
    spaceStorage: () => ({ packageDir: () => join(root, "space") }),
    systemSpaceContext: (spaceId: string) => ({ ...space, spaceId, userId: "system:polyth-runtime" }),
    forSpace: () => ({
      projects: { list: async () => projects },
      sessions: {
        list: async () => [own],
        snapshot: async () => own,
        events: async () => [ran],
      },
    }),
  };
  const pkg = registerPackage(host as never);
  const report = await services.get(SERVER_MODEL_ROUTING)!.candidates(space);
  assert.deepEqual(reads, [{ maxAgeMs: ROUTING_CATALOG_MAX_AGE_MS }]);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.harnessId, `${candidate.providerID}/${candidate.modelID}`, candidate.turns]),
    [["claude", "anthropic/opus", 1]],
  );
  pkg.onDisable?.();
});
