import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";
import {
  createCapabilityContributionRegistry,
  planHarnessCapabilities,
} from "@polyth/harness-runtime";
import { createClaudeProvisioner, claudeOverlays } from "@polyth/backend-claude";
import { createAcpProvisioner } from "@polyth/backend-acp";
import { createOpenCodeProvisioner, createConfigApplier, peekOpenCodeLaunchOverlay } from "@polyth/backend-opencode";
import type { BackendConfigApplier, McpApplyBatch } from "@polyth/backend-opencode";
import { createCodexProvisioner } from "../../backend-codex/src/provisioner.ts";
import { createBehaviorService } from "../src/behavior.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createAgentToolBridge, AGENT_TOOLS_MCP_PATH, AGENT_TOOLS_PATH } from "../src/agentTools.ts";
import { createPermissionService } from "@polyth/permissions";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-capb-"));
const spaceOf = (dir: string, id: string): SpaceContext => {
  mkdirSync(dir, { recursive: true });
  return {
    spaceId: id,
    spaceSlug: id,
    userId: "usr_test",
    role: "owner",
    deployment: "local-trusted",
    storageDir: dir,
  };
};

const provider = (id: string, apply: HarnessProvider["provisioner"]): HarnessProvider => ({
  descriptor: { id, name: id, priority: 0, integration: "test" },
  probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
  createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
  provisioner: apply,
});

const fakeRc = (grant: { token: string }, id: string, extra?: { loopback?: boolean }) => {
  let captured: { code: number; body: unknown } | undefined;
  return {
    captured: () => captured,
    rc: {
      path: AGENT_TOOLS_PATH,
      method: "POST",
      ingress: { kind: "public-http" as const, listenerId: "public", loopback: extra?.loopback !== false, secure: false },
      req: { headers: { authorization: `Bearer ${grant.token}` } },
      body: async () => ({ id, arguments: {} }),
      json: (code: number, body: unknown) => { captured = { code, body }; },
    },
  };
};

test("MCP secrets from Space A never appear in Space B desired or projection", async () => {
  const dataDir = tmp();
  const spaceA = spaceOf(join(dataDir, "a"), "spc_a");
  const spaceB = spaceOf(join(dataDir, "b"), "spc_b");
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(spaceA, {
    name: "linear",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["TOKEN_A"] },
    secrets: { TOKEN_A: "secret-a" },
  });
  await mcp.create(spaceB, {
    name: "linear",
    transport: { kind: "http", url: "https://b.example", headersSecretRefs: ["TOKEN_B"] },
    secrets: { TOKEN_B: "secret-b" },
  });
  assert.equal(mcp.list(spaceA).length, 1);
  assert.equal(mcp.list(spaceB).length, 1);
  assert.equal(mcp.list(spaceA)[0]?.name, "linear");
  assert.equal(mcp.projection(spaceA).secretsFor(mcp.list(spaceA)[0]!.id).TOKEN_A, "secret-a");
  assert.equal(mcp.projection(spaceB).secretsFor(mcp.list(spaceA)[0]!.id).TOKEN_A, undefined);
  assert.equal(mcp.projection(spaceB).secretsFor(mcp.list(spaceB)[0]!.id).TOKEN_B, "secret-b");

  const seen: Record<string, Record<string, string>> = {};
  const claude = provider("claude", {
    support: () => ({ harnessId: "claude", kinds: { "mcp-server": { modes: ["native"], mutability: "session-create" } } }),
    apply: async (_ctx, plan, secrets) => {
      for (const item of plan.items) {
        if (item.capability.kind === "mcp-server") seen[`${_ctx.spaceId}:${item.capability.id}`] = secrets.mcpSecrets(item.capability.id);
      }
      return {
        harnessId: "claude",
        desiredRevision: plan.desiredRevision,
        records: plan.items.map((item) => ({
          capabilityId: item.capability.id,
          kind: item.capability.kind,
          owner: item.capability.owner,
          desiredRevision: item.capability.revision,
          mode: item.mode,
          status: "pending" as const,
          mutability: item.mutability,
        })),
      };
    },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [claude], get: (id) => [claude].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => claude },
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  await controller.reconcile(claude, { spaceId: spaceA.spaceId, projectId: "p", cwd: "/tmp/p", space: spaceA });
  await controller.reconcile(claude, { spaceId: spaceB.spaceId, projectId: "p", cwd: "/tmp/p", space: spaceB });
  const desiredB = await controller.desired({ spaceId: spaceB.spaceId, projectId: "p", cwd: "/tmp/p", space: spaceB });
  assert.equal(desiredB.some((item) => item.kind === "mcp-server" && item.kind === "mcp-server" && JSON.stringify(item).includes("secret-a")), false);
  const bMcp = desiredB.find((item) => item.kind === "mcp-server" && item.name === "linear");
  assert.ok(bMcp);
  const aSecrets = Object.values(seen).find((row) => row.TOKEN_A);
  const bSecrets = Object.values(seen).find((row) => row.TOKEN_B);
  assert.equal(aSecrets?.TOKEN_A, "secret-a");
  assert.equal(bSecrets?.TOKEN_B, "secret-b");
  assert.equal(bSecrets?.TOKEN_A, undefined);
});

test("legacy global MCP migrates only into the default Space", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "mcp.json"), JSON.stringify([{
    id: "legacy",
    name: "linear",
    transport: { kind: "http", url: "https://legacy.example", headersSecretRefs: ["TOKEN"] },
    enabled: true,
    status: "starting",
    revision: 3,
  }]));
  writeFileSync(join(dataDir, "mcp-secrets.json"), JSON.stringify({ legacy: { TOKEN: "legacy-secret" } }));
  const defaultSpace = spaceOf(join(dataDir, "default"), "spc_default");
  const other = spaceOf(join(dataDir, "other"), "spc_other");
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: "spc_default" });
  assert.equal(mcp.list(defaultSpace)[0]?.name, "linear");
  assert.equal(mcp.projection(defaultSpace).secretsFor("legacy").TOKEN, "legacy-secret");
  assert.equal(mcp.list(other).length, 0);
  assert.equal(mcp.projection(other).secretsFor("legacy").TOKEN, undefined);
});

test("hosted deployments do not adopt legacy MCP into a Space", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "mcp.json"), JSON.stringify([{
    id: "legacy", name: "linear",
    transport: { kind: "http", url: "https://legacy.example", headersSecretRefs: [] },
    enabled: true, status: "starting", revision: 1,
  }]));
  const space = spaceOf(join(dataDir, "s"), "spc_default");
  const mcp = createMcpConfigService({ dataDir, deployment: "server-trusted", defaultSpaceId: "spc_default" });
  assert.equal(mcp.list(space).length, 0);
});

test("two sessions in the same project keep independent applied revisions", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const claude = createClaudeProvisioner();
  const harness = provider("claude", claude);
  const behavior = createBehaviorService({ file: join(dir, "behavior.md") });
  await behavior.put("rev-a", (await behavior.get()).revision);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior,
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const a = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const b = { ...a, sessionId: "sess-b" };
  const first = await controller.reconcile(harness, a);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude", sessionId: "sess-a" },
    desiredRevision: first.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "applied",
  });
  await behavior.put("rev-b", (await behavior.get()).revision);
  await controller.reconcile(harness, a);
  await controller.reconcile(harness, b);
  const statusA = controller.status(a, "claude")[0]!.records.find((row) => row.capabilityId === "polyth.behavior")!;
  const statusB = controller.status(b, "claude")[0]!.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(statusA.status, "pending");
  assert.equal(statusA.appliedRevision, first.records.find((row) => row.capabilityId === "polyth.behavior")!.desiredRevision);
  assert.equal(statusB.status, "pending");
  assert.equal(statusB.appliedRevision, undefined);
  assert.notEqual(statusA.desiredRevision, statusA.appliedRevision);
});

test("Claude staging stays pending until native initialization acknowledges the overlay", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const provisioner = createClaudeProvisioner();
  const harness = provider("claude", provisioner);
  const behavior = createBehaviorService({ file: join(dir, "behavior.md") });
  await behavior.put("rev1", (await behavior.get()).revision);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior,
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const first = await controller.reconcile(harness, ctx);
  const rec = first.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(rec.status, "pending");
  assert.equal(rec.appliedRevision, undefined);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude", sessionId: "sess-a" },
    desiredRevision: first.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "applied",
  });
  const applied = controller.status(ctx, "claude")[0]!.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedRevision, applied.desiredRevision);
  await behavior.put("rev2", (await behavior.get()).revision);
  const second = await controller.reconcile(harness, ctx);
  const pending = second.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.appliedRevision, applied.appliedRevision);
  assert.notEqual(pending.desiredRevision, pending.appliedRevision);
  const state = await controller.instructionState(ctx, "claude");
  assert.equal(state.provisioned, false);
});

test("MCP tombstones survive restart and block backend re-import", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  const created = await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  assert.equal(await mcp.remove(space, created.id), true);
  assert.equal(mcp.projection(space).tombstones.some((row) => row.name === "linear"), true);
  const restarted = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  assert.equal(restarted.list(space).length, 0);
  assert.equal(restarted.projection(space).tombstones.some((row) => row.name === "linear"), true);
  await assert.rejects(
    () => restarted.create(space, {
      name: "linear",
      transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
      origin: "backend-import",
    }),
    /must not be re-imported/,
  );
  const renamed = await restarted.create(space, {
    name: "linear-v2",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  await restarted.update(space, renamed.id, { name: "linear-v3" }, renamed.revision);
  const after = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  assert.equal(after.projection(space).tombstones.some((row) => row.name === "linear-v2"), true);
  assert.equal(after.list(space)[0]?.name, "linear-v3");
});

test("remote OpenCode reconcile does not call local config writers", async () => {
  let applyMcp = 0;
  let applyBehavior = 0;
  const applier = {
    applyBehavior: async () => { applyBehavior += 1; return 0; },
    applyMcp: async (_batch: McpApplyBatch) => { applyMcp += 1; },
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const result = await provisioner.apply(
    { spaceId: "s", projectId: "p", cwd: "/tmp/p", remote: true },
    {
      harnessId: "opencode",
      desiredRevision: "r",
      items: [{
        capability: {
          id: "polyth.behavior", kind: "instruction", owner: "polyth", scope: "deployment",
          revision: "1", text: "Be brief.",
        },
        mode: "config",
        mutability: "immediate",
      }],
    },
    { mcpSecrets: () => ({}) },
  );
  assert.equal(applyMcp, 0);
  assert.equal(applyBehavior, 0);
  assert.equal(result.records.every((row) => row.status === "unsupported"), true);
});

test("remote OpenCode reconcile mints a scoped HTTP tool bridge for SSH launch", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_remote");
  const cwd = "/home/dev/project";
  const registry = createCapabilityContributionRegistry();
  registry.register("browser", {
    descriptor: {
      id: "browser.polyth-browser",
      kind: "tool",
      owner: "browser",
      scope: "project",
      revision: "browser-r1",
      name: "polyth_browser",
      description: "Control the Polyth browser",
      inputSchema: { type: "object", properties: {} },
      trust: "workspace",
      mutating: true,
    },
    execute: async () => ({ output: "opened" }),
  });
  const tools = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const harness = provider("opencode", createOpenCodeProvisioner({
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { providers: () => [harness] } as never,
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({
      dataDir: dir,
      deployment: "local-trusted",
      defaultSpaceId: space.spaceId,
    }),
    file: join(dir, "status.json"),
    tools,
    toolsEndpoint: () => `http://127.0.0.1:43123${AGENT_TOOLS_PATH}`,
  });

  await controller.reconcile(harness, {
    spaceId: space.spaceId,
    projectId: "project-a",
    cwd,
    space,
    remote: true,
  });
  const overlay = peekOpenCodeLaunchOverlay({
    cwd,
    spaceId: space.spaceId,
    projectId: "project-a",
  });
  assert.ok(overlay);
  assert.equal(overlay.configContent, "");
  assert.equal(overlay.remoteMcp?.[0]?.url, `http://127.0.0.1:43123${AGENT_TOOLS_MCP_PATH}`);
  const authorization = overlay.remoteMcp?.[0]?.headers.Authorization;
  assert.match(authorization ?? "", /^Bearer [a-f0-9]{64}$/);
  assert.equal(JSON.stringify(overlay).includes(authorization!), true, "token is carried by the memory overlay passed to launch");
  assert.deepEqual(overlay.capabilityIds, ["polyth.agent-tools", "browser.polyth-browser"]);
  controller.dispose();
});

test("mutating tools require Polyth authorization before the executor runs", async () => {
  const registry = createCapabilityContributionRegistry();
  let called = 0;
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "space",
      revision: "1",
      name: "ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      trust: "pure",
      mutating: false,
    },
    execute: async () => { called += 1; return { output: "pong" }; },
  });
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.write",
      kind: "tool",
      owner: "example-feature",
      scope: "space",
      revision: "1",
      name: "write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      trust: "workspace",
      mutating: true,
    },
    execute: async () => { called += 1; return { output: "wrote" }; },
  });
  const dir = tmp();
  const permissions = createPermissionService(dir);
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
    authorize: (tool, grant) => {
      if (tool.trust === "pure" && tool.mutating === false) return "allow";
      const verdict = permissions.evaluate("package-tool", [tool.id], grant.projectId, grant.sessionId);
      if (verdict === "allow") return "allow";
      if (verdict === "deny") return "deny";
      return "permission-required";
    },
  });
  const tools = [
    registry.list().find((item) => item.descriptor.id === "example-feature.ping")!.descriptor,
    registry.list().find((item) => item.descriptor.id === "example-feature.write")!.descriptor,
  ] as Array<Extract<import("@polyth/contracts").AgentCapabilityDescriptor, { kind: "tool" }>>;
  const grant = bridge.mint({ spaceId: "s", projectId: "p", cwd: "/tmp", tools });
  const ping = fakeRc(grant, "example-feature.ping");
  assert.equal(await bridge.route(ping.rc as never), true);
  assert.equal(ping.captured()?.code, 200);
  assert.equal(called, 1);
  const write = fakeRc(grant, "example-feature.write");
  assert.equal(await bridge.route(write.rc as never), true);
  assert.equal(write.captured()?.code, 403);
  assert.equal((write.captured()?.body as { error: { code: string } }).error.code, "permission-required");
  assert.equal(called, 1);
  permissions.addRule({ permission: "package-tool", pattern: "example-feature.write", action: "allow", scope: "user" });
  const allowed = fakeRc(grant, "example-feature.write");
  assert.equal(await bridge.route(allowed.rc as never), true);
  assert.equal(allowed.captured()?.code, 200);
  assert.equal(called, 2);
  permissions.addRule({ permission: "package-tool", pattern: "example-feature.write", action: "deny", scope: "user" });
  const denied = fakeRc(grant, "example-feature.write");
  assert.equal(await bridge.route(denied.rc as never), true);
  assert.equal(denied.captured()?.code, 403);
  assert.equal(called, 2);
});

test("session release revokes tokens and drops overlays and volatile status", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "project",
      revision: "1",
      name: "ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      trust: "pure",
      mutating: false,
    },
    execute: async () => ({ output: "pong" }),
  });
  const tools = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const provisioner = createClaudeProvisioner();
  const harness = provider("claude", provisioner);
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
    tools,
    toolsEndpoint: () => "http://127.0.0.1:9/internal/agent-tools",
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  await controller.reconcile(harness, ctx);
  assert.ok(claudeOverlays.peek(ctx, "claude"));
  assert.ok(controller.status(ctx, "claude")[0]?.records.length);
  const env = claudeOverlays.peek(ctx, "claude")?.value.mcpServers?.["polyth-agent-tools"];
  const token = env && "env" in env ? env.env?.POLYTH_AGENT_TOOLS_TOKEN : undefined;
  assert.ok(token);
  controller.release(ctx);
  assert.equal(claudeOverlays.peek(ctx, "claude"), undefined);
  assert.equal(controller.status(ctx, "claude")[0]?.records.length, 0);
  const after = fakeRc({ token }, "example-feature.ping");
  assert.equal(await tools.route(after.rc as never), true);
  assert.equal(after.captured()?.code, 401);
});

test("failed native create keeps the staged overlay for retry", async () => {
  const ctx = { spaceId: "s", projectId: "p", cwd: "/tmp/p", sessionId: "sess" };
  const provisioner = createClaudeProvisioner();
  const plan = {
    harnessId: "claude",
    desiredRevision: "r1",
    items: [{
      capability: { id: "polyth.behavior", kind: "instruction" as const, owner: "polyth", scope: "deployment" as const, revision: "1", text: "Hi" },
      mode: "native" as const,
      mutability: "session-create" as const,
    }],
  };
  await provisioner.apply(ctx, plan, { mcpSecrets: () => ({}) });
  assert.equal(claudeOverlays.peek(ctx, "claude")?.value.append, "Hi");
  await provisioner.apply(ctx, plan, { mcpSecrets: () => ({}) });
  assert.equal(claudeOverlays.peek(ctx, "claude")?.value.append, "Hi");
  claudeOverlays.consume(ctx, "claude");
  assert.equal(claudeOverlays.peek(ctx, "claude"), undefined);
  await provisioner.apply(ctx, plan, { mcpSecrets: () => ({}) });
  assert.equal(claudeOverlays.peek(ctx, "claude")?.value.append, "Hi");
});

test("MCP native-name collisions and reserved names are deterministic", () => {
  const support = { harnessId: "claude", kinds: { "mcp-server": { modes: ["native"] as const, mutability: "session-create" as const } } };
  const plan = planHarnessCapabilities("claude", [
    { id: "polyth.mcp.1", kind: "mcp-server", owner: "polyth", scope: "space", revision: "1", name: "linear", enabled: true, transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } },
    { id: "example-feature.linear", kind: "mcp-server", owner: "example-feature", scope: "space", revision: "1", name: "linear", enabled: true, transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } },
  ], support, { remote: false });
  assert.equal(plan.items.every((item) => item.mode === "unsupported"), true);
  const registry = createCapabilityContributionRegistry();
  assert.throws(() => registry.register("example-feature", {
    descriptor: {
      id: "example-feature.tools",
      kind: "mcp-server",
      owner: "example-feature",
      scope: "space",
      revision: "1",
      name: "polyth-agent-tools",
      enabled: true,
      transport: { kind: "http", url: "https://x.example", headersSecretRefs: [] },
    },
  }), /reserved/);
});

test("OpenCode pending overlay does not claim the desired revision as applied", async () => {
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const cwd = tmp();
  const result = await provisioner.apply(
    { spaceId: "s", projectId: "p", cwd },
    {
      harnessId: "opencode",
      desiredRevision: "r",
      items: [{
        capability: {
          id: "polyth.mcp.1", kind: "mcp-server", owner: "polyth", scope: "space", revision: "abc",
          name: "linear", enabled: true, transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
        },
        mode: "config",
        mutability: "requires-restart",
      }],
    },
    { mcpSecrets: () => ({}) },
  );
  const rec = result.records[0]!;
  assert.equal(rec.status, "pending");
  assert.equal(rec.appliedRevision, undefined);
  assert.equal(existsSync(join(cwd, ".opencode", "opencode.json")), false);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: "s", projectId: "p" });
  assert.ok(overlay);
  assert.match(overlay.configContent, /linear/);
});

test("pending desired revision is not treated as provisioned for audit", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const harness = provider("claude", createClaudeProvisioner());
  const behavior = createBehaviorService({ file: join(dir, "behavior.md") });
  await behavior.put("rev1", (await behavior.get()).revision);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior,
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const first = await controller.reconcile(harness, ctx);
  assert.equal((await controller.instructionState(ctx, "claude")).provisioned, false);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude", sessionId: "sess-a" },
    desiredRevision: first.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "applied",
  });
  const live = await controller.instructionState(ctx, "claude");
  assert.equal(live.provisioned, true);
  assert.equal(live.verification, "applied");
  await behavior.put("rev2", (await behavior.get()).revision);
  const stale = await controller.instructionState(ctx, "claude");
  assert.equal(stale.provisioned, false);
});

test("recreating a native target does not trust the previous applied generation", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const harness = provider("claude", createClaudeProvisioner());
  const behavior = createBehaviorService({ file: join(dir, "behavior.md") });
  await behavior.put("stable", (await behavior.get()).revision);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior,
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude", sessionId: "sess-a" },
    desiredRevision: first.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "applied",
  });
  const recreated = await controller.reconcile(harness, ctx);
  const pending = recreated.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(pending.status, "pending");
  assert.equal((await controller.instructionState(ctx, "claude")).provisioned, false);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude", sessionId: "sess-a", authorityId: "gen-2", generation: 2 },
    desiredRevision: recreated.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "applied",
  });
  assert.equal((await controller.instructionState(ctx, "claude")).provisioned, true);
});

test("ACP and Codex stay pending until native create is acknowledged as unverifiable", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const acp = provider("cursor", createAcpProvisioner("cursor"));
  const codex = provider("codex", createCodexProvisioner());
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "stdio", command: "npx", args: ["-y", "linear-mcp"], envKeys: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [acp, codex], get: (id) => [acp, codex].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => acp },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const acpStatus = await controller.reconcile(acp, ctx);
  const acpMcp = acpStatus.records.find((row) => row.kind === "mcp-server")!;
  assert.equal(acpMcp.status, "pending");
  assert.equal(acpMcp.appliedRevision, undefined);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "cursor", sessionId: "sess-a" },
    desiredRevision: acpStatus.desiredRevision,
    capabilityIds: [acpMcp.capabilityId],
    outcome: "unverifiable",
  });
  assert.equal(controller.status(ctx, "cursor")[0]!.records.find((row) => row.capabilityId === acpMcp.capabilityId)!.status, "unverifiable");
  const codexStatus = await controller.reconcile(codex, ctx);
  const instruction = codexStatus.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(instruction.status, "pending");
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "codex", sessionId: "sess-a" },
    desiredRevision: codexStatus.desiredRevision,
    capabilityIds: ["polyth.behavior"],
    outcome: "unverifiable",
  });
  const verified = await controller.instructionState(ctx, "codex");
  assert.equal(verified.provisioned, true);
  assert.equal(verified.verification, "unverifiable");
});

test("OpenCode MCP deletion survives a read-only projector and restart", async () => {
  const configDir = tmp();
  const dataDir = tmp();
  const projectDir = tmp();
  const space = spaceOf(join(dataDir, "space"), "spc_a");
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, JSON.stringify({
    mcp: { linear: { type: "remote", url: "https://linear.example", enabled: true } },
  }));
  let authority: { kind: "read-only" } | { kind: "writable"; targetId: string } = { kind: "read-only" };
  const inner = createConfigApplier({ configDir, authority: () => authority });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  const created = await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
    origin: "backend-import",
  });
  const harness = provider("opencode", createOpenCodeProvisioner(inner));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: projectDir, space };
  assert.equal(await mcp.remove(space, created.id), true);
  assert.equal(mcp.projection(space).tombstones.some((row) => row.name === "linear"), true);
  const pending = await controller.reconcile(harness, ctx);
  assert.equal(pending.records.find((row) => row.capabilityId.startsWith("polyth.mcp.retired."))?.status, "applied");
  assert.match(readFileSync(configFile, "utf8"), /linear/);
  const restartedMcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  assert.equal(restartedMcp.list(space).length, 0);
  assert.equal(restartedMcp.projection(space).tombstones.some((row) => row.name === "linear"), true);
  await assert.rejects(
    () => restartedMcp.create(space, {
      name: "linear",
      transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
      origin: "backend-import",
    }),
    /must not be re-imported/,
  );
  authority = { kind: "writable", targetId: configFile };
  const live = provider("opencode", createOpenCodeProvisioner(createConfigApplier({
    configDir,
    authority: () => authority,
  })));
  const liveController = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [live], get: (id) => [live].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => live },
    behavior: createBehaviorService({ file: join(dataDir, "behavior2.md") }),
    mcp: restartedMcp,
    file: join(dataDir, "status2.json"),
  });
  await liveController.reconcile(live, ctx);
  const global = JSON.parse(readFileSync(configFile, "utf8")) as { mcp?: Record<string, unknown> };
  assert.ok(global.mcp && "linear" in global.mcp, "user global MCP is not deleted by name");
  const overlay = peekOpenCodeLaunchOverlay({ cwd: projectDir, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlay, "empty overlay still admits the current desired bundle");
  assert.deepEqual(overlay.capabilityIds, []);
  assert.equal(overlay.configContent, "");
  await assert.rejects(
    () => restartedMcp.create(space, {
      name: "linear",
      transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
      origin: "backend-import",
    }),
    /must not be re-imported/,
  );
});

test("OpenCode spawn receipt promotes pending overlay without rewriting appliedRevision early", async () => {
  const dir = tmp();
  const space = spaceOf(dir, "spc_a");
  const cwd = tmp();
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const harness = provider("opencode", createOpenCodeProvisioner(applier as BackendConfigApplier));
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const staged = await controller.reconcile(harness, ctx);
  const rec = staged.records.find((row) => row.kind === "mcp-server")!;
  assert.equal(rec.status, "pending");
  assert.equal(rec.appliedRevision, undefined);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode" },
    desiredRevision: staged.desiredRevision,
    capabilityIds: [rec.capabilityId],
    outcome: "applied",
    evidence: { stage: "connected", source: "test:simulated-native-connection" },
  });
  const after = controller.status(ctx, "opencode")[0]!.records.find((row) => row.capabilityId === rec.capabilityId)!;
  assert.equal(after.status, "applied");
  assert.equal(after.appliedRevision, rec.desiredRevision);
});
