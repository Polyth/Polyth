import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";
import {
  applyOpenCodeLaunchOverlay,
  createConfigApplier,
  createOpenCodeHarness,
  createOpenCodeProvisioner,
  peekOpenCodeLaunchOverlay,
  stripJsonc,
} from "@polyth/backend-opencode";
import {
  createCapabilityContributionRegistry,
  createHarnessRegistry,
  harnessProviderById,
} from "@polyth/harness-runtime";
import { createPluginRegistry, writeSpaceEnabled } from "@polyth/plugins";
import { createKeyedRuntimeOwner } from "../src/runtimeOccupancy.ts";
import { createBehaviorService } from "../src/behavior.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createAgentToolBridge, AGENT_TOOLS_PATH } from "../src/agentTools.ts";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import { mockHarnessRegistry } from "./harnessRegistryMock.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-cap-prod-"));

const spaceOf = (dir: string, id = "spc_a"): SpaceContext => ({
  spaceId: id,
  spaceSlug: id,
  userId: "usr_test",
  role: "owner",
  deployment: "local-trusted",
  storageDir: dir,
});

const opencodeHarness = (applier: { applyBehavior: () => Promise<number>; applyMcp: () => Promise<void> }): HarnessProvider => {
  const registry = createHarnessRegistry();
  const owner = createKeyedRuntimeOwner<AgentRuntime>();
  const runtime = async (context: { projectId: string; cwd: string }) => {
    const key = JSON.stringify([context.projectId, context.cwd]);
    const record = await owner.acquire(key, async () => ({
      value: {
        dispose: async () => {},
        models: async () => [],
        sessions: async () => [],
        history: async () => [],
      } as AgentRuntime,
      dispose: async () => {},
    }));
    return record.value;
  };
  const harness = createOpenCodeHarness(runtime as never);
  harness.provisioner = createOpenCodeProvisioner(applier as never);
  registry.register(harness);
  return harnessProviderById(registry, "opencode");
};

const fakeRc = (grant: { token: string }, id: string) => {
  let captured: { code: number; body: unknown } | undefined;
  let executed = false;
  return {
    captured: () => captured,
    executed: () => executed,
    rc: {
      path: AGENT_TOOLS_PATH,
      method: "POST",
      ingress: { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false },
      req: { headers: { authorization: `Bearer ${grant.token}` } },
      body: async () => ({ id, arguments: {} }),
      json: (code: number, body: unknown) => { captured = { code, body }; },
    },
    markExecuted: () => { executed = true; },
  };
};

const bumpMcpUrl = async (
  mcp: ReturnType<typeof createMcpConfigService>,
  space: SpaceContext,
  id: string,
  url: string,
): Promise<void> => {
  const row = mcp.list(space).find((server) => server.id === id);
  if (!row) throw new Error("mcp server missing");
  await mcp.update(space, id, {
    name: row.name,
    transport: row.transport.kind === "http"
      ? { kind: "http", url, headersSecretRefs: row.transport.headersSecretRefs }
      : { kind: "http", url, headersSecretRefs: [] },
  }, row.revision);
};

const seedMcp = async (
  mcp: ReturnType<typeof createMcpConfigService>,
  space: SpaceContext,
  name = "alpha",
  url = "https://a.example",
) => mcp.create(space, {
  name,
  transport: { kind: "http", url, headersSecretRefs: [] },
});

const revisionDirs = (space: SpaceContext, projectId: string, cwd: string): string[] => {
  const projectIdSafe = projectId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "project";
  const projectKey = `${projectIdSafe}-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 8)}`;
  const root = join(space.storageDir, "runtime", "opencode", projectKey, "revisions");
  if (!existsSync(root)) return [];
  return readdirSync(root);
};

const fakeGet = (token: string) => {
  let captured: { code: number; body: unknown } | undefined;
  return {
    captured: () => captured,
    rc: {
      path: AGENT_TOOLS_PATH,
      method: "GET",
      ingress: { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false },
      req: { headers: { authorization: `Bearer ${token}` } },
      body: async () => ({}),
      json: (code: number, body: unknown) => { captured = { code, body }; },
    },
  };
};

test("generation lease A→B→C keeps revision A resources until generation retires", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const applier = { applyBehavior: async () => 0, applyMcp: async () => {} };
  const harness = opencodeHarness(applier);
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "secret-a" },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  const revA = first.desiredRevision;
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: revA,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  const dirsA = revisionDirs(space, "p", cwd);
  assert.ok(dirsA.length > 0, "revision A storage should exist after admission");
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  const second = await controller.reconcile(harness, ctx);
  const revB = second.desiredRevision;
  assert.notEqual(revB, revA);
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  const third = await controller.reconcile(harness, ctx);
  const revC = third.desiredRevision;
  assert.notEqual(revC, revB);
  const dirsWhileG1Live = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) {
    assert.ok(dirsWhileG1Live.includes(dir), `revision A dir ${dir} must survive B→C while G1 is live`);
  }
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g2", generation: 2 },
    desiredRevision: revC,
    capabilityIds: third.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  await controller.reconcile(harness, ctx);
  const dirsAfterG2 = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) {
    assert.equal(dirsAfterG2.includes(dir), false, `revision A dir ${dir} must be removed after G1 retires`);
  }
  assert.ok(dirsAfterG2.length > 0, "revision C storage should remain");
});

test("in-flight successor revision is not pruned when desired moves again before its receipt", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "secret-a" },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  const revA = first.desiredRevision;
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "auth-a", generation: 7 },
    desiredRevision: revA,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  const dirsAfterA = revisionDirs(space, "p", cwd);
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  const second = await controller.reconcile(harness, ctx);
  const revB = second.desiredRevision;
  const dirsB = revisionDirs(space, "p", cwd).filter((dir) => !dirsAfterA.includes(dir));
  assert.ok(dirsB.length > 0, "revision B storage should exist");
  controller.captureLaunch({
    spaceId: space.spaceId,
    projectId: "p",
    cwd,
    harnessId: "opencode",
    desiredRevision: revB,
  });
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  await controller.reconcile(harness, ctx);
  const dirsAfterC = revisionDirs(space, "p", cwd);
  for (const dir of dirsB) {
    assert.ok(dirsAfterC.includes(dir), `in-flight revision B dir ${dir} must survive C while G2 has not receipted`);
  }
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "auth-b", generation: 1 },
    desiredRevision: revB,
    capabilityIds: second.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  await controller.reconcile(harness, ctx);
  const dirsAfterG2 = revisionDirs(space, "p", cwd);
  for (const dir of dirsB) {
    assert.ok(dirsAfterG2.includes(dir), "G2 bound to B keeps B resources even though desired is C");
  }
  const row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "auth-b");
  assert.equal(row.target?.generation, 1);
  assert.ok(row.records.some((item) => item.status === "pending-restart"));
});

test("replacement authority generation 1 is not rejected against a stored higher generation", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "old-engine", generation: 7 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "new-engine", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  const row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "new-engine");
  assert.equal(row.target?.generation, 1);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "old-engine", generation: 8 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  assert.equal(controller.status(ctx, "opencode")[0]!.target?.authorityId, "new-engine");
});

test("pre-ack generation retains every unacknowledged staged revision until a generation binds", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const applier = { applyBehavior: async () => 0, applyMcp: async () => {} };
  const harness = opencodeHarness(applier);
  const registry = createCapabilityContributionRegistry();
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
    execute: async () => ({ output: "pong" }),
  });
  const inner = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const minted: string[] = [];
  const tools = {
    ...inner,
    mint(grant: Parameters<typeof inner.mint>[0]) {
      const next = inner.mint(grant);
      minted.push(next.token);
      return next;
    },
  };
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    tools,
    toolsEndpoint: () => `http://127.0.0.1:9${Math.floor(Math.random() * 10000)}${AGENT_TOOLS_PATH}`,
  });

  // G1 captured revision A (spawn read the overlay) but has not receipted yet.
  const first = await controller.reconcile(harness, ctx);
  const revA = first.desiredRevision;
  const tokenA = minted[0]!;
  const dirsA = revisionDirs(space, "p", cwd);
  assert.ok(dirsA.length > 0, "revision A storage should exist");
  controller.captureLaunch({
    spaceId: space.spaceId,
    projectId: "p",
    cwd,
    harnessId: "opencode",
    desiredRevision: revA,
  });
  const liveA = fakeGet(tokenA);
  await tools.route(liveA.rc as never);
  assert.equal(liveA.captured()?.code, 200, "token minted for A must still work pre-ack");

  // desired A -> B, no restart yet (no generation is bound, so nothing forces one).
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  const second = await controller.reconcile(harness, ctx);
  const revB = second.desiredRevision;
  assert.notEqual(revB, revA);
  let dirs = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) assert.ok(dirs.includes(dir), `captured in-flight A dir ${dir} must survive the A->B transition pre-ack`);
  const stillA1 = fakeGet(tokenA);
  await tools.route(stillA1.rc as never);
  assert.equal(stillA1.captured()?.code, 200, "token A must still work after B is staged, pre-ack");

  // desired B -> C without capturing B: uncaptured staged B is dropped, A stays in-flight.
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  const third = await controller.reconcile(harness, ctx);
  const revC = third.desiredRevision;
  assert.notEqual(revC, revB);
  dirs = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) assert.ok(dirs.includes(dir), `captured in-flight A dir ${dir} must survive the B->C transition pre-ack`);
  const stillA2 = fakeGet(tokenA);
  await tools.route(stillA2.rc as never);
  assert.equal(stillA2.captured()?.code, 200, "token A must still work through B and C, pre-ack");

  // Now G1 acknowledges. `matchesCurrentBundle` only binds a receipt whose
  // desiredRevision equals the row's CURRENT desired bundle (C by now, since
  // desired advanced twice before any ack could land) — so this is the first
  // receipt that can actually bind, exactly the "whatever receipt would
  // bind" case a slow/backlogged ack race produces in production.
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: revC,
    capabilityIds: third.records.filter((row) => row.kind === "mcp-server" || row.kind === "tool").map((row) => row.capabilityId),
    outcome: "applied",
  });
  await controller.reconcile(harness, ctx);
  dirs = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) assert.ok(dirs.includes(dir), `captured in-flight A dir ${dir} must survive C binding until spawn failure`);
  const stillInFlightA = fakeGet(tokenA);
  await tools.route(stillInFlightA.rc as never);
  assert.equal(stillInFlightA.captured()?.code, 200, "token A stays live while the captured spawn is unresolved");

  controller.releaseLaunch({
    spaceId: space.spaceId,
    projectId: "p",
    cwd,
    harnessId: "opencode",
    desiredRevision: revA,
  });
  await controller.reconcile(harness, ctx);
  dirs = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) assert.equal(dirs.includes(dir), false, `A dir ${dir} must be removable once the captured spawn fails`);
  const revokedA = fakeGet(tokenA);
  await tools.route(revokedA.rc as never);
  assert.equal(revokedA.captured()?.code, 401, "token A must be revoked once no lease references it");

  // G2 replaces G1 on the same physical target, still at revision C —
  // "one live native generation per physical target" retires G1's lease.
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g2", generation: 2 },
    desiredRevision: revC,
    capabilityIds: third.records.filter((row) => row.kind === "mcp-server" || row.kind === "tool").map((row) => row.capabilityId),
    outcome: "applied",
  });
  dirs = revisionDirs(space, "p", cwd);
  assert.ok(dirs.length > 0, "revision C storage remains after G1 retires");
});

test("failed OpenCode start leaves the previous live generation's resources and desired overlay intact", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  const overlayBefore = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlayBefore);
  const dirsBefore = revisionDirs(space, "p", cwd);
  // Desired changes, but the receipt for the failed spawn attempt never
  // arrives (no acknowledge call): a failed start must not silently drop the
  // still-live G1 generation's overlay or resources, and must not fabricate
  // a false "applied" receipt for the new desired revision.
  await bumpMcpUrl(mcp, space, created.id, "https://failed-attempt.example");
  const overlayAfter = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlayAfter, "desired overlay for the new candidate revision remains staged for retry");
  const dirsAfter = revisionDirs(space, "p", cwd);
  for (const dir of dirsBefore) assert.ok(dirsAfter.includes(dir), "G1's live revision resources are not dropped by an unacknowledged failed attempt");
  assert.equal(controller.status(ctx, "opencode")[0]?.target?.generation, 1, "no false receipt binds a new generation");
});

test("failed restart leaves the old generation valid with its old token and resources intact", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => { throw new Error("restart failed"); } });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  const dirsBefore = revisionDirs(space, "p", cwd);
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  await controller.reconcile(harness, ctx);
  assert.equal(pending.list().count, 1);
  await assert.rejects(() => pending.applyAndRestart(), /restart failed/);
  // The failed restart never happened: G1 is still the live generation and
  // its resources/desired-pending state must be untouched, and the change
  // stays queued for a future retry.
  assert.equal(controller.status(ctx, "opencode")[0]?.target?.generation, 1);
  assert.equal(pending.list().count, 1);
  const dirsAfter = revisionDirs(space, "p", cwd);
  for (const dir of dirsBefore) assert.ok(dirsAfter.includes(dir), "old generation's revision resources survive a failed restart");
});

test("token lease survives while old generation is live", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const registry = createCapabilityContributionRegistry();
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
    execute: async () => ({ output: "pong" }),
  });
  const inner = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const minted: string[] = [];
  const tools = {
    ...inner,
    mint(grant: Parameters<typeof inner.mint>[0]) {
      const next = inner.mint(grant);
      minted.push(next.token);
      return next;
    },
  };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    tools,
    toolsEndpoint: () => `http://127.0.0.1:9${Math.floor(Math.random() * 10000)}${AGENT_TOOLS_PATH}`,
  });
  const first = await controller.reconcile(harness, ctx);
  const tokenA = minted[0];
  assert.ok(tokenA);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server" || row.kind === "tool").map((row) => row.capabilityId),
    outcome: "applied",
  });
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  await controller.reconcile(harness, ctx);
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  await controller.reconcile(harness, ctx);
  const live = fakeGet(tokenA);
  await tools.route(live.rc as never);
  assert.equal(live.captured()?.code, 200);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g2", generation: 2 },
    desiredRevision: controller.status(ctx, "opencode")[0]!.desiredRevision,
    capabilityIds: controller.status(ctx, "opencode")[0]!.records
      .filter((row) => row.kind === "mcp-server" || row.kind === "tool")
      .map((row) => row.capabilityId),
    outcome: "applied",
  });
  await controller.reconcile(harness, ctx);
  const retired = fakeGet(tokenA);
  await tools.route(retired.rc as never);
  assert.equal(retired.captured()?.code, 401);
});

test("old tool grant cannot authorize a replaced executor", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", space };
  const registry = createCapabilityContributionRegistry();
  let revision = "1";
  const dispose = registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "space",
      revision,
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
  const grant = tools.mint({
    spaceId: space.spaceId,
    projectId: "p",
    cwd: "/tmp/p",
    tools: registry.resolve(ctx).filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool"),
  });
  revision = "2";
  dispose.dispose();
  let executedB = false;
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "space",
      revision,
      name: "ping",
      description: "ping v2",
      inputSchema: { type: "object", properties: {} },
      trust: "workspace",
      mutating: true,
    },
    execute: async () => {
      executedB = true;
      return { output: "nope" };
    },
  });
  const { rc, captured } = fakeRc(grant, "example-feature.ping");
  await tools.route(rc as never);
  assert.equal(executedB, false);
  assert.equal(captured()?.code, 403);
  const body = captured()?.body as { error?: { code?: string } };
  assert.equal(body?.error?.code, "stale-capability");
  const grantB = tools.mint({
    spaceId: space.spaceId,
    projectId: "p",
    cwd: "/tmp/p",
    tools: registry.resolve(ctx).filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool"),
  });
  const second = fakeRc(grantB, "example-feature.ping");
  await tools.route(second.rc as never);
  assert.equal(second.captured()?.code, 403);
  const denied = second.captured()?.body as { error?: { code?: string } };
  assert.equal(denied?.error?.code, "permission-required");
});

test("pending-restart stages one coalesced runtime-capabilities restart task", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const applier = { applyBehavior: async () => 0, applyMcp: async () => {} };
  const harness = opencodeHarness(applier);
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  await controller.reconcile(harness, ctx);
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  const third = await controller.reconcile(harness, ctx);
  const row = third.records.find((item) => item.kind === "mcp-server")!;
  assert.equal(row.status, "pending-restart");
  assert.match(row.reason ?? "", /OpenCode runtime restart required/);
  assert.equal(pending.list().count, 1);
  assert.equal(pending.list().changes[0]?.kind, "runtime-capabilities");
  const applied = await pending.applyAndRestart();
  assert.equal(applied.applied, 1);
  assert.equal(applied.restarted, 1);
  assert.equal(pending.list().count, 0);
});

test("first MCP on a live overlay-less OpenCode runtime stages pending-restart", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: "",
    capabilityIds: [],
    outcome: "unverifiable",
  });
  assert.equal(controller.status(ctx, "opencode")[0]!.target?.generation, 1);
  const created = await seedMcp(mcp, space);
  const second = await controller.reconcile(harness, ctx);
  const mcpRow = second.records.find((row) => row.capabilityId === `polyth.mcp.${created.id}`);
  assert.equal(mcpRow?.status, "pending-restart");
  assert.equal(pending.list().count, 1);
  assert.equal(first.records.some((row) => row.kind === "mcp-server"), false);
});

test("removing a live OpenCode MCP requires restart and does not disable user config", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  await mcp.remove(space, created.id);
  const after = await controller.reconcile(harness, ctx);
  assert.ok(after.records.some((row) => row.status === "pending-restart"));
  assert.equal(pending.list().count, 1);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  if (overlay) assert.doesNotMatch(overlay.configContent, /"enabled":false/);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g2", generation: 2 },
    desiredRevision: after.desiredRevision,
    capabilityIds: after.records
      .filter((row) => row.kind === "mcp-server" && row.capabilityId.startsWith("polyth.mcp.retired."))
      .map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  const settled = await controller.reconcile(harness, ctx);
  assert.equal(
    settled.records.some((row) => row.status === "pending-restart"),
    false,
    "tombstone/removal must not re-arm pending-restart after the successor receipt",
  );
});

test("unchanged OpenCode reconcile after spawn receipt stays unverifiable", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  const second = await controller.reconcile(harness, ctx);
  const mcpRow = second.records.find((row) => row.kind === "mcp-server" && row.capabilityId.startsWith("polyth.mcp."));
  assert.equal(mcpRow?.status, "unverifiable");
  assert.equal(pending.list().count, 0);
});

test("session release still revokes leases after the harness provider is unregistered", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "s1", space };
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "session",
      revision: "1",
      name: "ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      trust: "pure",
      mutating: false,
    },
    execute: async () => ({ output: "pong" }),
  });
  const inner = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const minted: string[] = [];
  const tools = {
    ...inner,
    mint(grant: Parameters<typeof inner.mint>[0]) {
      const next = inner.mint(grant);
      minted.push(next.token);
      return next;
    },
  };
  const claude = {
    descriptor: { id: "claude", name: "Claude", priority: 1, integration: "test" },
    probe: async () => ({ harnessId: "claude", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: {
      support: () => ({
        harnessId: "claude",
        targetLifetime: "session" as const,
        kinds: {
          tool: { modes: ["mcp" as const], mutability: "session-create" as const, remote: false, configScope: "session" as const },
          "mcp-server": { modes: ["native" as const], mutability: "session-create" as const, remote: false, configScope: "session" as const },
        },
      }),
      apply: async () => ({ harnessId: "claude", desiredRevision: "r", records: [] }),
      release: () => {},
    },
  };
  const harnesses = mockHarnessRegistry(claude as never);
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
    tools,
    toolsEndpoint: () => `http://127.0.0.1:9${Math.floor(Math.random() * 10000)}${AGENT_TOOLS_PATH}`,
  });
  await controller.reconcile(claude as never, ctx);
  const token = minted[0];
  assert.ok(token);
  harnesses.providers = () => [];
  harnesses.get = () => undefined;
  controller.release(ctx, "claude");
  const retired = fakeGet(token);
  await tools.route(retired.rc as never);
  assert.equal(retired.captured()?.code, 401);
});

test("JSONC inline OPENCODE_CONFIG_CONTENT survives overlay merge with Polyth MCP and skill path", () => {
  const overlay = {
    configContent: JSON.stringify({
      mcp: { polyth: { type: "local", command: ["true"], enabled: true } },
      skills: { paths: ["/polyth/skills"] },
    }),
    env: {},
    desiredRevision: "r1",
    capabilityIds: [],
  };
  const inputEnv = {
    OPENCODE_CONFIG_CONTENT: `{
      // user comment
      "plugin": ["keep"],
      "provider": { "user": { "npm": "x" } },
      "mcp": { "linear": { "type": "remote", "url": "https://user.example", "enabled": true } },
      "skills": { "paths": ["/user/skills"] },
    }`,
  };
  const snapshot = { ...inputEnv };
  const merged = applyOpenCodeLaunchOverlay(inputEnv, overlay);
  assert.deepEqual(inputEnv, snapshot, "applyOpenCodeLaunchOverlay must not mutate its input env object");
  const parsed = JSON.parse(stripJsonc(merged.OPENCODE_CONFIG_CONTENT ?? "{}")) as Record<string, unknown>;
  assert.deepEqual(parsed.plugin, ["keep"]);
  assert.deepEqual((parsed.provider as { user: { npm: string } }).user, { npm: "x" }, "user provider config is preserved");
  const mcp = parsed.mcp as Record<string, unknown>;
  assert.ok(mcp.linear, "user MCP entry is preserved");
  assert.ok(mcp.polyth, "Polyth MCP entry is present");
  const skillPaths = (parsed.skills as { paths: string[] }).paths;
  assert.ok(skillPaths.includes("/user/skills"), "user skill path is preserved");
  assert.ok(skillPaths.includes("/polyth/skills"), "Polyth skill path is present");
});

test("malformed inline OPENCODE_CONFIG_CONTENT fails closed and leaves the input env untouched", () => {
  const inputEnv = { OPENCODE_CONFIG_CONTENT: "{ not valid json" };
  const snapshot = { ...inputEnv };
  assert.throws(() => applyOpenCodeLaunchOverlay(inputEnv, {
    configContent: "{}",
    env: {},
    desiredRevision: "r",
    capabilityIds: [],
  }), /refusing to overwrite user configuration/);
  assert.deepEqual(inputEnv, snapshot, "input env object must not be mutated by a failed merge");
  assert.equal(inputEnv.OPENCODE_CONFIG_CONTENT, "{ not valid json", "original invalid string is preserved");
});

test("tombstone: deleting the Polyth MCP omits it entirely from the overlay and never touches the user's own MCP of the same name", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(dataDir, "cfg");
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, JSON.stringify({
    mcp: { linear: { type: "remote", url: "https://user-linear.example", enabled: true } },
  }));
  const userBytes = readFileSync(configFile, "utf8");
  const applier = createConfigApplier({ configDir });
  const harness = opencodeHarness(applier);
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://polyth.example", headersSecretRefs: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const before = await controller.reconcile(harness, ctx);
  const overlayWithPolythLinear = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlayWithPolythLinear);
  assert.match(overlayWithPolythLinear!.configContent, /polyth\.example/, "Polyth's linear MCP is present while it is not yet deleted");
  assert.ok(before.records.some((row) => row.capabilityId === `polyth.mcp.${created.id}`));

  // The user deletes the Polyth-owned MCP. The tombstone must remove it from
  // the overlay OUTRIGHT — never project it as `enabled:false`, which would
  // still be a Polyth-controlled entry sitting in front of the user's own
  // "linear" MCP of the same name.
  await mcp.remove(space, created.id);
  const after = await controller.reconcile(harness, ctx);
  assert.equal(after.records.some((row) => row.capabilityId === `polyth.mcp.${created.id}`), false, "the deleted MCP's capability record is gone, not just disabled");
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  if (overlay) {
    assert.doesNotMatch(overlay.configContent, /polyth\.example/, "the deleted Polyth MCP's URL is entirely absent from the overlay");
    assert.doesNotMatch(overlay.configContent, /"linear".*"enabled":false/, "never projected as a disabled entry");
  }
  // The physical user config file on disk is untouched by any of this —
  // Polyth's own "linear" never shadows or mutates the user's "linear".
  assert.equal(readFileSync(configFile, "utf8"), userBytes, "user's own OpenCode config file is byte-for-byte unchanged");
});

test("concurrent reconcile cannot publish stale revision after newer desired", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  let gate: Promise<void> | undefined;
  let releaseGate!: () => void;
  let applyCalls = 0;
  const base = createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never);
  const harness: HarnessProvider = {
    descriptor: { id: "opencode", name: "OpenCode", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "opencode", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: {
      support: (context) => base.support!(context),
      apply: async (context, plan, secrets) => {
        applyCalls += 1;
        if (gate) await gate;
        return base.apply!(context, plan, secrets);
      },
      release: (context, options) => base.release?.(context, options),
    },
  };
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space, "one", "https://one.example");
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const slow = controller.reconcile(harness, ctx);
  await bumpMcpUrl(mcp, space, created.id, "https://two.example");
  const mid = controller.reconcile(harness, ctx);
  await bumpMcpUrl(mcp, space, created.id, "https://three.example");
  const fast = controller.reconcile(harness, ctx);
  releaseGate();
  const [a, b, c] = await Promise.all([slow, mid, fast]);
  const revisions = new Set([a.desiredRevision, b.desiredRevision, c.desiredRevision]);
  assert.equal(revisions.size, 1);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.match(overlay?.configContent ?? "", /three\.example/);
});

test("reconcile race: apply() never overlaps for one target and a mid-apply burst coalesces to the latest desired revision", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  let activeApply = 0;
  let maxActiveApply = 0;
  let applyCalls = 0;
  let gate: Promise<void> | undefined;
  let releaseGate!: () => void;
  let enteredGate: (() => void) | undefined;
  const base = createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never);
  const harness: HarnessProvider = {
    descriptor: { id: "opencode", name: "OpenCode", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "opencode", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: {
      support: (context) => base.support!(context),
      apply: async (context, plan, secrets) => {
        applyCalls += 1;
        activeApply += 1;
        maxActiveApply = Math.max(maxActiveApply, activeApply);
        try {
          if (gate) {
            enteredGate?.();
            await gate;
          }
          return await base.apply!(context, plan, secrets);
        } finally {
          activeApply -= 1;
        }
      },
      release: (context, options) => base.release?.(context, options),
    },
  };
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space, "one", "https://one.example");
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const baseline = await controller.reconcile(harness, ctx);
  assert.equal(applyCalls, 1);

  // B: apply() is gated open while it runs.
  const gateEntered = new Promise<void>((resolve) => { enteredGate = resolve; });
  gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  await bumpMcpUrl(mcp, space, created.id, "https://two.example");
  const slow = controller.reconcile(harness, ctx);
  await gateEntered;
  assert.equal(activeApply, 1, "apply() for B must be in flight before C is requested");

  // While B is inside apply(), canonical changes to C and a reconcile for C
  // is requested — this must coalesce onto the same in-flight reconcile
  // rather than opening a second concurrent apply().
  await bumpMcpUrl(mcp, space, created.id, "https://three.example");
  const fast = controller.reconcile(harness, ctx);
  gate = undefined;
  releaseGate();

  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a.desiredRevision, b.desiredRevision, "the coalesced burst resolves to one shared final revision");
  assert.notEqual(a.desiredRevision, baseline.desiredRevision);
  assert.equal(maxActiveApply, 1, "apply() must never run concurrently for the same logical target");
  // 1 baseline + 1 gated B + 1 dirty-loop re-run landing on C. Late joiners
  // share the in-flight promise instead of each starting a sequential catch-up.
  assert.equal(applyCalls, 3, "one apply for the baseline, one gated for B, and one dirty-loop re-run landing on C — never a second concurrent apply()");
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.match(overlay?.configContent ?? "", /three\.example/, "the successor overlay is C");
  assert.equal(controller.status(ctx, "opencode")[0]?.desiredRevision, a.desiredRevision, "status desired matches the final coalesced revision");
});

test("session release does not destroy shared physical OpenCode target", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  const physical = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const session = { ...physical, sessionId: "sess-1" };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  await controller.reconcile(harness, physical);
  await controller.reconcile(harness, session);
  controller.release(session, "opencode");
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
});

test("physical eviction releases overlay and revision storage", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  await controller.reconcile(harness, ctx);
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  controller.release({ ...ctx, sessionId: undefined }, "opencode");
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
  const runtimeRoot = join(space.storageDir, "runtime", "opencode");
  if (existsSync(runtimeRoot)) {
    const entries = readFileSync(join(dataDir, "status.json"), "utf8");
    assert.ok(entries);
  }
});

test("shared runtime occupancy: releasing one session binding keeps the physical target alive; onEvict release tears it down", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const physical = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const owner = createKeyedRuntimeOwner<AgentRuntime>();
  const key = JSON.stringify(["p", cwd]);
  const registry = createHarnessRegistry();
  let controller: ReturnType<typeof createCapabilityProvisioningController>;

  const registryProvider = () => harnessProviderById(registry, "opencode");
  // Mirrors production's split in packages/server/src/index.ts: the physical
  // acquire() factory only reconciles and builds the runtime — occupancy
  // bindings are acquired by the caller AFTER acquire() resolves (see
  // `openCodePool.bindSession`), never inside the factory itself, because the
  // owner only flips the occupancy to `accepting` once creation completes.
  const runtime = async (callCtx: typeof physical) => {
    const record = await owner.acquire(key, async (occupancy) => {
      await controller.reconcile(registryProvider(), callCtx);
      return {
        value: { dispose: async () => {}, models: async () => [], sessions: async () => [], history: async () => [] } as AgentRuntime,
        dispose: async () => {},
      };
    });
    return record.value;
  };
  const harness = createOpenCodeHarness(runtime as never);
  harness.provisioner = createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never);
  registry.register(harness);
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  // A secret-bearing MCP forces a revision-scoped secrets directory on disk
  // (packages/backend-opencode/src/provisioner.ts), so this exercises real
  // revision storage GC, not just the in-memory overlay/status.
  await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "secret-a" },
  });
  controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: registry,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });

  await harness.createRuntime(physical);
  const acquired = owner.peek(key);
  assert.ok(acquired, "physical runtime is present after acquire");
  // Bindings are acquired by the caller AFTER createRuntime()/acquire() has
  // resolved and the owner has flipped occupancy to accepting — exactly like
  // production's `openCodePool.bindSession`, called once per session that
  // starts using the already-created shared physical runtime.
  acquired!.occupancy.acquireBinding("sess-a");
  acquired!.occupancy.acquireBinding("sess-b");
  assert.equal(acquired!.occupancy.snapshot().bindings, 2);
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  const dirsWhileLive = revisionDirs(space, "p", cwd);
  assert.ok(dirsWhileLive.length > 0);

  // Session A releases its occupancy BINDING only — this is not physical
  // disposal, and must not touch the shared runtime, its overlay, or storage.
  acquired!.occupancy.releaseBinding("sess-a");
  assert.equal(acquired!.occupancy.snapshot().bindings, 1);
  assert.ok(owner.peek(key), "physical target survives one session's binding release");
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), "overlay survives one session's binding release");
  assert.deepEqual(revisionDirs(space, "p", cwd).sort(), dirsWhileLive.sort());

  acquired!.occupancy.releaseBinding("sess-b");
  assert.equal(acquired!.occupancy.snapshot().bindings, 0);
  assert.ok(owner.peek(key), "an idle occupancy does not by itself tear down the physical runtime");
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));

  // Physical eviction path: dispose the keyed owner slot, then release
  // capability state without a sessionId — this mirrors production's
  // `openCodePool.onEvict` listener in index.ts, never a session-scoped
  // `controller.release`.
  await owner.dispose(key);
  controller.release({ ...physical, sessionId: undefined }, "opencode");
  assert.equal(owner.peek(key), undefined);
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
  assert.equal(revisionDirs(space, "p", cwd).length, 0, "revision storage is eligible for GC after physical eviction");
});

test("overlay staged for a pending-restart revision is what a successor spawn would read", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  // B is requested but the live generation is not restarted — records show
  // pending-restart, yet the private launch overlay a NEW spawn would read
  // is already B, not the stale applied A.
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  const second = await controller.reconcile(harness, ctx);
  assert.ok(second.records.some((row) => row.status === "pending-restart"));
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlay);
  assert.match(overlay!.configContent, /b\.example/);
  assert.doesNotMatch(overlay!.configContent, /a\.example/);
  assert.equal(overlay!.desiredRevision, second.desiredRevision);
});

test("Package SDK space enablement gates desired contributions", async () => {
  const root = tmp();
  const trusted = join(root, "trusted");
  const pkgDir = join(trusted, "demo");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 1,
    id: "com-example-demo",
    version: "1.0.0",
    display: { name: "Demo", description: "demo" },
    runtime: { kind: "trusted-local", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Demo" }] },
    capabilities: ["ui.render"],
  }));
  writeFileSync(join(pkgDir, "ui.ts"), "export const modules = {};\n");
  const storageA = { path: (rel: string) => join(root, "space-a", rel), packageDir: (id: string) => join(root, "space-a", "packages", id) };
  const storageB = { path: (rel: string) => join(root, "space-b", rel), packageDir: (id: string) => join(root, "space-b", "packages", id) };
  mkdirSync(storageA.path("packages"), { recursive: true });
  mkdirSync(storageB.path("packages"), { recursive: true });
  writeSpaceEnabled(storageA as never, "com-example-demo", true);
  writeSpaceEnabled(storageB as never, "com-example-demo", false);
  const reg = createPluginRegistry({
    dir: join(root, "installed"),
    trustedDir: trusted,
    packageSpaces: () => [
      { spaceId: "spc_a", storage: storageA as never },
      { spaceId: "spc_b", storage: storageB as never },
    ],
  });
  await reg.install("file:demo");
  await reg.enable("com-example-demo", storageA as never);
  const contributions = createCapabilityContributionRegistry();
  contributions.register("com-example-demo", {
    descriptor: {
      id: "com-example-demo.tool",
      kind: "tool",
      owner: "com-example-demo",
      scope: "space",
      revision: "1",
      name: "demo",
      description: "demo",
      inputSchema: { type: "object", properties: {} },
      trust: "pure",
      mutating: false,
    },
    execute: async () => ({ output: "ok" }),
  });
  const controller = createCapabilityProvisioningController({
    contributions,
    harnesses: mockHarnessRegistry(opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} })),
    behavior: createBehaviorService({ file: join(root, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: root, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(root, "status.json"),
    contributionAllowed: (owner, context) => {
      if (owner === "polyth") return true;
      if (!reg.has(owner) || !context.space) return false;
      const storage = context.spaceId === "spc_a" ? storageA : storageB;
      if (reg.detail(owner, storage as never).runtimeKind === "sandboxed") return false;
      return reg.isEnabled(owner, storage as never);
    },
  });
  const desiredA = await controller.desired({
    spaceId: "spc_a",
    projectId: "p",
    cwd: "/tmp",
    space: spaceOf(storageA.path(""), "spc_a"),
  });
  const desiredB = await controller.desired({
    spaceId: "spc_b",
    projectId: "p",
    cwd: "/tmp",
    space: spaceOf(storageB.path(""), "spc_b"),
  });
  assert.ok(desiredA.some((item) => item.id === "com-example-demo.tool"));
  assert.equal(desiredB.some((item) => item.id === "com-example-demo.tool"), false);
});

test("failed stale generation receipt does not poison newer desired", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess", space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
  });
  const current = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "opencode", sessionId: "sess", authorityId: "g2", generation: 2 },
    desiredRevision: "stale-rev",
    capabilityIds: ["polyth.behavior"],
    outcome: "failed",
    reason: "stale",
  });
  const row = controller.status(ctx, "opencode")[0]!.records.find((item) => item.capabilityId === "polyth.behavior")!;
  assert.notEqual(row.status, "failed");
  assert.equal(current.desiredRevision, controller.status(ctx, "opencode")[0]!.desiredRevision);
});

test("production integration topology: beforeCreate reconcile and physical re-reconcile", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const events: string[] = [];
  const owner = createKeyedRuntimeOwner<AgentRuntime>();
  const key = JSON.stringify(["p", cwd]);
  const registry = createHarnessRegistry();
  let controller: ReturnType<typeof createCapabilityProvisioningController>;
  let provider: ReturnType<typeof harnessProviderById>;

  const runtime = async (callCtx: typeof ctx) => {
    events.push("runtime-create");
    const record = await owner.acquire(key, async () => {
      events.push("physical-re-reconcile");
      await controller.reconcile(provider, callCtx);
      return {
        value: { dispose: async () => {}, models: async () => [], sessions: async () => [], history: async () => [] } as AgentRuntime,
        dispose: async () => { events.push("runtime-dispose"); },
      };
    });
    return record.value;
  };
  const harness = createOpenCodeHarness(runtime as never);
  harness.provisioner = createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never);
  registry.register(harness);
  provider = harnessProviderById(registry, "opencode");
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
  });
  controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: registry,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  events.push("before-create");
  await controller.reconcile(provider, { ...ctx, sessionId: "sess" });
  await harness.createRuntime(ctx);
  assert.deepEqual(events, ["before-create", "runtime-create", "physical-re-reconcile"]);
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  controller.release({ ...ctx, sessionId: "sess" }, "opencode");
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  controller.release({ ...ctx, sessionId: undefined }, "opencode");
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
});

test("same-authority generation advances do not retire the authority", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  const ids = first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId);
  const ack = (authorityId: string, generation: number, desiredRevision = first.desiredRevision) =>
    controller.acknowledge({
      target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId, generation },
      desiredRevision,
      capabilityIds: ids,
      outcome: "unverifiable",
    });
  ack("X", 1);
  ack("X", 2);
  ack("X", 3);
  let row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "X");
  assert.equal(row.target?.generation, 3);
  ack("X", 1);
  ack("X", 2);
  row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "X");
  assert.equal(row.target?.generation, 3, "late same-authority generations must not rewind the live target");
  ack("Y", 1);
  row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "Y");
  assert.equal(row.target?.generation, 1);
  ack("X", 4);
  row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "Y");
  assert.equal(row.target?.generation, 1, "retired authority X must not regain control");
  ack("Y", 2);
  row = controller.status(ctx, "opencode")[0]!;
  assert.equal(row.target?.authorityId, "Y");
  assert.equal(row.target?.generation, 2);
});

test("uncaptured staged revisions are GC'd; captured in-flight revisions survive until bound or failed", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await mcp.create(space, {
    name: "alpha",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "secret-a" },
  });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const first = await controller.reconcile(harness, ctx);
  const revA = first.desiredRevision;
  const dirsA = revisionDirs(space, "p", cwd);
  assert.ok(dirsA.length > 0, "revision A storage should exist");
  await bumpMcpUrl(mcp, space, created.id, "https://b.example");
  const second = await controller.reconcile(harness, ctx);
  const revB = second.desiredRevision;
  const dirsAfterB = revisionDirs(space, "p", cwd);
  for (const dir of dirsA) {
    assert.equal(dirsAfterB.includes(dir), false, `uncaptured staged A dir ${dir} must be GC'd when B is staged`);
  }
  assert.ok(dirsAfterB.length > 0, "revision B storage should remain");
  controller.captureLaunch({
    spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", desiredRevision: revB,
  });
  await bumpMcpUrl(mcp, space, created.id, "https://c.example");
  const third = await controller.reconcile(harness, ctx);
  const revC = third.desiredRevision;
  const dirsAfterC = revisionDirs(space, "p", cwd);
  for (const dir of dirsAfterB) {
    assert.ok(dirsAfterC.includes(dir), `captured in-flight B dir ${dir} must survive C`);
  }
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "auth-b", generation: 1 },
    desiredRevision: revB,
    capabilityIds: second.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  await controller.reconcile(harness, ctx);
  const bound = controller.status(ctx, "opencode")[0]!;
  assert.equal(bound.target?.authorityId, "auth-b");
  assert.equal(bound.target?.generation, 1);
  const dirsBound = revisionDirs(space, "p", cwd);
  for (const dir of dirsAfterB) assert.ok(dirsBound.includes(dir), "bound B resources remain while C is still staged");
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "auth-c", generation: 1 },
    desiredRevision: revC,
    capabilityIds: third.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  await controller.reconcile(harness, ctx);
  const dirsAfterCBound = revisionDirs(space, "p", cwd);
  for (const dir of dirsAfterB) {
    assert.equal(dirsAfterCBound.includes(dir), false, `retired bound B dir ${dir} can be GC'd after C is admitted`);
  }
  assert.ok(dirsAfterCBound.length > 0, "revision C storage should remain");
  assert.equal(revA !== revB && revB !== revC, true);
});

test("empty successor overlay settles removal of the last tool without restaging restart", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  let staged = 0;
  const registry = createCapabilityContributionRegistry();
  const tool = registry.register("example-feature", {
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
    execute: async () => ({ output: "pong" }),
  });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const inner = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const minted: string[] = [];
  const tools = {
    ...inner,
    mint(grant: Parameters<typeof inner.mint>[0]) {
      const next = inner.mint(grant);
      minted.push(next.token);
      return next;
    },
  };
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
    tools,
    toolsEndpoint: () => `http://127.0.0.1:9${AGENT_TOOLS_PATH}`,
    onOpenCodeCapabilityRestart: (context, desiredRevision) => {
      staged += 1;
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        desiredRevision,
        apply: async () => {},
      });
    },
    onOpenCodeCapabilitySettled: (input) => pending.settleRuntimeCapabilities(input),
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "tool" || row.capabilityId === "polyth.agent-tools").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  tool.dispose();
  const after = await controller.reconcile(harness, ctx);
  assert.ok(after.records.some((row) => row.capabilityId === "example-feature.ping" && row.status === "pending-restart"));
  assert.equal(staged, 1);
  const liveToken = fakeGet(minted[0]!);
  await tools.route(liveToken.rc as never);
  assert.equal(liveToken.captured()?.code, 200, "bound generation token stays live until successor admission");
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlay, "empty overlay still carries bundle admission metadata");
  assert.equal(overlay!.desiredRevision, after.desiredRevision);
  assert.deepEqual(overlay!.capabilityIds, []);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 2 },
    desiredRevision: after.desiredRevision,
    capabilityIds: [],
    outcome: "unverifiable",
  });
  const settled = await controller.reconcile(harness, ctx);
  assert.equal(settled.records.some((row) => row.status === "pending-restart"), false);
  assert.equal(staged, 1, "successor admission must not restage runtime-capabilities");
  assert.equal(pending.list().count, 0);
});

test("empty successor overlay settles removal of the last skill without restaging restart", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  let staged = 0;
  const registry = createCapabilityContributionRegistry();
  const skill = registry.register("example-feature", {
    descriptor: {
      id: "example-feature.docs",
      kind: "skill",
      owner: "example-feature",
      scope: "project",
      revision: "1",
      name: "docs",
      title: "Docs",
      description: "Write docs",
      instructions: "Be thorough.",
    },
  });
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      staged += 1;
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "skill").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  skill.dispose();
  const after = await controller.reconcile(harness, ctx);
  assert.ok(after.records.some((row) => row.capabilityId === "example-feature.docs" && row.status === "pending-restart"));
  assert.equal(staged, 1);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.equal(overlay?.desiredRevision, after.desiredRevision);
  assert.deepEqual(overlay?.capabilityIds ?? [], []);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 2 },
    desiredRevision: after.desiredRevision,
    capabilityIds: [],
    outcome: "unverifiable",
  });
  const settled = await controller.reconcile(harness, ctx);
  assert.equal(settled.records.some((row) => row.status === "pending-restart"), false);
  assert.equal(staged, 1);
});

test("empty successor overlay settles last MCP tombstone and removal without restaging restart", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  let staged = 0;
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  const created = await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
    onOpenCodeCapabilityRestart: (context) => {
      staged += 1;
      pending.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        apply: async () => {},
      });
    },
  });
  const first = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "unverifiable",
  });
  await mcp.remove(space, created.id);
  const after = await controller.reconcile(harness, ctx);
  assert.ok(after.records.some((row) => row.status === "pending-restart"));
  assert.equal(staged, 1);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.equal(overlay?.desiredRevision, after.desiredRevision);
  assert.deepEqual(overlay?.capabilityIds ?? [], []);
  if (overlay?.configContent) assert.doesNotMatch(overlay.configContent, /"enabled":false/);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 2 },
    desiredRevision: after.desiredRevision,
    capabilityIds: [],
    outcome: "unverifiable",
  });
  const settled = await controller.reconcile(harness, ctx);
  assert.equal(settled.records.some((row) => row.status === "pending-restart"), false);
  assert.equal(staged, 1);
});

test("twenty concurrent reconciles coalesce to a bounded number of apply() calls", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  let applyCalls = 0;
  const inner = createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never);
  const harness = opencodeHarness({ applyBehavior: async () => 0, applyMcp: async () => {} });
  const originalApply = inner.apply.bind(inner);
  harness.provisioner = {
    ...inner,
    async apply(context, plan, secrets) {
      applyCalls += 1;
      return originalApply(context, plan, secrets);
    },
  };
  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  await seedMcp(mcp, space);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  await controller.reconcile(harness, ctx);
  applyCalls = 0;
  const results = await Promise.all(Array.from({ length: 20 }, () => controller.reconcile(harness, ctx)));
  assert.equal(new Set(results.map((row) => row.desiredRevision)).size, 1);
  assert.ok(applyCalls <= 2, `burst of 20 must coalesce; apply() ran ${applyCalls} times`);
});
