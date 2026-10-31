import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentCapabilityContribution,
  AgentCapabilityDescriptor,
  HarnessContext,
} from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";

type Contextual = AgentCapabilityContribution & {
  resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};

const context = (projectId: string): HarnessContext => ({
  spaceId: "space-a",
  projectId,
  cwd: `/tmp/${projectId}`,
});

test("contextual capabilities resolve through the shared registry and never leak projects", () => {
  const registry = createCapabilityContributionRegistry();
  registry.register("static-owner", {
    descriptor: {
      id: "static-owner.note",
      kind: "context",
      owner: "static-owner",
      scope: "space",
      spaceId: "space-a",
      revision: "1",
      title: "Static",
      text: "static",
    },
  });
  const dynamic = registry.register("commands", {
    descriptor: {
      id: "commands.skills.contextual",
      kind: "context",
      owner: "commands",
      scope: "space",
      spaceId: "space-a",
      revision: "1",
      title: "Managed skills",
      text: "",
    },
    resolveCapabilities(ctx: HarnessContext) {
      return [{
        id: `commands.skill.${ctx.projectId}`,
        kind: "skill",
        owner: "commands",
        scope: "project",
        spaceId: ctx.spaceId,
        projectId: ctx.projectId,
        revision: "1",
        name: `skill-${ctx.projectId}`,
        title: `skill-${ctx.projectId}`,
        description: "project skill",
        instructions: `only ${ctx.projectId}`,
      }];
    },
  } as Contextual);

  const a = registry.resolve(context("project-a"));
  const b = registry.resolve(context("project-b"));
  assert.deepEqual(a.map((row) => row.id), ["commands.skill.project-a", "static-owner.note"]);
  assert.deepEqual(b.map((row) => row.id), ["commands.skill.project-b", "static-owner.note"]);
  assert.equal(a.some((row) => row.id.includes("project-b")), false);
  assert.equal(b.some((row) => row.id.includes("project-a")), false);
  assert.equal(registry.list().some((row) => row.descriptor.id === "commands.skills.contextual"), false);

  dynamic.dispose();
  assert.deepEqual(registry.resolve(context("project-a")).map((row) => row.id), ["static-owner.note"]);
});

test("contextual resolution rejects duplicate effective ids", () => {
  const registry = createCapabilityContributionRegistry();
  const contextual = (resolverId: string, suffix: string): Contextual => ({
    descriptor: {
      id: `commands.${resolverId}`,
      kind: "context",
      owner: "commands",
      scope: "space",
      spaceId: "space-a",
      revision: "1",
      title: resolverId,
      text: "",
    },
    resolveCapabilities(ctx) {
      return [{
        id: "commands.skill.duplicate",
        kind: "skill",
        owner: "commands",
        scope: "project",
        spaceId: ctx.spaceId,
        projectId: ctx.projectId,
        revision: "1",
        name: `duplicate-${suffix}`,
        title: `duplicate-${suffix}`,
        description: "duplicate",
        instructions: suffix,
      }];
    },
  });
  registry.register("commands", contextual("resolver-a", "a"));
  registry.register("commands", contextual("resolver-b", "b"));
  assert.throws(() => registry.resolve(context("project-a")), /capability already resolved/);
});

test("contextual tool resolution preserves its canonical executor", async () => {
  const registry = createCapabilityContributionRegistry();
  const execute = async () => ({ output: "contextual pong" });
  registry.register("commands", {
    descriptor: {
      id: "commands.contextual-tool",
      kind: "tool",
      owner: "commands",
      scope: "project",
      projectId: "project-a",
      revision: "1",
      name: "contextual-ping",
      description: "Contextual ping",
      inputSchema: { type: "object", additionalProperties: false },
      trust: "pure",
      mutating: false,
    },
    resolveCapabilities() {
      return [{
        id: "commands.contextual-tool",
        kind: "tool",
        owner: "commands",
        scope: "project",
        projectId: "project-a",
        revision: "1",
        name: "contextual-ping",
        description: "Contextual ping",
        inputSchema: { type: "object", additionalProperties: false },
        trust: "pure",
        mutating: false,
      }];
    },
    execute,
  } as Contextual);

  assert.deepEqual(registry.resolve(context("project-a")).map((row) => row.id), ["commands.contextual-tool"]);
  assert.deepEqual(
    await registry.executor("commands.contextual-tool")!({}, { ...context("project-a"), sessionId: "s1" }),
    { output: "contextual pong" },
  );
});
