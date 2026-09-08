// Model-facing tool bridge. This is NOT polyth-mcp (control plane).
// Harnesses receive a scoped stdio MCP that can invoke only currently
// registered package tools for the token's Space/project/session.
import { existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentCapabilityDescriptor, JsonObject, RouteHandler, ToolExecutor } from "@polyth/contracts";
import { semanticCapabilityRevision } from "@polyth/harness-runtime";

export const AGENT_TOOLS_MCP_NAME = "polyth-agent-tools";
export const AGENT_TOOLS_PATH = "/internal/agent-tools";

export interface AgentToolBinding {
  id: string;
  owner: string;
  revision: string;
  trust: Extract<AgentCapabilityDescriptor, { kind: "tool" }>["trust"];
  mutating: boolean;
  /** Full semantic hash of the descriptor at mint time, independent of
   * whatever `revision` string the contribution happened to carry. Recomputed
   * from the live contribution at invoke time so any drift — not just a
   * `revision` field change — fails closed. */
  digest: string;
}

export interface AgentToolGrant {
  token: string;
  spaceId: string;
  projectId: string;
  cwd: string;
  sessionId?: string;
  tools: Array<Extract<AgentCapabilityDescriptor, { kind: "tool" }>>;
  bindings: AgentToolBinding[];
}

export type AgentToolAuthz = "allow" | "deny" | "permission-required";

export interface AgentToolBridge {
  mint(grant: Omit<AgentToolGrant, "token" | "bindings">): AgentToolGrant;
  revoke(token: string): void;
  stdioCommand(endpoint: string, token: string): { command: string; args: string[]; env: Record<string, string> };
  route: RouteHandler;
}

const mcpScript = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "agentToolsMcp.mjs"),
    typeof process.resourcesPath === "string" ? join(process.resourcesPath, "server", "agentToolsMcp.mjs") : "",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
};

const nodeCommand = (): { command: string; env: Record<string, string> } => {
  if (process.versions.electron) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: process.execPath, env: {} };
};

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const defaultAuthorize = (
  tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>,
): AgentToolAuthz =>
  tool.trust === "pure" && tool.mutating === false ? "allow" : "permission-required";

const bindingOf = (
  tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>,
): AgentToolBinding => ({
  id: tool.id,
  owner: tool.owner,
  revision: tool.revision,
  trust: tool.trust,
  mutating: tool.mutating,
  digest: semanticCapabilityRevision(tool),
});

export function createAgentToolBridge(opts: {
  executor(id: string): ToolExecutor | undefined;
  contribution?(id: string): { descriptor: AgentCapabilityDescriptor; execute?: ToolExecutor } | undefined;
  authorize?: (tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>, grant: AgentToolGrant) => AgentToolAuthz;
}): AgentToolBridge {
  const grants = new Map<string, AgentToolGrant>();
  const grantFor = (token: string | undefined): AgentToolGrant | undefined => {
    if (!token) return undefined;
    for (const grant of grants.values()) {
      if (equal(grant.token, token)) return grant;
    }
    return undefined;
  };

  const matchesBinding = (
    binding: AgentToolBinding,
    descriptor: Extract<AgentCapabilityDescriptor, { kind: "tool" }>,
  ): boolean =>
    binding.id === descriptor.id
    && binding.owner === descriptor.owner
    && binding.revision === descriptor.revision
    && binding.trust === descriptor.trust
    && binding.mutating === descriptor.mutating
    && binding.digest === semanticCapabilityRevision(descriptor);

  return {
    mint(input) {
      const token = randomBytes(32).toString("hex");
      const grant: AgentToolGrant = {
        ...input,
        token,
        bindings: input.tools.map(bindingOf),
      };
      grants.set(token, grant);
      return grant;
    },
    revoke(token) {
      grants.delete(token);
    },
    stdioCommand(endpoint, token) {
      const node = nodeCommand();
      return {
        command: node.command,
        args: [mcpScript()],
        env: {
          ...node.env,
          POLYTH_AGENT_TOOLS_URL: endpoint,
          POLYTH_AGENT_TOOLS_TOKEN: token,
        },
      };
    },
    async route(rc) {
      if (rc.path !== AGENT_TOOLS_PATH) return false;
      if (rc.ingress.kind !== "public-http" || rc.ingress.loopback !== true) {
        rc.json(403, { error: { code: "forbidden", message: "agent tools are local-only" } });
        return true;
      }
      const header = rc.req.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : undefined;
      const grant = grantFor(token);
      if (!grant) {
        rc.json(401, { error: { code: "unauthorized", message: "invalid tool token" } });
        return true;
      }
      if (rc.method === "GET") {
        rc.json(200, {
          tools: grant.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return true;
      }
      if (rc.method !== "POST") {
        rc.json(405, { error: { code: "invalid-input", message: "GET or POST required" } });
        return true;
      }
      const body = await rc.body();
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        rc.json(400, { error: { code: "invalid-input", message: "tool id is required" } });
        return true;
      }
      // Look up the live contribution FIRST, and execute ONLY that same
      // object's `execute`. Two independent lookups (a descriptor from one
      // call, an executor from another) can observe different generations of
      // a package's registration across the gap between them — invoking
      // whichever executor happened to still be live is a fail-open bypass
      // of the binding check below.
      const tool = grant.tools.find((item) => item.id === id);
      const binding = grant.bindings.find((item) => item.id === id);
      const contribution = opts.contribution?.(id);
      const descriptor = contribution?.descriptor.kind === "tool" ? contribution.descriptor : undefined;
      const execute = contribution?.execute;
      if (!tool || !binding || !contribution || !descriptor || !execute) {
        rc.json(404, { error: { code: "not-found", message: "tool is not available" } });
        return true;
      }
      if (!matchesBinding(binding, descriptor)) {
        rc.json(403, { error: { code: "stale-capability", message: "tool grant no longer matches the registered capability" } });
        return true;
      }
      const decision = (opts.authorize ?? defaultAuthorize)(descriptor, grant);
      if (decision === "deny") {
        rc.json(403, { error: { code: "forbidden", message: "tool is not permitted" } });
        return true;
      }
      if (decision === "permission-required") {
        rc.json(403, { error: { code: "permission-required", message: "Polyth authorization is required before this tool can run" } });
        return true;
      }
      try {
        const result = await execute((body.arguments ?? {}) as JsonObject, {
          sessionId: grant.sessionId ?? "",
          projectId: grant.projectId,
          cwd: grant.cwd,
          spaceId: grant.spaceId,
        });
        rc.json(200, result);
      } catch (error) {
        rc.json(400, { error: { code: "tool-failed", message: (error as Error).message } });
      }
      return true;
    },
  };
}
