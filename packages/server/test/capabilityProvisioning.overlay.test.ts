import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createClaudeProvisioner, claudeOverlays } from "@polyth/backend-claude";
import { createCodexProvisioner } from "../../backend-codex/src/provisioner.ts";
import {
  createOpenCodeProvisioner,
  peekOpenCodeLaunchOverlay,
  polythSkillId,
} from "@polyth/backend-opencode";
import type { BackendConfigApplier } from "@polyth/backend-opencode";
import { createBehaviorService } from "../src/behavior.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createAgentToolBridge, AGENT_TOOLS_PATH } from "../src/agentTools.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-ovl-"));
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

const silentApplier = {
  applyBehavior: async () => 0,
  applyMcp: async () => {},
} as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;

const walkFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
};

const treeHas = (root: string, needle: string): boolean =>
  walkFiles(root).some((path) => readFileSync(path, "utf8").includes(needle));

test("MCP change in Space B does not synthesize Space B + Project A", async () => {
  const dir = tmp();
  const spaceA = spaceOf(join(dir, "a"), "spc_a");
  const spaceB = spaceOf(join(dir, "b"), "spc_b");
  const seen: Array<{ spaceId: string; projectId: string; cwd: string }> = [];
  const inner = createOpenCodeProvisioner(silentApplier as BackendConfigApplier);
  const tracking: HarnessProvider["provisioner"] = {
    support: (ctx) => inner.support(ctx),
    apply: async (ctx, plan, secrets) => {
      seen.push({ spaceId: ctx.spaceId, projectId: ctx.projectId, cwd: ctx.cwd });
      return inner.apply(ctx, plan, secrets);
    },
  };
  const harness = provider("opencode", tracking);
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctxA = { spaceId: spaceA.spaceId, projectId: "proj-a", cwd: "/tmp/proj-a", space: spaceA };
  await controller.reconcile(harness, ctxA);
  seen.length = 0;
  await mcp.create(spaceB, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  await controller.reconcileSpace(spaceB);
  assert.equal(seen.some((row) => row.spaceId === spaceB.spaceId && row.cwd === "/tmp/proj-a"), false);
  assert.equal(seen.some((row) => row.spaceId === spaceA.spaceId), false);
});

test("MCP Space change only reaches active targets in that Space", async () => {
  const dir = tmp();
  const spaceA = spaceOf(join(dir, "a"), "spc_a");
  const spaceB = spaceOf(join(dir, "b"), "spc_b");
  const seen: string[] = [];
  const inner = createOpenCodeProvisioner(silentApplier as BackendConfigApplier);
  const tracking: HarnessProvider["provisioner"] = {
    support: (ctx) => inner.support(ctx),
    apply: async (ctx, plan, secrets) => {
      seen.push(`${ctx.spaceId}:${ctx.projectId}`);
      return inner.apply(ctx, plan, secrets);
    },
  };
  const harness = provider("opencode", tracking);
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  await controller.reconcile(harness, { spaceId: spaceA.spaceId, projectId: "proj-a", cwd: "/tmp/a", space: spaceA });
  await controller.reconcile(harness, { spaceId: spaceB.spaceId, projectId: "proj-b", cwd: "/tmp/b", space: spaceB });
  seen.length = 0;
  await mcp.create(spaceB, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  await controller.reconcileSpace(spaceB);
  assert.deepEqual(seen, ["spc_b:proj-b"]);
});

test("global behavior reaches active targets in every Space", async () => {
  const dir = tmp();
  const spaceA = spaceOf(join(dir, "a"), "spc_a");
  const spaceB = spaceOf(join(dir, "b"), "spc_b");
  const claude = provider("claude", createClaudeProvisioner());
  const codex = provider("codex", createCodexProvisioner());
  const behavior = createBehaviorService({ file: join(dir, "behavior.md") });
  await behavior.put("rev1", (await behavior.get()).revision);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [claude, codex], get: (id) => [claude, codex].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => claude },
    behavior,
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const ctxA = { spaceId: spaceA.spaceId, projectId: "pa", cwd: "/tmp/a", sessionId: "sess-a", space: spaceA };
  const ctxB = { spaceId: spaceB.spaceId, projectId: "pb", cwd: "/tmp/b", sessionId: "sess-b", space: spaceB };
  await controller.reconcile(claude, ctxA);
  await controller.reconcile(codex, ctxB);
  await behavior.put("rev2", (await behavior.get()).revision);
  await controller.reconcileAllActiveTargets();
  const recA = controller.status(ctxA, "claude")[0]!.records.find((row) => row.capabilityId === "polyth.behavior")!;
  const recB = controller.status(ctxB, "codex")[0]!.records.find((row) => row.capabilityId === "polyth.behavior")!;
  assert.equal(recA.status, "pending");
  assert.equal(recB.status, "pending");
  assert.notEqual(recA.desiredRevision, recA.appliedRevision ?? "");
  assert.notEqual(recB.desiredRevision, recB.appliedRevision ?? "");
});

test("OpenCode does not write MCP secrets or tool tokens into the project tree", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "hello\n");
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
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "SUPER_SECRET_123" },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
    tools,
    toolsEndpoint: () => "http://127.0.0.1:9/internal/agent-tools",
  });
  await controller.reconcile(harness, { spaceId: space.spaceId, projectId: "p", cwd, space });
  assert.equal(treeHas(cwd, "SUPER_SECRET_123"), false);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(overlay);
  assert.doesNotMatch(overlay.configContent, /SUPER_SECRET_123/);
  assert.doesNotMatch(JSON.stringify(overlay.env), /SUPER_SECRET_123/);
  const token = overlay.env.POLYTH_AGENT_TOOLS_TOKEN;
  if (token) assert.equal(treeHas(cwd, token), false);
  assert.doesNotMatch(overlay.configContent, /POLYTH_AGENT_TOOLS_TOKEN":"[^"{]/);
});

test("project OpenCode JSONC bytes stay untouched under private overlay provisioning", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const jsonc = `// user-owned OpenCode config
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "user-mcp": { "type": "local", "command": ["echo"], "enabled": true, },
  },
  "plugin": ["keep-plugin"],
  "provider": { "x": { "npm": "x" } },
  "skills": { "paths": ["./mine"] },
  "unknownField": true,
}
`;
  mkdirSync(join(cwd, ".opencode"), { recursive: true });
  const path = join(cwd, ".opencode", "opencode.jsonc");
  writeFileSync(path, jsonc);
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
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
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  await controller.reconcile(harness, { spaceId: space.spaceId, projectId: "p", cwd, space });
  assert.equal(readFileSync(path, "utf8"), jsonc);
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
});

test("OpenCode first launch acknowledgement is exact-target applied", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
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
  controller.acknowledge({
    target: {
      spaceId: space.spaceId,
      projectId: "p",
      cwd,
      harnessId: "opencode",
      authorityId: "auth-1",
      generation: 1,
    },
    desiredRevision: staged.desiredRevision,
    capabilityIds: [rec.capabilityId],
    outcome: "unverifiable",
  });
  const after = controller.status(ctx, "opencode")[0]!;
  assert.equal(after.records.find((row) => row.capabilityId === rec.capabilityId)!.status, "unverifiable");
  assert.equal(after.target?.authorityId, "auth-1");
  assert.equal(after.target?.generation, 1);
});

test("restart acknowledgement is target-specific", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwdA = tmp();
  const cwdB = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctxA = { spaceId: space.spaceId, projectId: "pa", cwd: cwdA, space };
  const ctxB = { spaceId: space.spaceId, projectId: "pb", cwd: cwdB, space };
  const a = await controller.reconcile(harness, ctxA);
  const b = await controller.reconcile(harness, ctxB);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "pa", cwd: cwdA, harnessId: "opencode", authorityId: "a", generation: 1 },
    desiredRevision: a.desiredRevision,
    capabilityIds: a.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  await mcp.update(space, mcp.list(space)[0]!.id, { enabled: true }, mcp.list(space)[0]!.revision);
  await controller.reconcile(harness, ctxA);
  await controller.reconcile(harness, ctxB);
  const pendingA = controller.status(ctxA, "opencode")[0]!.records.find((row) => row.kind === "mcp-server")!;
  const pendingB = controller.status(ctxB, "opencode")[0]!.records.find((row) => row.kind === "mcp-server")!;
  assert.equal(pendingA.status, "pending-restart");
  assert.equal(pendingB.status === "pending" || pendingB.status === "pending-restart", true);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "pa", cwd: cwdA, harnessId: "opencode", authorityId: "a", generation: 2 },
    desiredRevision: controller.status(ctxA, "opencode")[0]!.desiredRevision,
    capabilityIds: [pendingA.capabilityId],
    outcome: "applied",
  });
  assert.equal(controller.status(ctxA, "opencode")[0]!.records.find((row) => row.capabilityId === pendingA.capabilityId)!.status, "applied");
  const stillB = controller.status(ctxB, "opencode")[0]!.records.find((row) => row.capabilityId === pendingB.capabilityId)!;
  assert.notEqual(stillB.status, "applied");
});

test("stale generation receipt cannot overwrite current application state", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const first = await controller.reconcile(harness, ctx);
  const id = first.records.find((row) => row.kind === "mcp-server")!.capabilityId;
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "a", generation: 2 },
    desiredRevision: first.desiredRevision,
    capabilityIds: [id],
    outcome: "applied",
  });
  await mcp.update(space, mcp.list(space)[0]!.id, { enabled: true }, mcp.list(space)[0]!.revision);
  const next = await controller.reconcile(harness, ctx);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "a", generation: 3 },
    desiredRevision: next.desiredRevision,
    capabilityIds: [id],
    outcome: "applied",
  });
  const applied = controller.status(ctx, "opencode")[0]!;
  assert.equal(applied.target?.generation, 3);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "a", generation: 2 },
    desiredRevision: first.desiredRevision,
    capabilityIds: [id],
    outcome: "applied",
  });
  const after = controller.status(ctx, "opencode")[0]!;
  assert.equal(after.target?.generation, 3);
  assert.equal(after.records.find((row) => row.capabilityId === id)!.appliedRevision, next.records.find((row) => row.capabilityId === id)!.desiredRevision);
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode" },
    desiredRevision: next.desiredRevision,
    capabilityIds: [id],
    outcome: "applied",
  });
  assert.equal(controller.status(ctx, "opencode")[0]!.target?.generation, 3);
});

test("receipt materializes authority identity onto the stored target", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const staged = await controller.reconcile(harness, ctx);
  assert.equal(staged.target?.authorityId, undefined);
  controller.acknowledge({
    target: {
      spaceId: space.spaceId,
      projectId: "p",
      cwd,
      harnessId: "opencode",
      authorityId: "auth-9",
      generation: 4,
    },
    desiredRevision: staged.desiredRevision,
    capabilityIds: staged.records.filter((row) => row.kind === "mcp-server").map((row) => row.capabilityId),
    outcome: "applied",
  });
  const stored = controller.status(ctx, "opencode")[0]!.target!;
  assert.equal(stored.authorityId, "auth-9");
  assert.equal(stored.generation, 4);
});

test("disabling a package removes only Polyth-owned skill directories", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const registry = createCapabilityContributionRegistry();
  const contribution = registry.register("example-feature", {
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
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status.json"),
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd, space };
  const first = await controller.reconcile(harness, ctx);
  const skillId = polythSkillId("example-feature", "docs");
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  const skillRoot = (JSON.parse(overlay!.configContent) as { skills?: { paths?: string[] } }).skills?.paths?.[0];
  assert.ok(skillRoot);
  mkdirSync(join(skillRoot, "user-notes"), { recursive: true });
  writeFileSync(join(skillRoot, "user-notes", "SKILL.md"), "mine\n");
  assert.equal(existsSync(join(skillRoot, skillId, ".polyth-owned")), true);
  // A live native generation must bind to revision 1 first — until some
  // generation proves it, revision 1's skill directory cannot be pruned
  // (pre-ack retention: a spawn may still be reading it at exec time).
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g1", generation: 1 },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.kind !== "instruction").map((row) => row.capabilityId),
    outcome: "applied",
  });
  contribution.dispose();
  const second = await controller.reconcile(harness, ctx);
  const next = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.equal(next?.configContent.includes(skillId) ?? false, false);
  // Removing a restart-kind capability from a live generation requires a
  // restart; the old skill directory survives until a NEW generation (the
  // restarted process) acknowledges the post-removal revision.
  assert.equal(existsSync(join(skillRoot, skillId, ".polyth-owned")), true, "revision 1's skill directory survives until generation 2 proves it is unused");
  controller.acknowledge({
    target: { spaceId: space.spaceId, projectId: "p", cwd, harnessId: "opencode", authorityId: "g2", generation: 2 },
    desiredRevision: second.desiredRevision,
    capabilityIds: [],
    outcome: "applied",
  });
  await controller.reconcile(harness, ctx);
  assert.equal(existsSync(join(skillRoot, skillId, ".polyth-owned")), false, "generation 2 binding to the post-removal revision retires revision 1's skill directory");
});

test("OpenCode secrets and skills stay isolated across projects in one Space", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwdA = tmp();
  const cwdB = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "SECRET-A" },
  });
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
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
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  await controller.reconcile(harness, { spaceId: space.spaceId, projectId: "pa", cwd: cwdA, space });
  await controller.reconcile(harness, { spaceId: space.spaceId, projectId: "pb", cwd: cwdB, space });
  const overlayA = peekOpenCodeLaunchOverlay({ cwd: cwdA, spaceId: space.spaceId, projectId: "pa" });
  const overlayB = peekOpenCodeLaunchOverlay({ cwd: cwdB, spaceId: space.spaceId, projectId: "pb" });
  const rootA = (JSON.parse(overlayA!.configContent) as { skills?: { paths?: string[] } }).skills?.paths?.[0];
  const rootB = (JSON.parse(overlayB!.configContent) as { skills?: { paths?: string[] } }).skills?.paths?.[0];
  assert.ok(rootA && rootB);
  assert.notEqual(rootA, rootB);
  assert.equal(existsSync(join(rootA, "polyth-example-feature-docs", ".polyth-owned")), true);
  assert.equal(existsSync(join(rootB, "polyth-example-feature-docs", ".polyth-owned")), true);
});

test("harness switch releases Claude volatile state and keeps canonical MCP", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
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
  registry.register("example-feature", {
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
  const tools = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  const created = await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const claude = provider("claude", createClaudeProvisioner());
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [claude], get: (id) => [claude].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => claude },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
    tools,
    toolsEndpoint: () => "http://127.0.0.1:9/internal/agent-tools",
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "sess-a", space };
  const first = await controller.reconcile(claude, ctx);
  const overlay = claudeOverlays.peek(ctx, "claude");
  const env = overlay?.value.mcpServers?.["polyth-agent-tools"];
  const token = env && "env" in env ? env.env?.POLYTH_AGENT_TOOLS_TOKEN : undefined;
  assert.ok(token);
  const skillRecord = first.records.find((row) => row.capabilityId === "example-feature.docs")!;
  assert.equal(skillRecord.status, "unsupported");
  assert.equal(
    skillRecord.reason,
    "Claude Agent SDK supports skills, but Polyth does not yet provide a safe private portable skill-source projection for this adapter",
  );
  controller.release(ctx, "claude");
  assert.equal(claudeOverlays.peek(ctx, "claude"), undefined);
  assert.equal(controller.status(ctx, "claude")[0]?.records.length, 0);
  assert.equal(mcp.list(space).some((row) => row.id === created.id), true);
});

const fakeRc = (token: string, id: string) => {
  let captured: { code: number; body: unknown } | undefined;
  return {
    captured: () => captured,
    rc: {
      path: AGENT_TOOLS_PATH,
      method: "POST",
      ingress: { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false },
      req: { headers: { authorization: `Bearer ${token}` } },
      body: async () => ({ id, arguments: {} }),
      json: (code: number, body: unknown) => { captured = { code, body }; },
    },
  };
};

test("OpenCode session occupancy release keeps shared overlay and package-tool grant", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
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
  const inner = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  let token = "";
  const tools = {
    ...inner,
    mint(input: Parameters<typeof inner.mint>[0]) {
      const grant = inner.mint(input);
      token = grant.token;
      return grant;
    },
  };
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
    tools,
    toolsEndpoint: () => "http://127.0.0.1:9/internal/agent-tools",
  });
  const physical = { spaceId: space.spaceId, projectId: "p", cwd, space };
  await controller.reconcile(harness, { ...physical, sessionId: "sess-a" });
  await controller.reconcile(harness, { ...physical, sessionId: "sess-b" });
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  assert.ok(token);
  const before = fakeRc(token, "example-feature.ping");
  assert.equal(await tools.route(before.rc as never), true);
  assert.equal(before.captured()?.code, 200);
  controller.release({ ...physical, sessionId: "sess-a" }, "opencode");
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  const afterSwitch = fakeRc(token, "example-feature.ping");
  assert.equal(await tools.route(afterSwitch.rc as never), true);
  assert.equal(afterSwitch.captured()?.code, 200);
  assert.ok(controller.status(physical, "opencode")[0]?.records.length);
  controller.release(physical, "opencode");
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
  const afterEvict = fakeRc(token, "example-feature.ping");
  assert.equal(await tools.route(afterEvict.rc as never), true);
  assert.equal(afterEvict.captured()?.code, 401);
  assert.equal(controller.status(physical, "opencode")[0]?.records.length, 0);
});

test("OpenCode overlay is restored after physical eviction then recreate reconcile", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = tmp();
  const mcp = createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" });
  await mcp.create(space, {
    name: "linear",
    transport: { kind: "http", url: "https://linear.example", headersSecretRefs: [] },
  });
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });
  const physical = { spaceId: space.spaceId, projectId: "p", cwd, space };
  await controller.reconcile(harness, { ...physical, sessionId: "sess-a" });
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  controller.release(physical, "opencode");
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
  await controller.reconcile(harness, physical);
  const restored = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  assert.ok(restored);
  const parsed = JSON.parse(restored.configContent) as { mcp?: Record<string, unknown> };
  assert.ok(parsed.mcp?.linear);
});

test("volatile OpenCode application status is not trusted after reload", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const cwd = "/tmp/p";
  const file = join(dir, "status.json");
  writeFileSync(file, `${JSON.stringify([{
    target: {
      spaceId: space.spaceId,
      projectId: "p",
      cwd,
      harnessId: "opencode",
      generation: 3,
    },
    desiredRevision: "rev-3",
    durable: false,
    records: [{
      capabilityId: "polyth.mcp.linear",
      kind: "mcp-server",
      owner: "polyth",
      desiredRevision: "1",
      appliedRevision: "1",
      mode: "config",
      status: "unverifiable",
    }],
  }], null, 2)}\n`);
  const harness = provider("opencode", createOpenCodeProvisioner(silentApplier as BackendConfigApplier));
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file,
  });
  const row = controller.status({ spaceId: space.spaceId, projectId: "p", cwd, space }, "opencode")[0];
  assert.equal(row?.records.some((item) => item.status === "unverifiable" || item.status === "applied"), false);
});

test("explicit durable false is never inferred live from a missing sessionId", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
  const file = join(dir, "status.json");
  writeFileSync(file, `${JSON.stringify([{
    target: { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", harnessId: "claude" },
    desiredRevision: "rev",
    durable: false,
    records: [{
      capabilityId: "polyth.behavior",
      kind: "instruction",
      owner: "polyth",
      desiredRevision: "1",
      appliedRevision: "1",
      mode: "native",
      status: "applied",
    }],
  }])}\n`);
  const harness = provider("claude", createClaudeProvisioner());
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file,
  });
  const row = controller.status({ spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", space }, "claude")[0];
  assert.equal(row?.records.some((item) => item.status === "applied"), false);
});

test("disabled package contributions do not resolve into desired state", async () => {
  const dir = tmp();
  const space = spaceOf(join(dir, "space"), "spc_a");
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
  const harness = provider("claude", createClaudeProvisioner());
  const allowed = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: { register: () => ({ dispose() {} }), providers: () => [harness], get: (id) => [harness].find((p) => p.descriptor.id === id), probe: async () => [], resolve: async () => harness },
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: "spc_a" }),
    file: join(dir, "status-a.json"),
    contributionAllowed: (owner) => owner !== "example-feature",
  });
  const ctx = { spaceId: space.spaceId, projectId: "p", cwd: "/tmp/p", sessionId: "s", space };
  const desired = await allowed.desired(ctx);
  assert.equal(desired.some((item) => item.id === "example-feature.ping"), false);
});
