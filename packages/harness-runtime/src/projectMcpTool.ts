import type { AgentCapabilityContributionRegistry, HarnessContext, JsonObject, SpaceContext } from "@polyth/contracts";
import type { ProjectMcpService } from "@polyth/contracts/capability-installations";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import type { ContextualCapabilityContribution } from "./contextualCapabilities.ts";

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: "invalid-input" }); };
const key = (spaceId: string, projectId: string, sessionId?: string): string => JSON.stringify([spaceId, projectId, sessionId ?? ""]);

/** Portable access for engines without a native per-session MCP config seam.
 * Uses the same scoped grant and permission gate as all other package tools. */
export function registerProjectMcpTool(host: ServerPackageHost) {
  const spaces = new Map<string, SpaceContext>();
  const registry = host.services.require(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
  const descriptor = {
    id: "harness-runtime.project-mcp",
    kind: "tool" as const,
    owner: "harness-runtime",
    scope: "project" as const,
    revision: "1",
    name: "polyth_mcp",
    description: "Use MCP servers installed for this Polyth project, plus your own personal servers when this chat is private to you. List servers with action=list; read cached tool schemas with action=tools; initialize and discover tools with action=inspect; invoke one tool with action=call, serverId, toolName and arguments. This is the portable MCP path for engines without native MCP configuration. Calls are permission-gated, executed once, and never automatically retried after an uncertain outcome. Only this session's project is accessible.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "tools", "inspect", "call"] },
        serverId: { type: "string", description: "Installation id returned by list." },
        toolName: { type: "string" },
        arguments: { type: "object" },
      },
    },
    trust: "privileged" as const,
    mutating: true,
  };
  const contribution: ContextualCapabilityContribution = {
    descriptor,
    resolveCapabilities(context: HarnessContext) {
      if (!context.space || !context.sessionId || context.projectId === "__default__" || context.remote) return [];
      spaces.set(key(context.spaceId, context.projectId, context.sessionId), context.space);
      return [descriptor];
    },
    async execute(input, ctx): Promise<{ output: string; metadata?: JsonObject }> {
      const space = ctx.spaceId ? spaces.get(key(ctx.spaceId, ctx.projectId, ctx.sessionId)) : undefined;
      if (!space) throw Object.assign(new Error("MCP access requires an authenticated project session"), { code: "forbidden" });
      const scoped = host.forSpace(space);
      const session = await scoped.sessions.snapshot(ctx.sessionId);
      if (session.projectId !== ctx.projectId || !await scoped.projects.get(ctx.projectId)) throw Object.assign(new Error("project session not found"), { code: "not-found" });
      const service = host.services.require(serverServiceKey<ProjectMcpService>("mcp.project"));
      const action = input.action;
      // Personal servers (Spaces §14.6) appear only when the acting person
      // owns this chat and nobody else can open it; the service decides.
      const scope = { sessionId: ctx.sessionId, ...(ctx.actorUserId ? { actorUserId: ctx.actorUserId } : {}) };
      if (action === "list") {
        const servers = service.list(space, ctx.projectId, scope).map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, scope: s.scope, status: s.status, tools: s.inspection?.tools.map((t) => t.name) ?? [] }));
        return { output: JSON.stringify({ servers }), metadata: { action, projectId: ctx.projectId } };
      }
      if (typeof input.serverId !== "string" || !input.serverId) return invalid("serverId is required");
      if (action === "tools" || action === "inspect") {
        const result = action === "inspect" ? await service.test(space, input.serverId, ctx.projectId, scope) : service.tools(space, input.serverId, ctx.projectId, scope);
        return { output: JSON.stringify(result), metadata: { action, projectId: ctx.projectId, serverId: input.serverId } };
      }
      if (action !== "call") return invalid("unsupported MCP action");
      if (typeof input.toolName !== "string" || !input.toolName || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return invalid("toolName and an arguments object are required");
      const result = await service.call(space, input.serverId, ctx.projectId, { toolName: input.toolName, arguments: input.arguments as JsonObject, sessionId: ctx.sessionId, cwd: ctx.cwd, signal: ctx.signal, ...(ctx.actorUserId ? { actorUserId: ctx.actorUserId } : {}) });
      if (result.isError) throw Object.assign(new Error(JSON.stringify(result.content)), { code: "mcp-tool-error" });
      return { output: JSON.stringify(result), metadata: { action, projectId: ctx.projectId, serverId: input.serverId, toolName: input.toolName } };
    },
  };
  const registration = registry.register("harness-runtime", contribution);
  return { dispose() { spaces.clear(); return registration.dispose(); } };
}
