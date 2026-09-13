// WP9: behavior instructions (atomic + revisioned + apply rollback) and the
// MCP config service (secret non-disclosure, duplicate names, apply rollback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { behaviorRevision, createBehaviorService, favoriteSubagentRoutingSection } from "../src/behavior.ts";
import { createClientSettings } from "../src/clientSettings.ts";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "../src/mcp.ts";
import { settingsRoutes } from "../src/routes/settings.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-set-"));
const spaceOf = (dir: string, id = "spc_test"): SpaceContext => {
  mkdirSync(dir, { recursive: true });
  return {
    spaceId: id,
    spaceSlug: "test",
    userId: "usr_test",
    role: "owner",
    deployment: "local-trusted",
    storageDir: dir,
  };
};
const mcpOf = (dir: string, extra?: { onChanged?: (space: SpaceContext) => Promise<void> }) =>
  createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_test", ...extra });

test("client settings: opaque blob round-trips with a monotonic revision", () => {
  const file = join(tmp(), "client-settings.json");
  const svc = createClientSettings({ file });

  const empty = svc.get();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.settings, {});

  const one = svc.put({ product: { density: "compact" }, ui: { fontSize: "l" } });
  assert.equal(one.revision, 1);
  assert.deepEqual(one.settings, { product: { density: "compact" }, ui: { fontSize: "l" } });

  const two = svc.put({ product: { density: "balanced" } });
  assert.equal(two.revision, 2);
  assert.equal(svc.get().revision, 2);

  // A fresh service instance recovers the last accepted state from disk.
  const reopened = createClientSettings({ file });
  assert.equal(reopened.get().revision, 2);
  assert.deepEqual(reopened.get().settings, { product: { density: "balanced" } });
});
test("client settings: non-objects and oversized payloads are rejected", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  for (const bad of [null, "string", 42, ["a"], true]) {
    assert.throws(() => svc.put(bad), (e: Error & { code?: string }) => e.code === "invalid-input");
  }
  assert.throws(
    () => svc.put({ blob: "x".repeat(256 * 1024 + 1) }),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
  // A rejected write never bumps the revision.
  assert.equal(svc.get().revision, 0);
});

test("behavior: get/put round-trip with revision, conflict on stale write", async () => {
  const svc = createBehaviorService({ file: join(tmp(), "behavior.md") });
  const empty = await svc.get();
  assert.equal(empty.text, "");
  assert.equal(empty.revision, behaviorRevision(""));

  const one = await svc.put("Be brief.\n", empty.revision);
  assert.equal(one.text, "Be brief.\n");
  assert.notEqual(one.revision, empty.revision);

  // Writing with the outdated revision is a conflict, content is preserved.
  await assert.rejects(
    () => svc.put("Other text", empty.revision),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
  assert.equal((await svc.get()).text, "Be brief.\n");

  // current() exposes revision+digest for the instructions-applied event.
  const cur = await svc.current();
  assert.equal(cur!.revision, one.revision);
  assert.equal(cur!.digest.length, 64);
});

test("behavior: size limit enforced; failed projector does not roll the file back", async () => {
  const file = join(tmp(), "behavior.md");
  let failApply = false;
  const svc = createBehaviorService({
    file,
    onChanged: async () => {
      if (failApply) throw new Error("backend rejected config");
    },
  });

  const base = await svc.get();
  await assert.rejects(() => svc.put("x".repeat(256 * 1024 + 1), base.revision), /256 KiB/);

  const good = await svc.put("keep me\n", base.revision);
  failApply = true;
  const next = await svc.put("keep me too\n", good.revision);
  assert.equal(readFileSync(file, "utf8"), "keep me too\n");
  assert.equal((await svc.get()).revision, next.revision);
});

test("behavior: favorite subagent policy is enabled by default and applied; projector failure keeps canonical policy", async () => {
  const dir = tmp();
  const applied: string[] = [];
  let fail = false;
  const svc = createBehaviorService({
    file: join(dir, "behavior.md"),
    policyFile: join(dir, "behavior-policy.json"),
    onChanged: async () => {
      if (fail) throw new Error("nope");
      applied.push(await svc.effectiveText());
    },
  });

  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });
  await svc.refresh();
  assert.match(applied.at(-1)!, /Never spawn a subagent that merely inherits/);
  assert.ok(applied.at(-1)!.includes(favoriteSubagentRoutingSection));

  assert.deepEqual(await svc.putSubagentPolicy(false), { enabled: false });
  assert.doesNotMatch(applied.at(-1)!, /Favorite subagent routing/);

  fail = true;
  assert.deepEqual(await svc.putSubagentPolicy(true), { enabled: true });
  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });
});

test("behavior: workspace AGENTS.md policy is disabled by default and persists independently", async () => {
  const dir = tmp();
  const policyFile = join(dir, "behavior-policy.json");
  const svc = createBehaviorService({
    file: join(dir, "behavior.md"),
    policyFile,
  });

  assert.deepEqual(await svc.workspaceInstructionsPolicy(), { enabled: false });
  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });
  assert.deepEqual(await svc.putWorkspaceInstructionsPolicy(true), { enabled: true });
  assert.deepEqual(await svc.workspaceInstructionsPolicy(), { enabled: true });
  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });

  assert.deepEqual(await svc.putSubagentPolicy(false), { enabled: false });
  assert.deepEqual(await svc.workspaceInstructionsPolicy(), { enabled: true });

  const reopened = createBehaviorService({ file: join(dir, "behavior.md"), policyFile });
  assert.deepEqual(await reopened.workspaceInstructionsPolicy(), { enabled: true });
  assert.deepEqual(await reopened.subagentPolicy(), { enabled: false });
});

test("mcp: CRUD with revisions; secrets stored but never returned", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir);

  const created = await svc.create(space, {
    name: "context-db",
    transport: { kind: "stdio", command: "ctx-server", args: ["--stdio"], envKeys: ["CTX_TOKEN"] },
    secrets: { CTX_TOKEN: "super-secret-value" },
  });
  assert.equal(created.revision, 1);
  assert.equal(created.status, "starting");
  // DTO carries key names only.
  assert.deepEqual((created.transport as { envKeys: string[] }).envKeys, ["CTX_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(svc.list(space)), /super-secret-value/);
  // and the structure file on disk holds no secret values either
  assert.doesNotMatch(readFileSync(join(dir, "mcp.json"), "utf8"), /super-secret-value/);

  // duplicate name rejected
  await assert.rejects(
    () => svc.create(space, { name: "context-db", transport: { kind: "http", url: "https://x.example", headersSecretRefs: [] } }),
    /already exists/,
  );

  // stale revision → conflict; fresh revision works
  await assert.rejects(() => svc.update(space, created.id, { enabled: false }, 99), /changed since/);
  const off = await svc.update(space, created.id, { enabled: false }, 1);
  assert.equal(off.status, "disabled");
  assert.equal(off.revision, 2);

  assert.equal(await svc.remove(space, created.id), true);
  assert.equal(await svc.remove(space, created.id), false);
});

test("mcp: transport validation refuses shell metacharacters and bad URLs", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir);
  await assert.rejects(
    () => svc.create(space, { name: "evil", transport: { kind: "stdio", command: "rm -rf / ; echo", args: [], envKeys: [] } }),
    /bare executable/,
  );
  await assert.rejects(
    () => svc.create(space, { name: "bad-url", transport: { kind: "http", url: "ftp://host", headersSecretRefs: [] } }),
    /http\(s\)/,
  );
});

test("mcp: failed projector does not roll the stored list back", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  let fail = false;
  const applied: string[] = [];
  const svc = mcpOf(dir, {
    onChanged: async (ctx) => {
      if (fail) throw new Error("backend config invalid");
      applied.push(svc.list(ctx).map((e) => e.name).join(","));
    },
  });

  await svc.create(space, { name: "alpha", transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } });
  assert.equal(applied.at(-1), "alpha");

  fail = true;
  await svc.create(space, { name: "beta", transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } });
  assert.deepEqual(svc.list(space).map((s) => s.name), ["alpha", "beta"], "canonical create is kept when a projector fails");
  fail = false;
  const b = await svc.create(space, {
    name: "gamma",
    transport: { kind: "stdio", command: "srv", args: [], envKeys: ["KEY"] },
    secrets: { KEY: "super-secret-value" },
  });
  assert.ok(b.id);
  assert.equal(applied.at(-1), "alpha,beta,gamma");
  assert.doesNotMatch(JSON.stringify(svc.projection(space).servers), /super-secret-value/);
  assert.equal(svc.projection(space).secretsFor(b.id).KEY, "super-secret-value");
});

test("mcp: seed parser maps opencode.json entries to creatable inputs", () => {
  const entries = mcpEntriesFromBackendConfig({
    theme: "dark",
    mcp: {
      ctx: { type: "local", command: ["ctx-server", "--stdio"], enabled: true, environment: { API_KEY: "secret-v" } },
      web: { type: "remote", url: "https://x.example/mcp", enabled: false, headers: { Authorization: "Bearer t" } },
      broken: { type: "local", command: [] },
      junk: "nope",
    },
  });
  assert.equal(entries.length, 2, "unparseable entries are skipped");
  const ctx = entries.find((e) => e.name === "ctx")!;
  assert.deepEqual(ctx.transport, { kind: "stdio", command: "ctx-server", args: ["--stdio"], envKeys: ["API_KEY"] });
  assert.deepEqual(ctx.secrets, { API_KEY: "secret-v" });
  assert.equal(ctx.enabled, true);
  const web = entries.find((e) => e.name === "web")!;
  assert.deepEqual(web.transport, { kind: "http", url: "https://x.example/mcp", headersSecretRefs: ["Authorization"] });
  assert.equal(web.enabled, false);
  assert.deepEqual(mcpEntriesFromBackendConfig({}), []);
});

test("mcp: seeded entries never expose secret values through the DTO", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir);
  for (const entry of mcpEntriesFromBackendConfig({
    mcp: { ctx: { type: "local", command: ["ctx"], environment: { API_KEY: "super-secret" } } },
  })) {
    await svc.create(space, entry);
  }
  const dto = svc.list(space)[0]!;
  assert.equal(JSON.stringify(dto).includes("super-secret"), false, "secret value never serialized");
  assert.deepEqual((dto.transport as { envKeys: string[] }).envKeys, ["API_KEY"], "only the key name is visible");
});

test("mcp: disabled servers stay in the canonical list and are omitted from projection apply input (F10)", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir);

  const a = await svc.create(space, { name: "alpha", transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } });
  await svc.create(space, { name: "beta", transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } });
  await svc.update(space, a.id, { enabled: false }, a.revision);
  assert.deepEqual(svc.list(space).map((s) => `${s.name}:${s.enabled}`), ["alpha:false", "beta:true"]);
  assert.deepEqual(
    svc.projection(space).servers.filter((s) => s.enabled).map((s) => s.name),
    ["beta"],
  );
});

test("mcp: stdio test reports command reachability honestly", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir);
  const there = await svc.create(space, { name: "node-echo", transport: { kind: "stdio", command: "node", args: [], envKeys: [] } });
  const gone = await svc.create(space, { name: "ghost", transport: { kind: "stdio", command: "definitely-not-a-real-binary-xyz", args: [], envKeys: [] } });

  const ok = await svc.test(space, there.id);
  assert.equal(ok.ok, true);
  const bad = await svc.test(space, gone.id);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not found/);
  const row = svc.list(space).find((s) => s.id === gone.id)!;
  assert.equal(row.status, "error");
});

test("mcp settings route is owned by rc.space", async () => {
  const dir = tmp();
  const spaceA = spaceOf(join(dir, "a"), "spc_a");
  const spaceB = spaceOf(join(dir, "b"), "spc_b");
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(spaceA, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const routes = settingsRoutes({
    behavior: {
      get: async () => ({ text: "", revision: "0" }),
      put: async () => ({ text: "", revision: "0" }),
      subagentPolicy: async () => ({ enabled: true }),
      putSubagentPolicy: async () => ({ enabled: true }),
      current: async () => null,
    } as never,
    mcp,
    systemInfo: () => ({
      version: "test",
      applicationUrl: "http://127.0.0.1:1",
      tunnelUrl: null,
      dataDirLabel: "data",
      capabilities: [],
    }),
  });
  const invoke = async (space: SpaceContext) => {
    let code = 0;
    let body: unknown;
    const rc = {
      req: {} as never,
      res: {} as never,
      url: new URL("http://polyth.test/api/mcp/servers"),
      path: "/api/mcp/servers",
      method: "GET",
      ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: false },
      principal: { kind: "local-user", trustedLoopback: true },
      space,
      requireCapability() {},
      body: async () => ({}),
      json(nextCode: number, nextBody: unknown) {
        code = nextCode;
        body = nextBody;
      },
    } as unknown as RouteRequest;
    await routes(rc);
    return { code, body };
  };
  const fromA = await invoke(spaceA);
  const fromB = await invoke(spaceB);
  assert.equal(fromA.code, 200);
  assert.equal(Array.isArray(fromA.body), true);
  assert.equal((fromA.body as unknown[]).length, 1);
  assert.equal(fromB.code, 200);
  assert.deepEqual(fromB.body, []);
});

test("workspace instruction policy settings route validates and persists the toggle", async () => {
  const dir = tmp();
  const behavior = createBehaviorService({
    file: join(dir, "behavior.md"),
    policyFile: join(dir, "behavior-policy.json"),
  });
  const routes = settingsRoutes({ behavior, mcp: {} as never, systemInfo: () => ({
    version: "test", applicationUrl: "http://127.0.0.1:1", tunnelUrl: null,
    dataDirLabel: "data", capabilities: [],
  }) });
  const invoke = async (method: "GET" | "PUT", body?: unknown) => {
    let code = 0;
    let response: unknown;
    const rc = {
      req: {} as never,
      res: {} as never,
      url: new URL("http://polyth.test/api/settings/behavior/workspace-instructions"),
      path: "/api/settings/behavior/workspace-instructions",
      method,
      ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: true },
      principal: { kind: "local-user", trustedLoopback: true },
      space: spaceOf(dir),
      requireCapability() {},
      body: async () => body ?? {},
      json(nextCode: number, nextBody: unknown) { code = nextCode; response = nextBody; },
    } as unknown as RouteRequest;
    await routes(rc);
    return { code, response };
  };

  assert.deepEqual((await invoke("GET")).response, { enabled: false });
  assert.deepEqual((await invoke("PUT", { enabled: true })).response, { enabled: true });
  assert.deepEqual((await invoke("GET")).response, { enabled: true });
  await assert.rejects(() => invoke("PUT", { enabled: "yes" }), { code: "invalid-input" });
});
