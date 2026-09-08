import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCapabilityDescriptor, HarnessCapabilitySupport, HarnessContext } from "@polyth/contracts";
import {
  capabilityRevision,
  createCapabilityContributionRegistry,
  createLaunchOverlayStore,
  desiredBundleRevision,
  planHarnessCapabilities,
} from "../src/capabilities.ts";

const context: HarnessContext = { spaceId: "space-a", projectId: "proj", cwd: "/tmp/proj" };

const instruction = (id = "polyth.behavior"): AgentCapabilityDescriptor => ({
  id,
  kind: "instruction",
  owner: "polyth",
  scope: "deployment",
  revision: capabilityRevision("be brief"),
  text: "Be brief.",
});

const tool = (id = "example-feature.ping"): AgentCapabilityDescriptor => ({
  id,
  kind: "tool",
  owner: "example-feature",
  scope: "space",
  revision: capabilityRevision(id),
  name: "ping",
  description: "Ping",
  inputSchema: { type: "object", properties: {} },
  trust: "pure",
  mutating: false,
});

test("registry registers, rejects duplicates, and disposes", () => {
  const registry = createCapabilityContributionRegistry();
  const disposable = registry.register("example-feature", {
    descriptor: tool(),
    execute: async () => ({ output: "pong" }),
  });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.resolve(context)[0]?.id, "example-feature.ping");
  assert.throws(
    () => registry.register("example-feature", { descriptor: tool(), execute: async () => ({ output: "x" }) }),
    /already registered/,
  );
  disposable.dispose();
  assert.equal(registry.list().length, 0);
  assert.equal(registry.executor("example-feature.ping"), undefined);
});

test("registry rejects colliding owners, missing tool executors, invalid ids, and reserved polyth owner", () => {
  const registry = createCapabilityContributionRegistry();
  assert.throws(
    () => registry.register("other", { descriptor: { ...tool(), owner: "other" }, execute: async () => ({ output: "" }) }),
    /namespaced/,
  );
  assert.throws(
    () => registry.register("example-feature", { descriptor: tool() }),
    /execute handler/,
  );
  assert.throws(
    () => registry.register("example-feature", {
      descriptor: { ...tool("Example.ping"), owner: "example-feature" },
      execute: async () => ({ output: "" }),
    }),
    /invalid capability id/,
  );
  assert.throws(
    () => registry.register("polyth", {
      descriptor: { ...tool("polyth.mcp.stolen"), owner: "polyth", id: "polyth.mcp.stolen" },
      execute: async () => ({ output: "" }),
    }),
    /reserved/,
  );
});

test("space and project scope filters exclude other tenants and projects", () => {
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
    descriptor: { ...tool(), spaceId: "space-a", projectId: "proj" },
    execute: async () => ({ output: "pong" }),
  });
  assert.equal(registry.resolve(context).length, 1);
  assert.equal(registry.resolve({ ...context, spaceId: "space-b" }).length, 0);
  assert.equal(registry.resolve({ ...context, projectId: "other" }).length, 0);
});

test("session-scoped contributions disappear without a session", () => {
  const registry = createCapabilityContributionRegistry();
  registry.register("example-feature", {
    descriptor: { ...tool(), scope: "session" },
    execute: async () => ({ output: "pong" }),
  });
  assert.equal(registry.resolve(context).length, 0);
  assert.equal(registry.resolve({ ...context, sessionId: "s1" }).length, 1);
});

test("planner chooses native over unsupported and degrades remote-unsafe kinds", () => {
  const desired = [instruction(), tool()];
  const support: HarnessCapabilitySupport = {
    harnessId: "opencode",
    kinds: {
      instruction: { modes: ["config"], mutability: "immediate" },
      tool: { modes: ["mcp"], mutability: "requires-restart", remote: false },
    },
  };
  const local = planHarnessCapabilities("opencode", desired, support, { remote: false });
  assert.equal(local.items.find((item) => item.capability.kind === "instruction")?.mode, "config");
  assert.equal(local.items.find((item) => item.capability.kind === "tool")?.mode, "mcp");
  const remote = planHarnessCapabilities("opencode", desired, support, { remote: true });
  assert.equal(remote.items.find((item) => item.capability.kind === "tool")?.mode, "unsupported");
  assert.equal(remote.items.find((item) => item.capability.kind === "instruction")?.mode, "config");
});

test("planner refuses narrower scopes than the harness config target", () => {
  const desired = [tool()];
  const support: HarnessCapabilitySupport = {
    harnessId: "opencode",
    kinds: {
      tool: { modes: ["mcp"], mutability: "requires-restart", remote: false, configScope: "deployment" },
    },
  };
  const plan = planHarnessCapabilities("opencode", desired, support, { remote: false });
  assert.equal(plan.items[0]?.mode, "unsupported");
});

test("planner marks missing kinds unsupported without inventing a mode", () => {
  const plan = planHarnessCapabilities("acp", [instruction()], { harnessId: "cursor", kinds: {} }, { remote: false });
  assert.equal(plan.items[0]?.mode, "unsupported");
  assert.equal(plan.items[0]?.mutability, "immutable");
});

test("planner refuses colliding native MCP names instead of overwriting", () => {
  const support: HarnessCapabilitySupport = {
    harnessId: "claude",
    kinds: { "mcp-server": { modes: ["native"], mutability: "session-create" } },
  };
  const plan = planHarnessCapabilities("claude", [
    { id: "polyth.mcp.1", kind: "mcp-server", owner: "polyth", scope: "space", revision: "1", name: "linear", enabled: true, transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } },
    { id: "example-feature.linear", kind: "mcp-server", owner: "example-feature", scope: "space", revision: "1", name: "linear", enabled: true, transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } },
  ], support, { remote: false });
  assert.equal(plan.items.every((item) => item.mode === "unsupported"), true);
});

test("registry rejects reserved MCP names and pure+mutating tools", () => {
  const registry = createCapabilityContributionRegistry();
  assert.throws(() => registry.register("example-feature", {
    descriptor: {
      id: "example-feature.shadow",
      kind: "mcp-server",
      owner: "example-feature",
      scope: "space",
      revision: "1",
      name: "polyth-agent-tools",
      enabled: true,
      transport: { kind: "http", url: "https://x.example", headersSecretRefs: [] },
    },
  }), /reserved/);
  assert.throws(() => registry.register("example-feature", {
    descriptor: { ...tool(), mutating: true },
    execute: async () => ({ output: "" }),
  }), /pure and mutating/);
});

test("desired bundle revision is deterministic", () => {
  const a = [instruction(), tool()];
  const b = [tool(), instruction()];
  assert.equal(desiredBundleRevision(a), desiredBundleRevision(b));
  assert.notEqual(desiredBundleRevision(a), desiredBundleRevision([instruction("polyth.other")]));
});

test("launch overlay consumeIfRevision preserves a newer staged revision", () => {
  const store = createLaunchOverlayStore<{ value: string }>();
  store.set(context, { value: "one" }, "claude", { desiredRevision: "R1" });
  assert.equal(store.peek(context, "claude")?.desiredRevision, "R1");
  store.set(context, { value: "two" }, "claude", { desiredRevision: "R2" });

  assert.equal(store.consumeIfRevision(context, "claude", "R1"), undefined);
  assert.equal(store.peek(context, "claude")?.desiredRevision, "R2");
});

test("launch overlay consumeIfRevision deletes and returns an exact revision", () => {
  const store = createLaunchOverlayStore<{ value: string }>();
  store.set(context, { value: "one" }, "claude", { desiredRevision: "R1" });

  assert.equal(store.consumeIfRevision(context, "claude", "R1")?.value.value, "one");
  assert.equal(store.peek(context, "claude"), undefined);
});
