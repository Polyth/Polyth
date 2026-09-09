import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentCapabilityDescriptor,
  CapabilitySecretResolver,
  HarnessContext,
  HarnessProvisioningPlan,
  ToolExecutor,
} from "@polyth/contracts";
import { createCapabilityContributionRegistry, planHarnessCapabilities } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { claudeOverlays, createClaudeProvisioner } from "../../backend-claude/src/provisioner.ts";
import { codexOverlays, createCodexProvisioner } from "../../backend-codex/src/provisioner.ts";
import { acpOverlays, createAcpProvisioner } from "../../backend-acp/src/provisioner.ts";

const context: HarnessContext = {
  spaceId: "space-a", projectId: "project-a", cwd: "/projects/a", sessionId: "session-a",
};
const secrets: CapabilitySecretResolver = {
  mcpSecrets: () => ({ TEST_TOKEN: "stdio-secret", Authorization: "Bearer http-secret", EXTRA: "not-exported" }),
};
const execute: ToolExecutor = async (input, ctx) => ({
  output: JSON.stringify({ input, projectId: ctx.projectId, spaceId: ctx.spaceId }),
});
const base = {
  owner: "fixture", revision: "1", spaceId: context.spaceId, projectId: context.projectId,
};
const descriptors: AgentCapabilityDescriptor[] = [
  { ...base, id: "fixture.instructions", scope: "project", kind: "instruction", text: "Canonical instructions." },
  {
    ...base, id: "fixture.skill", scope: "project", kind: "skill", name: "review",
    title: "Review", description: "Review a patch.", instructions: "Check the invariants before changing code.",
  },
  { ...base, id: "fixture.context", scope: "project", kind: "context", title: "Project", text: "Project A context." },
  {
    ...base, id: "fixture.stdio", scope: "project", kind: "mcp-server", name: "stdio-helper", enabled: true,
    transport: { kind: "stdio", command: "helper", args: ["--stdio"], envKeys: ["TEST_TOKEN"] },
  },
  {
    ...base, id: "fixture.http", scope: "project", kind: "mcp-server", name: "http-helper", enabled: true,
    transport: { kind: "http", url: "https://example.invalid/mcp", headersSecretRefs: ["Authorization"] },
  },
  {
    ...base, id: "fixture.tool", scope: "project", kind: "tool", name: "fixture_read",
    description: "Read the fixture.", inputSchema: { type: "object" }, trust: "pure", mutating: false,
  },
];

function registryFor(items = descriptors) {
  const registry = createCapabilityContributionRegistry();
  for (const descriptor of items) {
    registry.register("fixture", { descriptor, ...(descriptor.kind === "tool" ? { execute } : {}) });
  }
  return registry;
}

const textAdapters = [
  {
    id: "claude", create: createClaudeProvisioner, overlays: claudeOverlays,
    text: () => claudeOverlays.get(context, "claude")?.append,
  },
  {
    id: "codex", create: createCodexProvisioner, overlays: codexOverlays,
    text: () => codexOverlays.get(context, "codex")?.developerInstructions,
  },
];

for (const adapter of textAdapters) {
  test(`${adapter.id}: canonical skills and context reach the native launch overlay`, async (t) => {
    const provisioner = adapter.create();
    t.after(() => provisioner.release?.(context));
    const desired = registryFor().resolve(context);
    const plan = planHarnessCapabilities(adapter.id, desired, await provisioner.support(context), context);
    const result = await provisioner.apply(context, plan, secrets);
    for (const kind of ["skill", "context"]) {
      const item = result.records.find((row) => row.kind === kind);
      assert.equal(item?.mode, "prompt");
      assert.equal(item?.status, "pending");
    }
    assert.equal(adapter.text(), renderCapabilityText(plan));
    assert.match(adapter.text() ?? "", /Canonical instructions\./);
    assert.match(adapter.text() ?? "", /Check the invariants before changing code\./);
    assert.match(adapter.text() ?? "", /Project A context\./);
    assert.doesNotMatch(adapter.text() ?? "", /stdio-secret|http-secret|not-exported/);
    assert.deepEqual(result.records.map((row) => row.capabilityId), desired.map((row) => row.id));
    assert.deepEqual(adapter.overlays.peek(context, adapter.id)?.capabilityIds,
      result.records.filter((row) => row.status === "pending").map((row) => row.capabilityId));
  });

  test(`${adapter.id}: MCP configuration still receives only requested secrets`, async (t) => {
    const provisioner = adapter.create();
    t.after(() => provisioner.release?.(context));
    const plan = planHarnessCapabilities(adapter.id, registryFor().resolve(context), await provisioner.support(context), context);
    await provisioner.apply(context, plan, secrets);
    const servers = adapter.overlays.get(context, adapter.id)?.mcpServers;
    assert.deepEqual(servers?.["stdio-helper"], { command: "helper", args: ["--stdio"], env: { TEST_TOKEN: "stdio-secret" } });
    assert.ok(servers?.["http-helper"]);
    assert.match(JSON.stringify(servers), /Bearer http-secret/);
    assert.doesNotMatch(JSON.stringify(servers), /not-exported/);
  });

  test(`${adapter.id}: overlays remain isolated by space, project, directory and session`, async (t) => {
    const provisioner = adapter.create();
    t.after(() => provisioner.release?.(context));
    const plan = planHarnessCapabilities(adapter.id, registryFor().resolve(context), await provisioner.support(context), context);
    await provisioner.apply(context, plan, secrets);
    for (const other of [
      { ...context, spaceId: "space-b" }, { ...context, projectId: "project-b" },
      { ...context, cwd: "/projects/b" }, { ...context, sessionId: "session-b" },
    ]) assert.equal(adapter.overlays.peek(other, adapter.id), undefined);
  });

  test(`${adapter.id}: consuming and re-staging preserves the same canonical revision`, async (t) => {
    const provisioner = adapter.create();
    t.after(() => provisioner.release?.(context));
    const plan = planHarnessCapabilities(adapter.id, registryFor().resolve(context), await provisioner.support(context), context);
    await provisioner.apply(context, plan, secrets);
    const original = adapter.overlays.peek(context, adapter.id);
    assert.ok(original);
    assert.equal(adapter.overlays.consumeIfRevision(context, adapter.id, "stale"), undefined);
    assert.deepEqual(adapter.overlays.consumeIfRevision(context, adapter.id, plan.desiredRevision), original);
    assert.equal(adapter.overlays.peek(context, adapter.id), undefined);
    await provisioner.apply(context, plan, secrets);
    assert.deepEqual(adapter.overlays.peek(context, adapter.id), original);
  });

  test(`${adapter.id}: removing a skill removes its staged instructions`, async (t) => {
    const provisioner = adapter.create();
    t.after(() => provisioner.release?.(context));
    const support = await provisioner.support(context);
    const first = planHarnessCapabilities(adapter.id, registryFor().resolve(context), support, context);
    await provisioner.apply(context, first, secrets);
    assert.match(adapter.text() ?? "", /Check the invariants/);
    const next = planHarnessCapabilities(adapter.id,
      registryFor(descriptors.filter((row) => row.kind !== "skill")).resolve(context), support, context);
    await provisioner.apply(context, next, secrets);
    assert.notEqual(next.desiredRevision, first.desiredRevision);
    assert.doesNotMatch(adapter.text() ?? "", /Check the invariants/);
    assert.ok(!adapter.overlays.peek(context, adapter.id)?.capabilityIds.includes("fixture.skill"));
  });

  test(`${adapter.id}: remote execution remains explicitly unsupported`, async () => {
    const provisioner = adapter.create();
    const remote = { ...context, remote: true, sessionId: "remote-session" };
    const plan = planHarnessCapabilities(adapter.id, registryFor().resolve(remote), await provisioner.support(remote), remote);
    const result = await provisioner.apply(remote, plan, secrets);
    assert.ok(result.records.every((row) => row.status === "unsupported"));
    assert.equal(adapter.overlays.peek(remote, adapter.id), undefined);
  });
}

for (const harnessId of ["acp", "cursor", "fx", "third-party"]) {
  for (const http of [false, true]) {
    test(`${harnessId}: HTTP MCP=${http} receipts separate native configuration from prompt delivery`, async (t) => {
      const provisioner = createAcpProvisioner(harnessId, http);
      t.after(() => provisioner.release?.(context));
      const desired = registryFor().resolve(context);
      const plan = planHarnessCapabilities(harnessId, desired, await provisioner.support(context), context);
      const result = await provisioner.apply(context, plan, secrets);
      const overlay = acpOverlays.peek(context, harnessId);
      assert.ok(overlay);
      assert.deepEqual(result.records.map((row) => row.capabilityId), desired.map((row) => row.id));
      assert.deepEqual(overlay.capabilityIds,
        result.records.filter((row) => row.status === "pending" && row.mode !== "prompt").map((row) => row.capabilityId));
      assert.deepEqual(overlay.value.prompt?.capabilityIds,
        result.records.filter((row) => row.status === "pending" && row.mode === "prompt").map((row) => row.capabilityId));
      assert.equal(overlay.value.prompt?.text, renderCapabilityText(plan));
      assert.doesNotMatch(overlay.value.prompt?.text ?? "", /stdio-secret|http-secret|not-exported/);
      assert.equal(overlay.value.mcpServers.some((server) => server.name === "http-helper"), http);
      assert.equal(overlay.capabilityIds.includes("fixture.http"), http);
      assert.equal(result.records.find((row) => row.capabilityId === "fixture.http")?.status, http ? "pending" : "unsupported");
      assert.ok(result.records.filter((row) => ["instruction", "skill", "context"].includes(row.kind))
        .every((row) => row.status === "pending" && row.mode === "prompt"));
    });
  }
}

test("canonical discovery is independent of registration order and excludes another project", () => {
  const first = registryFor().resolve(context);
  assert.deepEqual(registryFor([...descriptors].reverse()).resolve(context), first);
  assert.deepEqual(registryFor().resolve({ ...context, projectId: "project-b" }), []);
  assert.deepEqual(registryFor().resolve({ ...context, spaceId: "space-b" }), []);
});

test("the canonical tool registry enumerates and invokes the registered executor", async () => {
  const registry = registryFor();
  assert.deepEqual(registry.resolve(context).filter((row) => row.kind === "tool").map((row) => row.id), ["fixture.tool"]);
  const invoke = registry.executor("fixture.tool");
  assert.ok(invoke);
  const result = await invoke({ query: "example" }, {
    sessionId: "session-a", spaceId: context.spaceId, projectId: context.projectId, cwd: context.cwd,
  });
  assert.deepEqual(JSON.parse(result.output), { input: { query: "example" }, projectId: context.projectId, spaceId: context.spaceId });
});

test("text projection does not smuggle unsupported or filesystem skills into a prompt", async () => {
  const support = await createClaudeProvisioner().support(context);
  const plan = planHarnessCapabilities("claude", registryFor().resolve(context), support, context);
  const blocked: HarnessProvisioningPlan = {
    ...plan, items: plan.items.map((item) => ({ ...item, mode: "unsupported" })),
  };
  assert.equal(renderCapabilityText(blocked), undefined);
  const nativeSkill: HarnessProvisioningPlan = {
    ...plan, items: plan.items.filter((item) => item.capability.kind === "skill")
      .map((item) => ({ ...item, mode: "filesystem" })),
  };
  assert.equal(renderCapabilityText(nativeSkill), undefined);
});


test("ACP: failed MCP name collisions cannot enter launch receipts", async (t) => {
  const provisioner = createAcpProvisioner("collision-fixture");
  t.after(() => provisioner.release?.(context));
  const duplicate: AgentCapabilityDescriptor = {
    ...base, id: "fixture.duplicate", scope: "project", kind: "mcp-server", name: "stdio-helper", enabled: true,
    transport: { kind: "stdio", command: "other-helper", args: [], envKeys: [] },
  };
  const plan = planHarnessCapabilities("collision-fixture", registryFor([...descriptors, duplicate]).resolve(context),
    await provisioner.support(context), context);
  const result = await provisioner.apply(context, plan, secrets);
  const overlay = acpOverlays.peek(context, "collision-fixture");
  assert.ok(overlay);
  for (const id of ["fixture.stdio", "fixture.duplicate"]) {
    assert.equal(result.records.find((row) => row.capabilityId === id)?.status, "failed");
    assert.ok(!overlay.capabilityIds.includes(id));
  }
  assert.ok(!overlay.value.mcpServers.some((server) => server.name === "stdio-helper"));
});
