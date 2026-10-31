import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import type { McpInspectionDto } from "@polyth/contracts/capability-installations";
import { createMcpConfigService } from "../src/mcp.ts";
import { settingsRoutes } from "../src/routes/settings.ts";
import type { RouteRequest } from "../src/http.ts";

const http = { kind: "http" as const, url: "https://mcp.example/tools", headersSecretRefs: ["Authorization"] };
const inspection = (name: string): McpInspectionDto => ({ ok: true, message: "MCP connected", checkedAt: 1, tools: [{ name, inputSchema: { type: "object" } }] });
const setup = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-mcp-management-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const space = (id: string): SpaceContext => {
    const storageDir = join(dir, id);
    mkdirSync(storageDir);
    return { spaceId: id, spaceSlug: id, storageDir, userId: `user-${id}`, role: "owner", deployment: "server-trusted" };
  };
  const a = space("a"), b = space("b");
  const base = {
    dataDir: dir, deployment: "server-trusted" as const,
    assertProject(ctx: SpaceContext, id: string) {
      if ((ctx.spaceId === "a" && ["p-a", "p-b"].includes(id)) || (ctx.spaceId === "b" && id === "p-foreign")) return;
      throw Object.assign(new Error("project not found"), { code: "not-found" });
    },
  };
  return { a, b, base };
};

test("MCP import is atomic, revisioned and isolated; reserved names never install", async (t) => {
  const { a, b, base } = setup(t);
  let changed = 0;
  const mcp = createMcpConfigService({ ...base, onChanged: async () => { changed++; } });
  await assert.rejects(mcp.importServers(a, [{ name: "one", transport: http }, { name: "broken", transport: { ...http, url: "file:///tmp/private" } }], "p-a"), { code: "invalid-input" });
  assert.deepEqual(mcp.list(a, "p-a"), []);
  assert.equal(changed, 0);
  await assert.rejects(mcp.importServers(a, [{ name: "one", transport: http }, { name: "one", transport: http }], "p-a"), { code: "conflict" });
  await assert.rejects(mcp.create(a, { name: "polyth-agent-tools", transport: http }, "p-a"), { code: "invalid-input" });
  const imported = await mcp.importServers(a, [{ name: "one", transport: http, secrets: { Authorization: "synthetic-test-secret" } }, { name: "two", transport: http, enabled: false }], "p-a");
  assert.equal(changed, 1);
  assert.deepEqual(imported.map((s) => [s.name, s.revision, s.enabled]), [["one", 1, true], ["two", 1, false]]);
  assert.doesNotMatch(JSON.stringify(imported), /synthetic-test-secret/);
  assert.deepEqual(mcp.list(a, "p-b"), []);
  assert.deepEqual(mcp.list(b, "p-foreign"), []);
  await assert.rejects(mcp.importServers(a, [{ name: "foreign", transport: http }], "p-foreign"), { code: "not-found" });
  await assert.rejects(mcp.importServers({ ...a, role: "viewer" }, [{ name: "viewer", transport: http }], "p-a"), { code: "forbidden" });
});

test("inherited overrides retain credentials internally and inventories stay project-scoped", async (t) => {
  const { a, base } = setup(t);
  let probes = 0;
  const mcp = createMcpConfigService({ ...base, projectForProbe: async (_s, p) => ({ path: `/projects/${p}` }), inspect: async (input) => {
    probes++;
    assert.equal(input.secrets.Authorization, "synthetic-test-secret");
    return inspection(input.cwd!);
  } });
  const shared = await mcp.create(a, { name: "shared", transport: http, secrets: { Authorization: "synthetic-test-secret" } });
  await mcp.test(a, shared.id, "p-a");
  await mcp.test(a, shared.id, "p-b");
  assert.equal(mcp.list(a, "p-a")[0]!.inspection!.tools[0]!.name, "/projects/p-a");
  assert.equal(mcp.list(a, "p-b")[0]!.inspection!.tools[0]!.name, "/projects/p-b");
  assert.equal(mcp.list(a)[0]!.inspection, undefined);
  assert.equal(probes, 2);
  assert.equal(mcp.tools(a, shared.id, "p-a").ok, true);
  assert.equal(probes, 2, "reading tools must not start the configured executable");
  const override = await mcp.override(a, shared.id, "p-a", false);
  assert.equal(override.enabled, false);
  assert.equal(mcp.list(a, "p-b")[0]!.enabled, true);
  assert.equal(mcp.projection(a, "p-a").secretsFor(override.id).Authorization, "synthetic-test-secret");
  assert.doesNotMatch(JSON.stringify(override), /synthetic-test-secret/);
  await assert.rejects(mcp.test(a, shared.id, "p-a"), { code: "not-found" });
  assert.equal((await mcp.test(a, override.id, "p-a")).ok, false);
  assert.equal(probes, 2, "disabled installation must not be executed");
  await mcp.remove(a, override.id, "p-a");
  assert.equal(mcp.list(a, "p-a")[0]!.id, shared.id);
  const reopened = createMcpConfigService(base);
  assert.equal(reopened.tools(a, shared.id, "p-b").tools[0]!.name, "/projects/p-b");
  await mcp.update(a, shared.id, { transport: { ...http, url: "https://mcp.example/new" } }, shared.revision);
  assert.equal(mcp.tools(a, shared.id, "p-b").checkedAt, 0);
  assert.equal(mcp.list(a, "p-b")[0]!.status, "starting");
});

test("a single protocol check is shared and a stale result never overwrites edited configuration", async (t) => {
  const { a, base } = setup(t);
  let finish!: (result: McpInspectionDto) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let count = 0;
  const mcp = createMcpConfigService({ ...base, inspect: async () => {
    count++; entered();
    return new Promise((resolve) => { finish = resolve; });
  } });
  const row = await mcp.create(a, { name: "check", transport: http }, "p-a");
  const first = mcp.test(a, row.id, "p-a"), second = mcp.test(a, row.id, "p-a");
  const failed = Promise.allSettled([first, second]);
  await started;
  await mcp.update(a, row.id, { enabled: false }, row.revision, "p-a");
  finish(inspection("stale"));
  const results = await failed;
  assert.equal(count, 1);
  assert.equal(results.every((r) => r.status === "rejected" && r.reason.code === "conflict"), true);
  assert.equal(mcp.list(a, "p-a")[0]!.status, "disabled");
  assert.equal(mcp.list(a, "p-a")[0]!.inspection, undefined);
});

test("portable calls preserve session scope, reject foreign and disabled servers, and never replay errors", async (t) => {
  const { a, b, base } = setup(t);
  const calls: unknown[] = [];
  const mcp = createMcpConfigService({ ...base, invoke: async (input) => {
    calls.push(input);
    throw Object.assign(new Error("outcome unknown"), { code: "outcome-unknown" });
  } });
  const row = await mcp.create(a, { name: "own", transport: http }, "p-a");
  const foreign = await mcp.create(b, { name: "foreign", transport: http }, "p-foreign");
  const input = { toolName: "write", arguments: { path: "test" }, sessionId: "session-a", cwd: "/projects/worktree-a" };
  await assert.rejects(mcp.call(a, foreign.id, "p-a", input), { code: "not-found" });
  await assert.rejects(mcp.call(a, row.id, "p-foreign", input), { code: "not-found" });
  await assert.rejects(mcp.call(a, row.id, "p-a", input), { code: "outcome-unknown" });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { cwd: string }).cwd, input.cwd);
  assert.match((calls[0] as { authorityFile: string }).authorityFile, /mcp-calls\/p-a\/session-a\//);
  await mcp.update(a, row.id, { enabled: false }, row.revision, "p-a");
  await assert.rejects(mcp.call(a, row.id, "p-a", input), { code: "forbidden" });
  assert.equal(calls.length, 1);
  assert.throws(() => mcp.tools(a, foreign.id, "p-a"), { code: "not-found" });
});

test("MCP HTTP routes preserve project scope, validate full imports, and expose only cached tools", async (t) => {
  const { a, b, base } = setup(t);
  let checks = 0;
  const mcp = createMcpConfigService({ ...base, inspect: async () => { checks++; return inspection("ping"); } });
  const routes = settingsRoutes({ mcp, behavior: {} as never, systemInfo: () => ({} as never) });
  const invoke = async (space: SpaceContext, method: string, path: string, body: unknown = {}) => {
    let result: unknown;
    const url = new URL(path, "http://test.invalid");
    const handled = await routes({ space, method, path: url.pathname, url, body: async () => body, json: (status: number, value: unknown) => { assert.equal(status, 200); result = value; } } as RouteRequest);
    assert.equal(handled, true);
    return result;
  };
  await assert.rejects(invoke(a, "POST", "/api/mcp/servers/import?projectId=p-a", { servers: [{ name: "ok", transport: http }, { name: "bad", transport: { kind: "stdio", command: "node", args: [42], envKeys: [] } }] }), { code: "invalid-input" });
  assert.deepEqual(mcp.list(a, "p-a"), []);
  await assert.rejects(invoke(a, "POST", "/api/mcp/servers/import?projectId=p-foreign", { servers: [{ name: "foreign", transport: http }] }), { code: "not-found" });
  await assert.rejects(invoke(a, "POST", "/api/mcp/servers?projectId=", { name: "empty-scope", transport: http }), { code: "not-found" });
  const installed = await invoke(a, "POST", "/api/mcp/servers/import?projectId=p-a", { servers: [{ name: "one", transport: http, secrets: { Authorization: "synthetic-secret" } }] }) as Array<{ id: string }>;
  assert.doesNotMatch(JSON.stringify(installed), /synthetic-secret/);
  const path = `/api/mcp/servers/${installed[0]!.id}`;
  assert.equal((await invoke(a, "GET", `${path}/tools?projectId=p-a`) as McpInspectionDto).checkedAt, 0);
  assert.equal(checks, 0);
  await invoke(a, "POST", `${path}/probe?projectId=p-a`);
  assert.equal((await invoke(a, "GET", `${path}/tools?projectId=p-a`) as McpInspectionDto).tools[0]!.name, "ping");
  assert.equal(checks, 1);
  await assert.rejects(invoke(a, "GET", `${path}/tools?projectId=p-b`), { code: "not-found" });
  await assert.rejects(invoke(b, "GET", `${path}/tools?projectId=p-foreign`), { code: "not-found" });
});

test("the session MCP process authority cannot admit concurrent calls or path aliases", async (t) => {
  const { a, base } = setup(t);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const mcp = createMcpConfigService({ ...base, invoke: async () => { calls++; await hold; return { content: [] }; } });
  const row = await mcp.create(a, { name: "own", transport: http }, "p-a");
  const input = { toolName: "ping", arguments: {}, sessionId: "session-a", cwd: "/worktree" };
  const first = mcp.call(a, row.id, "p-a", input);
  await assert.rejects(mcp.call(a, row.id, "p-a", input), { code: "conflict" });
  await assert.rejects(mcp.call(a, row.id, "p-a", { ...input, sessionId: "a/../../b" }), { code: "invalid-input" });
  release();
  await first;
  assert.equal(calls, 1);
  await mcp.call(a, row.id, "p-a", input);
  assert.equal(calls, 2, "a completed call releases its admission fence");
});


test("sandboxed deployments never launch host MCP processes", async (t) => {
  const { a, base } = setup(t);
  let probes = 0, calls = 0;
  const mcp = createMcpConfigService({ ...base, deployment: "multi-tenant-sandboxed",
    inspect: async () => { probes++; return inspection("host-tool"); },
    invoke: async () => { calls++; return { content: [] }; },
  });
  const row = await mcp.create({ ...a, deployment: "multi-tenant-sandboxed" }, {
    name: "host-command", transport: { kind: "stdio", command: "node", args: [], envKeys: [] },
  }, "p-a");
  const outcomes = [];
  for (const operation of [() => mcp.test(a, row.id, "p-a"), () => mcp.call(a, row.id, "p-a", { sessionId: "session-a", cwd: "/project-a", toolName: "host-tool", arguments: {} })]) {
    try { await operation(); outcomes.push("allowed"); }
    catch (error) { outcomes.push((error as { code?: string }).code); }
  }
  assert.deepEqual(outcomes, ["unsupported", "unsupported"]);
  assert.equal(probes + calls, 0, "no host transport is invoked even for a valid owned project");
});


test("sandboxed HTTP probes and calls retain the deployment network boundary", async (t) => {
  const { a, base } = setup(t);
  const policies: unknown[] = [];
  const mcp = createMcpConfigService({ ...base, deployment: "multi-tenant-sandboxed",
    inspect: async (input) => { policies.push(input.networkPolicy); return inspection("ping"); },
    invoke: async (input) => { policies.push(input.networkPolicy); return { content: [] }; },
  });
  const row = await mcp.create(a, { name: "public-server", transport: http }, "p-a");
  await mcp.test(a, row.id, "p-a");
  await mcp.call(a, row.id, "p-a", { sessionId: "session-a", cwd: "/project-a", toolName: "ping", arguments: {} });
  assert.deepEqual(policies, ["public-only", "public-only"]);
});
