import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentCapabilityContribution,
  AgentCapabilityDescriptor,
  AgentRuntime,
  HarnessContext,
  HarnessProvider,
  SpaceContext,
} from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createBehaviorService } from "../src/behavior.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createMcpConfigService } from "../src/mcp.ts";
import { mockHarnessRegistry } from "./harnessRegistryMock.ts";

type Contextual = AgentCapabilityContribution & {
  resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};

const temp = () => mkdtempSync(join(tmpdir(), "polyth-project-capabilities-"));
const spaceOf = (dir: string): SpaceContext => {
  const storageDir = join(dir, "space-a");
  mkdirSync(storageDir, { recursive: true });
  return {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "server-trusted",
    storageDir,
  };
};

const provider = (
  id: string,
  seen: Map<string, { capabilities: AgentCapabilityDescriptor[]; secrets: Record<string, Record<string, string>> }>,
): HarnessProvider => ({
  descriptor: { id, name: id, priority: 0, integration: "test" },
  probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
  createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
  provisioner: {
    support: () => ({
      harnessId: id,
      kinds: {
        "mcp-server": { modes: ["native"], mutability: "session-create" },
        skill: { modes: ["filesystem"], mutability: "session-create" },
      },
    }),
    apply: async (context, plan, resolver) => {
      const capabilities = plan.items.map((item) => item.capability);
      const secrets: Record<string, Record<string, string>> = {};
      for (const capability of capabilities) {
        if (capability.kind === "mcp-server") secrets[capability.id] = resolver.mcpSecrets(capability.id);
      }
      seen.set(`${id}:${context.projectId}`, { capabilities, secrets });
      return {
        harnessId: id,
        desiredRevision: plan.desiredRevision,
        records: plan.items.map((item) => ({
          capabilityId: item.capability.id,
          kind: item.capability.kind,
          owner: item.capability.owner,
          desiredRevision: item.capability.revision,
          mode: item.mode,
          status: item.mode === "unsupported" ? "unsupported" as const : "applied" as const,
          mutability: item.mutability,
          ...(item.mode === "unsupported" ? {} : { appliedRevision: item.capability.revision }),
        })),
      };
    },
  },
});

const mcpNames = (rows: AgentCapabilityDescriptor[]) => rows
  .filter((row): row is Extract<AgentCapabilityDescriptor, { kind: "mcp-server" }> => row.kind === "mcp-server")
  .filter((row) => !row.id.startsWith("polyth.mcp.retired."))
  .map((row) => row.name)
  .sort();
const skillNames = (rows: AgentCapabilityDescriptor[]) => rows
  .filter((row): row is Extract<AgentCapabilityDescriptor, { kind: "skill" }> => row.kind === "skill")
  .map((row) => row.name)
  .sort();

test("every compatible harness receives only the active project's effective MCPs and skills", async () => {
  const dir = temp();
  const space = spaceOf(dir);
  const owners = new Map([["project-a", "space-a"], ["project-b", "space-a"]]);
  const mcp = createMcpConfigService({
    dataDir: dir,
    deployment: "server-trusted",
    assertProject(ctx, projectId) {
      if (owners.get(projectId) !== ctx.spaceId) throw Object.assign(new Error("project not found"), { code: "not-found" });
    },
  });
  await mcp.create(space, {
    name: "shared",
    transport: { kind: "http", url: "https://shared.example", headersSecretRefs: ["TOKEN"] },
    secrets: { TOKEN: "shared-secret" },
  });
  await mcp.create(space, {
    name: "a-only",
    transport: { kind: "http", url: "https://a.example", headersSecretRefs: ["TOKEN"] },
    secrets: { TOKEN: "a-secret" },
  }, "project-a");
  await mcp.create(space, {
    name: "b-only",
    transport: { kind: "http", url: "https://b.example", headersSecretRefs: ["TOKEN"] },
    secrets: { TOKEN: "b-secret" },
  }, "project-b");
  await mcp.create(space, {
    name: "db",
    transport: { kind: "http", url: "https://db-a.example", headersSecretRefs: ["TOKEN"] },
    secrets: { TOKEN: "db-a-secret" },
  }, "project-a");
  await mcp.create(space, {
    name: "db",
    transport: { kind: "http", url: "https://db-b.example", headersSecretRefs: ["TOKEN"] },
    secrets: { TOKEN: "db-b-secret" },
  }, "project-b");

  const registry = createCapabilityContributionRegistry();
  registry.register("commands", {
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
    resolveCapabilities(context: HarnessContext) {
      return [{
        id: `commands.skill.${context.projectId}`,
        kind: "skill",
        owner: "commands",
        scope: "project",
        spaceId: context.spaceId,
        projectId: context.projectId,
        revision: "1",
        name: `skill-${context.projectId}`,
        title: `skill-${context.projectId}`,
        description: "project skill",
        instructions: `only for ${context.projectId}`,
      }];
    },
  } as Contextual);

  const seen = new Map<string, { capabilities: AgentCapabilityDescriptor[]; secrets: Record<string, Record<string, string>> }>();
  const claude = provider("claude", seen);
  const codex = provider("codex", seen);
  const controller = createCapabilityProvisioningController({
    contributions: registry,
    harnesses: mockHarnessRegistry(claude, codex),
    behavior: createBehaviorService({ file: join(dir, "behavior.md") }),
    mcp,
    file: join(dir, "status.json"),
  });

  const contextA: HarnessContext = { space, spaceId: "space-a", projectId: "project-a", cwd: "/tmp/project-a" };
  const contextB: HarnessContext = { space, spaceId: "space-a", projectId: "project-b", cwd: "/tmp/project-b" };
  await controller.reconcileAll(contextA);
  await controller.reconcileAll(contextB);

  for (const harnessId of ["claude", "codex"]) {
    const a = seen.get(`${harnessId}:project-a`)!;
    const b = seen.get(`${harnessId}:project-b`)!;
    assert.deepEqual(mcpNames(a.capabilities), ["a-only", "db", "shared"]);
    assert.deepEqual(mcpNames(b.capabilities), ["b-only", "db", "shared"]);
    assert.deepEqual(skillNames(a.capabilities), ["skill-project-a"]);
    assert.deepEqual(skillNames(b.capabilities), ["skill-project-b"]);
    assert.equal(a.capabilities.some((row) => row.kind === "mcp-server" && row.name === "b-only"), false);
    assert.equal(b.capabilities.some((row) => row.kind === "mcp-server" && row.name === "a-only"), false);

    const dbA = a.capabilities.find((row): row is Extract<AgentCapabilityDescriptor, { kind: "mcp-server" }> => row.kind === "mcp-server" && row.name === "db")!;
    const dbB = b.capabilities.find((row): row is Extract<AgentCapabilityDescriptor, { kind: "mcp-server" }> => row.kind === "mcp-server" && row.name === "db")!;
    assert.equal(dbA.transport.kind === "http" ? dbA.transport.url : "", "https://db-a.example");
    assert.equal(dbB.transport.kind === "http" ? dbB.transport.url : "", "https://db-b.example");
    assert.deepEqual(a.secrets[dbA.id], { TOKEN: "db-a-secret" });
    assert.deepEqual(b.secrets[dbB.id], { TOKEN: "db-b-secret" });
    assert.doesNotMatch(JSON.stringify(a), /b-secret|db-b-secret/);
    assert.doesNotMatch(JSON.stringify(b), /a-secret|db-a-secret/);
  }

  const desiredA = await controller.desired(contextA);
  const desiredB = await controller.desired(contextB);
  assert.deepEqual(mcpNames(desiredA), ["a-only", "db", "shared"]);
  assert.deepEqual(mcpNames(desiredB), ["b-only", "db", "shared"]);
  assert.deepEqual(skillNames(desiredA), ["skill-project-a"]);
  assert.deepEqual(skillNames(desiredB), ["skill-project-b"]);
});
