import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessContext, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import type { ProjectMcpService } from "@polyth/contracts/capability-installations";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { registerProjectMcpTool } from "../src/projectMcpTool.ts";

const space: SpaceContext = { spaceId: "space-a", spaceSlug: "a", userId: "user-a", role: "owner", deployment: "server-trusted", storageDir: "/tmp/mcp-tool-space" };
const context: HarnessContext = { space, spaceId: space.spaceId, projectId: "project-a", sessionId: "session-a", cwd: "/worktree-a" };
const callContext: ToolExecutionContext = { spaceId: space.spaceId, projectId: context.projectId, sessionId: context.sessionId!, cwd: context.cwd };

test("portable MCP contribution is permission-gated, scoped to an admitted session and disposed cleanly", async () => {
  const registry = createCapabilityContributionRegistry(), services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const called: unknown[] = [];
  const service: ProjectMcpService = {
    list: (_s, p) => [{ id: "server-a", name: "project-server", enabled: true, scope: "project", projectId: p, revision: 1, status: "starting", transport: { kind: "stdio", command: "private-command", args: ["private-config"], envKeys: [] } }],
    tools: () => ({ ok: false, checkedAt: 0, message: "Not checked", tools: [] }),
    test: async () => ({ ok: true, checkedAt: 1, message: "Connected", tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    call: async (s, id, p, input) => { called.push({ s, id, p, input }); return { content: [{ type: "text", text: "pong" }] }; },
  };
  services.provide(serverServiceKey("mcp.project"), service);
  const host = {
    services,
    forSpace: (s: SpaceContext) => {
      assert.equal(s.spaceId, space.spaceId);
      return {
        projects: { get: async (id: string) => id === "project-a" ? { id } : undefined },
        sessions: { snapshot: async () => ({ id: "session-a", projectId: "project-a" }) },
      };
    },
  } as unknown as ServerPackageHost;
  const registration = registerProjectMcpTool(host);
  assert.deepEqual(registry.resolve({ ...context, remote: true }), []);
  assert.deepEqual(registry.resolve({ ...context, sessionId: undefined }), []);
  const [descriptor] = registry.resolve(context);
  assert.equal(descriptor!.kind, "tool");
  if (descriptor?.kind !== "tool") assert.fail("tool expected");
  assert.equal(descriptor.trust, "privileged");
  assert.equal(descriptor.mutating, true);
  const execute = registry.executor(descriptor.id)!;
  const listed = await execute({ action: "list", projectId: "foreign-project" }, callContext);
  assert.match(listed.output, /project-server/);
  assert.doesNotMatch(listed.output, /private-command|private-config|foreign-project/);
  await execute({ action: "call", serverId: "server-a", toolName: "ping", arguments: { value: 1 } }, callContext);
  assert.equal(called.length, 1);
  assert.equal((called[0] as { p: string }).p, context.projectId);
  assert.equal((called[0] as { input: { cwd: string } }).input.cwd, context.cwd);
  await assert.rejects(execute({ action: "call", serverId: "server-a", toolName: "ping", arguments: {} }, { ...callContext, spaceId: "known-foreign-space" }), { code: "forbidden" });
  await assert.rejects(execute({ action: "list" }, { ...callContext, sessionId: "other-session" }), { code: "forbidden" });
  await assert.rejects(execute({ action: "call", serverId: "server-a", toolName: "ping", arguments: [] }, callContext), { code: "invalid-input" });
  assert.equal(called.length, 1);
  await registration.dispose();
  assert.deepEqual(registry.resolve(context), []);
  await assert.rejects(execute({ action: "list" }, callContext), { code: "forbidden" });
  const again = registerProjectMcpTool(host);
  assert.equal(registry.resolve(context).length, 1);
  await again.dispose();
});

test("portable MCP returns tool errors as failures instead of successful invocations", async () => {
  const registry = createCapabilityContributionRegistry(), services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  services.provide(serverServiceKey("mcp.project"), {
    call: async () => ({ isError: true, content: [{ type: "text", text: "Tool rejected input" }] }),
  });
  const host = { services, forSpace: () => ({ sessions: { snapshot: async () => ({ projectId: context.projectId }) }, projects: { get: async () => ({ id: context.projectId }) } }) } as unknown as ServerPackageHost;
  const registration = registerProjectMcpTool(host);
  const [tool] = registry.resolve(context);
  const execute = registry.executor(tool!.id)!;
  await assert.rejects(execute({ action: "call", serverId: "a", toolName: "fail", arguments: {} }, callContext), { code: "mcp-tool-error" });
  await registration.dispose();
});
