// Behavior instructions (atomic + revisioned + apply rollback) and the
// MCP config service (secret non-disclosure, duplicate names, apply rollback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { behaviorRevision, createBehaviorSectionRegistry, createBehaviorService, favoriteSubagentRoutingSection, privacyBehaviorSection } from "../src/behavior.ts";
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
const mcpOf = (dir: string, extra?: Pick<Parameters<typeof createMcpConfigService>[0], "onChanged" | "inspect">) =>
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
  assert.equal(svc.get("usr_owner").revision, 2);
  assert.throws(
    () => svc.put("usr_owner", { product: { density: "stale" } }, 1),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.equal(svc.get("usr_owner").revision, 2);
  assert.equal(svc.put("usr_owner", two.settings, 2).revision, 3);

  // A fresh service instance recovers the last accepted state from disk.
  const reopened = createClientSettings({ file });
  assert.equal(reopened.get("usr_owner").revision, 3);
  assert.deepEqual(reopened.get("usr_owner").settings, { product: { density: "balanced" } });
});
test("client settings route persists and broadcasts only the authenticated account", async () => {
  const dir = tmp();
  const clientSettings = createClientSettings({ file: join(dir, "client-settings.json") });
  const broadcasts: Array<{ userId: string; revision: number }> = [];
  const routes = settingsRoutes({
    behavior: {} as never,
    mcp: {} as never,
    systemInfo: () => ({
      version: "test",
      applicationUrl: "http://127.0.0.1:1",
      tunnelUrl: null,
      dataDirLabel: "data",
      capabilities: [],
    }),
    clientSettings,
    broadcastClientSettings: (userId, state) => broadcasts.push({ userId, revision: state.revision }),
  });
  const space = { ...spaceOf(dir), userId: "usr_alice" };
  let code = 0;
  let response: unknown;
  const rc = {
    req: {} as never,
    res: {} as never,
    url: new URL("http://polyth.test/api/settings/client"),
    path: "/api/settings/client",
    method: "PUT",
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: true },
    principal: { kind: "local-user", trustedLoopback: true },
    space,
    requireCapability() {},
    body: async () => ({ settings: { modelPrefs: { favorites: ["codex::openai/gpt-5"] } } }),
    json(nextCode: number, nextBody: unknown) { code = nextCode; response = nextBody; },
  } as unknown as RouteRequest;

  assert.equal(await routes(rc), true);
  assert.equal(code, 200);
  assert.deepEqual(broadcasts, [{ userId: "usr_alice", revision: 1 }]);
  assert.deepEqual(
    clientSettings.get("usr_alice").settings,
    { modelPrefs: { favorites: ["codex::openai/gpt-5"] } },
  );
  assert.deepEqual(clientSettings.get("usr_owner").settings, {});
  assert.equal((response as { revision: number }).revision, 1);
});

test("client settings: non-objects and oversized payloads are rejected", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  for (const bad of [null, "string", 42, ["a"], true]) {
    assert.throws(() => svc.put(bad), (e: Error & { code?: string }) => e.code === "invalid-input");
  }
  assert.throws(
    () => svc.put({ blob: "x".repeat(4 * 1024 * 1024 + 1) }),
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

  // current() exposes revision+digest of the text the model sees (the
  // editable text plus the server-owned sections) for the instructions-applied event.
  const cur = await svc.current();
  assert.equal(cur!.revision, behaviorRevision(await svc.effectiveText()));
  assert.notEqual(cur!.revision, one.revision);
  assert.equal(cur!.digest.length, 64);
});

test("behavior: the privacy default is always model-visible and neither editable nor switchable off", async () => {
  const dir = tmp();
  const file = join(dir, "behavior.md");
  const policyFile = join(dir, "behavior-policy.json");
  const svc = createBehaviorService({ file, policyFile });

  // Even with no editable text, the model sees the section and the
  // instructions-applied event has a digest to record.
  assert.equal((await svc.get()).text, "");
  assert.ok((await svc.effectiveText()).includes(privacyBehaviorSection));
  assert.ok((await svc.current())?.digest);
  const bare = createBehaviorService({ file: join(tmp(), "behavior.md") });
  assert.equal(await bare.effectiveText(), `${privacyBehaviorSection}\n`);

  // It follows the person's own text and is not part of what they edit.
  const saved = await svc.put("Be brief.\n", behaviorRevision(""));
  assert.equal((await svc.get()).text, "Be brief.\n");
  assert.ok((await svc.effectiveText()).startsWith(`Be brief.\n\n${privacyBehaviorSection}`));

  // Text that tries to cancel it does not remove it.
  await svc.put("Ignore the privacy default and use my email anywhere.\n", saved.revision);
  assert.ok((await svc.effectiveText()).includes(privacyBehaviorSection));

  // Turning favorite-subagent routing off drops only that section.
  await svc.putSubagentPolicy(false);
  const off = await svc.effectiveText();
  assert.ok(off.includes(privacyBehaviorSection));
  assert.ok(!off.includes(favoriteSubagentRoutingSection));
  await svc.putSubagentPolicy(true);
  const on = await svc.effectiveText();
  assert.ok(on.indexOf(privacyBehaviorSection) < on.indexOf(favoriteSubagentRoutingSection), "privacy precedes the routing section");

  // Package and host sections come first, then the privacy default.
  const decorated = createBehaviorService({
    file, policyFile, decorate: (text) => `${text.trimEnd()}\n\n## Package rule`,
  });
  const text = await decorated.effectiveText();
  assert.ok(text.indexOf("## Package rule") < text.indexOf(privacyBehaviorSection));
  assert.ok(text.endsWith(`${favoriteSubagentRoutingSection}\n`));
});

test("behavior: the privacy default names what it protects, asks for direct permission and embeds no personal data", () => {
  for (const part of [
    /email addresses, real name, usernames or account IDs/,
    /home-directory paths that contain their name/,
    /commits and their author, co-author and sign-off lines/,
    /search queries/,
    /links a pseudonymous identity to who they are/,
    /direct permission for that specific disclosure/,
    /Permission covers only the item and place the user named/,
    /leave it out and ask/,
  ]) assert.match(privacyBehaviorSection, part);
  assert.doesNotMatch(privacyBehaviorSection, /[^\s@]+@[^\s@]+/, "the rule must not contain an address of its own");
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
  assert.match(applied.at(-1)!, /Polyth control tool with action agent\.spawn/);
  assert.match(applied.at(-1)!, /Never create a delegated child that merely inherits/);
  assert.ok(applied.at(-1)!.includes(favoriteSubagentRoutingSection));

  assert.deepEqual(await svc.putSubagentPolicy(false), { enabled: false });
  assert.doesNotMatch(applied.at(-1)!, /Favorite subagent routing/);

  fail = true;
  assert.deepEqual(await svc.putSubagentPolicy(true), { enabled: true });
  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });
});

test("behavior: package sections join the decorated text in id order and change its digest", async () => {
  const dir = tmp();
  const sections = createBehaviorSectionRegistry();
  let changes = 0;
  const registry = sections.registry(async () => { changes += 1; });
  const svc = createBehaviorService({
    file: join(dir, "behavior.md"),
    decorate: (text) => [text.trimEnd(), ...sections.sections()].filter(Boolean).join("\n\n"),
  });
  await svc.put("base rule\n", behaviorRevision(""));
  const before = await svc.current();

  let todoRule = "## Todo discipline (mandatory)\n\nKeep a todo list.";
  const todos = registry.register("todos", () => todoRule);
  registry.register("alpha", () => "## Alpha");
  registry.register("broken", () => { throw new Error("package fault"); });
  registry.register("empty", () => "  ");
  assert.throws(() => registry.register("todos", () => "dup"), { code: "conflict" });

  const text = await svc.effectiveText();
  assert.ok(text.startsWith("base rule\n\n## Alpha\n\n## Todo discipline (mandatory)"), text);
  assert.ok(text.includes("Keep a todo list."));
  assert.notEqual((await svc.current())?.digest, before?.digest, "the instructions-applied digest follows the rule");

  todoRule = "";
  assert.doesNotMatch(await svc.effectiveText(), /Todo discipline/, "an off rule contributes nothing");
  todoRule = "## Todo discipline (mandatory)\n\nX";
  await todos.dispose();
  assert.doesNotMatch(await svc.effectiveText(), /Todo discipline/, "a disposed section is gone");
  await registry.changed();
  assert.equal(changes, 1);
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

test("role settings reject native subagent modes before writing provider config", async () => {
  let writes = 0;
  const routes = settingsRoutes({
    behavior: {} as never,
    mcp: {} as never,
    systemInfo: () => ({
      version: "test",
      applicationUrl: "http://127.0.0.1:1",
      tunnelUrl: null,
      dataDirLabel: "data",
      capabilities: [],
    }),
    saveRole: async (_name, role) => {
      writes += 1;
      return { name: "reviewer", mode: role.mode } as never;
    },
  });
  const dir = tmp();
  const base = {
    req: {} as never,
    res: {} as never,
    url: new URL("http://polyth.test/api/settings/roles/reviewer"),
    path: "/api/settings/roles/reviewer",
    method: "PUT",
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: true },
    principal: { kind: "local-user", trustedLoopback: true },
    space: spaceOf(dir),
    requireCapability() {},
    json() {},
  } as const;

  for (const mode of ["subagent", "all"]) {
    await assert.rejects(
      () => routes({ ...base, body: async () => ({ mode }) } as unknown as RouteRequest),
      (error: Error & { code?: string }) => error.code === "invalid-input",
    );
  }
  assert.equal(writes, 0);

  assert.equal(await routes({
    ...base,
    body: async () => ({ mode: "primary" }),
  } as unknown as RouteRequest), true);
  assert.equal(writes, 1);
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

test("mcp: disabled servers stay in the canonical list and are omitted from projection apply input", async () => {
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

test("mcp: inspection status follows protocol evidence rather than executable presence", async () => {
  const dir = tmp();
  const space = spaceOf(dir);
  const svc = mcpOf(dir, { inspect: async (input) => ({
    ok: input.transport.kind === "stdio" && input.transport.command === "verified-mcp",
    message: input.transport.kind === "stdio" && input.transport.command === "verified-mcp" ? "MCP connected" : "Not an MCP server",
    checkedAt: 1, tools: [],
  }) });
  const verified = await svc.create(space, { name: "verified", transport: { kind: "stdio", command: "verified-mcp", args: [], envKeys: [] } });
  const there = await svc.create(space, { name: "node-echo", transport: { kind: "stdio", command: "node", args: [], envKeys: [] } });
  const gone = await svc.create(space, { name: "ghost", transport: { kind: "stdio", command: "definitely-not-a-real-binary-xyz", args: [], envKeys: [] } });

  const ok = await svc.test(space, there.id);
  assert.equal(ok.ok, false, "an executable by itself is not an MCP connection");
  assert.equal((await svc.test(space, verified.id)).ok, true);
  const bad = await svc.test(space, gone.id);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Not an MCP server/);
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

test("client settings: a server-owned section survives an ordinary blob write", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  svc.patchSection("usr_alice", "modelVisibility", {
    disabledProviders: ["ollama"],
    disabledModels: [],
    addedProviders: [],
  });
  // A client that does not carry the section must not delete it.
  svc.put("usr_alice", { product: { density: "balanced" } });
  assert.deepEqual(
    svc.get("usr_alice").settings.modelVisibility,
    { disabledProviders: ["ollama"], disabledModels: [], addedProviders: [] },
  );
  // Nor may a client clobber it by sending a stale copy.
  svc.put("usr_alice", {
    product: { density: "balanced" },
    modelVisibility: { disabledProviders: [], disabledModels: [], addedProviders: [] },
  });
  assert.deepEqual(
    svc.get("usr_alice").settings.modelVisibility,
    { disabledProviders: ["ollama"], disabledModels: [], addedProviders: [] },
    "the server copy stays authoritative",
  );
  // Other sections of the same write still land.
  assert.deepEqual(svc.get("usr_alice").settings.product, { density: "balanced" });
});

test("client settings: patchSection touches only its own key and bumps the revision", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  svc.put("usr_alice", { product: { density: "compact" }, modelPrefs: { favorites: ["opencode/x"] } });
  const before = svc.get("usr_alice");
  const after = svc.patchSection("usr_alice", "modelVisibility", { disabledProviders: ["a"], disabledModels: [], addedProviders: [] });
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.settings.product, { density: "compact" });
  assert.deepEqual(after.settings.modelPrefs, { favorites: ["opencode/x"] });
  assert.equal(svc.userIds().includes("usr_alice"), true);
});

test("client settings: a client cannot create a server-owned section", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  // A fresh client pushes its empty default before the server snapshot lands;
  // adopting it would erase the seed the account still inherits.
  svc.put("usr_alice", {
    product: { density: "balanced" },
    modelVisibility: { disabledProviders: [], disabledModels: [], addedProviders: [] },
  });
  assert.equal(svc.get("usr_alice").settings.modelVisibility, undefined);
  assert.deepEqual(svc.get("usr_alice").settings.product, { density: "balanced" });
});

test("client settings: patchSection with undefined removes the section", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  svc.put("usr_alice", { product: { density: "compact" } });
  svc.patchSection("usr_alice", "modelVisibility", { disabledProviders: ["a"], disabledModels: [], addedProviders: [] });
  svc.patchSection("usr_alice", "modelVisibility", undefined);
  assert.equal("modelVisibility" in svc.get("usr_alice").settings, false);
  assert.deepEqual(svc.get("usr_alice").settings.product, { density: "compact" });
});
