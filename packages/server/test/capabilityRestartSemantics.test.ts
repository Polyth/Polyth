import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createBehaviorService } from "../src/behavior.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { mockHarnessRegistry } from "./harnessRegistryMock.ts";

const spaceOf = (dir: string): SpaceContext => ({
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: dir,
});

test("physical-runtime restart and settlement are driven by contract semantics, not harness id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-generic-restart-"));
  const space = spaceOf(dir);
  const context = {
    spaceId: space.spaceId,
    projectId: "project-a",
    cwd: "/workspace/a",
    space,
  };
  const registry = createCapabilityContributionRegistry();
  const registerContext = (revision: string, text: string) => registry.register("example-feature", {
    descriptor: {
      id: "example-feature.context",
      kind: "context",
      owner: "example-feature",
      scope: "project",
      projectId: context.projectId,
      revision,
      title: "Project context",
      text,
    },
  });
  let contribution = registerContext("1", "first");
  const harnessId = "generic-physical";
  const harness: HarnessProvider = {
    descriptor: { id: harnessId, name: "Generic physical", priority: 0, integration: "test" },
    probe: async () => ({ harnessId, installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: {
      support: () => ({
        harnessId,
        targetLifetime: "physical-runtime",
        kinds: {
          instruction: { modes: ["config"], mutability: "requires-restart", configScope: "project" },
          context: { modes: ["config"], mutability: "requires-restart", configScope: "project" },
        },
      }),
      apply: async (_ctx, plan) => ({
        harnessId,
        desiredRevision: plan.desiredRevision,
        records: plan.items.map((item) => ({
          capabilityId: item.capability.id,
          kind: item.capability.kind,
          owner: item.capability.owner,
          desiredRevision: item.capability.revision,
          mode: item.mode,
          status: item.mode === "unsupported" ? "unsupported" as const : "pending" as const,
          mutability: item.mutability,
        })),
      }),
    },
  };
  const restarts: Array<{ harnessId: string; desiredRevision: string }> = [];
  const settled: Array<{ harnessId: string; desiredRevision: string }> = [];
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(harness),
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dir, "status.json"),
    onCapabilityRestartRequired: ({ harnessId: id, desiredRevision }) => restarts.push({ harnessId: id, desiredRevision }),
    onCapabilityRevisionSettled: ({ harnessId: id, desiredRevision }) => settled.push({ harnessId: id, desiredRevision }),
  });

  const first = await controller.reconcile(harness, context);
  controller.acknowledge({
    target: {
      spaceId: context.spaceId,
      projectId: context.projectId,
      cwd: context.cwd,
      harnessId,
      authorityId: "authority-1",
      generation: 1,
    },
    desiredRevision: first.desiredRevision,
    capabilityIds: first.records.filter((row) => row.status === "pending").map((row) => row.capabilityId),
    outcome: "applied",
  });
  assert.equal(controller.status(context, harnessId)[0]?.records.find((row) => row.capabilityId === "example-feature.context")?.status, "applied");
  assert.deepEqual(settled.at(-1), { harnessId, desiredRevision: first.desiredRevision });

  contribution.dispose();
  contribution = registerContext("2", "second");
  const second = await controller.reconcile(harness, context);
  assert.equal(second.records.find((row) => row.capabilityId === "example-feature.context")?.status, "pending-restart");
  assert.deepEqual(restarts.at(-1), { harnessId, desiredRevision: second.desiredRevision });

  controller.acknowledge({
    target: {
      spaceId: context.spaceId,
      projectId: context.projectId,
      cwd: context.cwd,
      harnessId,
      authorityId: "authority-2",
      generation: 2,
    },
    desiredRevision: second.desiredRevision,
    capabilityIds: second.records.map((row) => row.capabilityId),
    outcome: "applied",
  });
  assert.equal(controller.status(context, harnessId)[0]?.records.find((row) => row.capabilityId === "example-feature.context")?.status, "applied");
  assert.deepEqual(settled.at(-1), { harnessId, desiredRevision: second.desiredRevision });

  contribution.dispose();
  const third = await controller.reconcile(harness, context);
  assert.equal(third.records.find((row) => row.capabilityId === "example-feature.context")?.status, "pending-restart");
  assert.deepEqual(restarts.at(-1), { harnessId, desiredRevision: third.desiredRevision });
  controller.dispose();
});
