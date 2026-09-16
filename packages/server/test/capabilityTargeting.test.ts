import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCapabilityDescriptor, AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createBehaviorService } from "../src/behavior.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { mockHarnessRegistry } from "./harnessRegistryMock.ts";

const provider = (id: string, seen: string[][]): HarnessProvider => ({
  descriptor: { id, name: id, priority: 0, integration: "test" },
  probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
  createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
  provisioner: {
    support: () => ({
      harnessId: id,
      kinds: { instruction: { modes: ["prompt"], mutability: "session-create" } },
    }),
    apply: async (_context, plan) => {
      seen.push(plan.items.map((item) => item.capability.id));
      return {
        harnessId: id,
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
  },
});

test("harness-targeted capabilities are absent from other harness bundles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-targeted-capability-"));
  const space = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir: dir,
  } as SpaceContext;
  const context = { spaceId: space.spaceId, projectId: "p", cwd: join(dir, "project"), space };
  const contributions = createCapabilityContributionRegistry();
  contributions.register("fixture", {
    descriptor: {
      id: "fixture.claude-system-prompt",
      kind: "instruction",
      owner: "fixture",
      scope: "space",
      revision: "1",
      text: "Claude only",
      targetHarnessId: "claude",
    } as AgentCapabilityDescriptor & { targetHarnessId: string },
  });

  const claudePlans: string[][] = [];
  const codexPlans: string[][] = [];
  const claude = provider("claude", claudePlans);
  const codex = provider("codex", codexPlans);
  const controller = createCapabilityProvisioningController({
    contributions,
    harnesses: mockHarnessRegistry(claude, codex),
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir: dir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dir, "status.json"),
  });

  await controller.reconcile(claude, context);
  await controller.reconcile(codex, context);

  assert.ok(claudePlans.at(-1)?.includes("fixture.claude-system-prompt"));
  assert.equal(codexPlans.at(-1)?.includes("fixture.claude-system-prompt"), false);
  assert.ok(claudePlans.at(-1)?.includes("polyth.behavior"));
  assert.ok(codexPlans.at(-1)?.includes("polyth.behavior"));
  assert.notEqual(controller.status(context, "claude")[0]?.desiredRevision, controller.status(context, "codex")[0]?.desiredRevision);
});
