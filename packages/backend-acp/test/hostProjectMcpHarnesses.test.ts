import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentCapabilityDescriptor, HarnessContext, HarnessProvisioner, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCapabilityContributionRegistry, planHarnessCapabilities } from "@polyth/harness-runtime";
import { registerProjectMcpTool } from "../../harness-runtime/src/projectMcpTool.ts";
import { createMcpConfigService } from "../../server/src/mcp.ts";
import { acpOverlays, createAcpProvisioner } from "../src/provisioner.ts";
import { claudeOverlays, createClaudeProvisioner } from "../../backend-claude/src/provisioner.ts";
import { codexOverlays, createCodexProvisioner } from "../../backend-codex/src/provisioner.ts";
import { createOpenCodeProvisioner, peekOpenCodeLaunchOverlay } from "../../backend-opencode/src/provisioner.ts";
import type { BackendConfigApplier } from "../../backend-opencode/src/config.ts";
import { antigravityOverlays, createAntigravityProvisioner } from "../../backend-antigravity/src/provisioner.ts";
import { commandCodeOverlays, createCommandCodeProvisioner } from "../../backend-commandcode/src/provisioner.ts";
import { piOverlays, createPiProvisioner } from "../../backend-pi/src/provisioner.ts";

const adapters: Array<{ id: string; create(): HarnessProvisioner; read(context: HarnessContext): unknown; portable?: boolean }> = [
  { id: "codex", create: createCodexProvisioner, read: (ctx) => codexOverlays.peek(ctx, "codex")?.value },
  { id: "claude", create: createClaudeProvisioner, read: (ctx) => claudeOverlays.peek(ctx, "claude")?.value },
  { id: "opencode", create: () => createOpenCodeProvisioner({} as BackendConfigApplier), read: peekOpenCodeLaunchOverlay },
  { id: "antigravity", create: createAntigravityProvisioner, read: (ctx) => antigravityOverlays.peek(ctx, "antigravity")?.value },
  ...["cursor", "deepseek", "fx", "grok", "omp"].map((id) => ({ id, create: () => createAcpProvisioner(id, true), read: (ctx: HarnessContext) => acpOverlays.peek(ctx, id)?.value })),
  { id: "commandcode", create: createCommandCodeProvisioner, read: (ctx) => commandCodeOverlays.peek(ctx, "commandcode")?.value, portable: true },
  { id: "pi", create: createPiProvisioner, read: (ctx) => piOverlays.peek(ctx, "pi")?.value, portable: true },
];

for (const adapter of adapters) {
  test(`${adapter.id}: the effective project MCP set and portable access stay isolated and reach the real provisioner`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "polyth-project-mcp-harness-"));
    const storageDir = join(root, "space");
    mkdirSync(storageDir);
    const space: SpaceContext = { spaceId: "space", spaceSlug: "space", storageDir, userId: "user", role: "owner", deployment: "server-trusted" };
    const context = (projectId: string): HarnessContext => ({ space, spaceId: space.spaceId, projectId, sessionId: `session-${projectId}`, cwd: root });
    const a = context("a"), b = context("b");
    const mcp = createMcpConfigService({ dataDir: root, assertProject: (_s, p) => { if (p !== "a" && p !== "b") throw new Error("not found"); } });
    await mcp.create(space, { name: "shared", transport: { kind: "http", url: "https://shared.invalid/mcp", headersSecretRefs: [] } });
    await mcp.create(space, { name: "shared", transport: { kind: "stdio", command: "node", args: ["a-only.mjs", "path with spaces"], envKeys: ["PROJECT_KEY"] }, secrets: { PROJECT_KEY: "a-synthetic-secret" } }, "a");
    await mcp.create(space, { name: "b-only", transport: { kind: "stdio", command: "node", args: ["b-only.mjs"], envKeys: [] } }, "b");
    const registry = createCapabilityContributionRegistry(), services = createServerServiceRegistry();
    services.provide(serverServiceKey("harness.capabilities"), registry);
    services.provide(serverServiceKey("mcp.project"), mcp);
    const registration = registerProjectMcpTool({ services } as ServerPackageHost);
    t.after(() => registration.dispose());
    const provider = adapter.create();
    t.after(() => { provider.release?.(a); provider.release?.(b); });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const apply = async (ctx: HarnessContext) => {
      const snapshot = mcp.projection(space, ctx.projectId);
      const servers: AgentCapabilityDescriptor[] = snapshot.servers.map((s) => ({
        id: `polyth.mcp.${s.id}`, kind: "mcp-server", owner: "polyth", scope: s.projectId ? "project" : "space", spaceId: space.spaceId,
        ...(s.projectId ? { projectId: s.projectId } : {}), revision: String(s.revision), name: s.name, enabled: s.enabled, transport: s.transport,
      }));
      const tools = registry.resolve(ctx);
      assert.equal(tools[0]?.kind, "tool");
      assert.equal(tools[0]?.name, "polyth_mcp");
      const bridge: AgentCapabilityDescriptor = { id: "polyth.agent-tools", kind: "mcp-server", owner: "polyth", scope: "session", revision: "bridge", name: "polyth-agent-tools", enabled: true, transport: { kind: "stdio", command: "node", args: ["bridge.mjs"], envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN"] } };
      const plan = planHarnessCapabilities(adapter.id, [...servers, bridge, ...tools], await provider.support(ctx), ctx);
      const result = await provider.apply(ctx, plan, { mcpSecrets: (id) => id === "polyth.agent-tools" ? { POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:9/internal/agent-tools", POLYTH_AGENT_TOOLS_TOKEN: "synthetic-bridge-token" } : snapshot.secretsFor(id.replace(/^polyth\.mcp\./, "")) });
      assert.equal(result.records.find((r) => r.capabilityId === tools[0]!.id)?.status, "pending");
      const managed = result.records.filter((r) => r.capabilityId.startsWith("polyth.mcp."));
      assert.ok(managed.length > 0);
      assert.ok(managed.every((r) => r.status === (adapter.portable ? "unsupported" : "pending")), JSON.stringify(managed));
      const overlay = adapter.read(ctx);
      assert.ok(overlay, `${adapter.id} must stage its project overlay`);
      if (adapter.portable) {
        const path = adapter.id === "pi" ? (overlay as { extensionFile: string }).extensionFile : (overlay as { toolModFile: string }).toolModFile;
        assert.match(readFileSync(path, "utf8"), /polyth_mcp/);
        assert.doesNotMatch(readFileSync(path, "utf8"), /a-synthetic-secret|synthetic-bridge-token/);
      }
      return JSON.stringify(overlay);
    };
    const stagedA = await apply(a);
    const stagedB = await apply(b);
    if (!adapter.portable) {
      assert.match(stagedA, /a-only\.mjs/);
      assert.doesNotMatch(stagedA, /b-only\.mjs|shared\.invalid/);
      assert.match(stagedB, /b-only\.mjs|shared\.invalid/);
      assert.doesNotMatch(stagedB, /a-only\.mjs|a-synthetic-secret/);
    }
    assert.equal(JSON.stringify(adapter.read(a)), stagedA, "provisioning project B must not mutate project A");
  });
}
