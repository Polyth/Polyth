// Model-facing tool bridge. This is NOT polyth-mcp (control plane).
// Harnesses receive a scoped stdio MCP that can invoke only currently
// registered package tools for the token's Space/project/session.
import { existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  AgentCapabilityContribution,
  AgentCapabilityDescriptor,
  AgentToolAuthorizationGrant,
  JsonObject,
  RouteHandler,
  SpaceStorage,
  ToolExecutor,
} from "@polyth/contracts";
import { semanticCapabilityRevision } from "@polyth/harness-runtime";

export const AGENT_TOOLS_MCP_NAME = "polyth-agent-tools";
export const AGENT_TOOLS_PATH = "/internal/agent-tools";
const POLYTH_SESSION_CONTROL_TOOL_ID = "harness-runtime.polyth-control";

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
  harnessId?: string;
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

/** Permission-engine verdict plus optional contribution auto-approve and UI prompt. */
export async function authorizePackageToolAfterPermissions(input: {
  tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>;
  grant: AgentToolAuthorizationGrant;
  contribution?: Pick<AgentCapabilityContribution, "autoApprove">;
  permissionVerdict: "allow" | "deny" | "ask";
  storage?: SpaceStorage;
  signal?: AbortSignal;
  requestPermission?: (
    grant: AgentToolAuthorizationGrant & {
      toolId: string;
      toolName: string;
      owner: string;
      signal?: AbortSignal;
    },
  ) => Promise<AgentToolAuthz>;
}): Promise<AgentToolAuthz> {
  if (input.permissionVerdict === "allow") return "allow";
  if (input.permissionVerdict === "deny") return "deny";
  const grant: AgentToolAuthorizationGrant = {
    ...input.grant,
    ...(input.storage ? { storage: input.storage } : {}),
  };
  if (input.contribution?.autoApprove) {
    try {
      if (await input.contribution.autoApprove(grant)) return "allow";
    } catch {
      // Fail closed to the permission prompt.
    }
  }
  if (!input.requestPermission) return "permission-required";
  try {
    const decision = await input.requestPermission({
      ...grant,
      toolId: input.tool.id,
      toolName: input.tool.name,
      owner: input.tool.owner,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return decision === "allow" || decision === "permission-required" || decision === "deny"
      ? decision
      : "deny";
  } catch {
    return "deny";
  }
}

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

const stringProjectTarget = (input: JsonObject): string | undefined => {
  const parameters = input.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  const projectId = (parameters as Record<string, unknown>).projectId;
  return typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined;
};

/**
 * Core Polyth session control is intentionally frictionless inside the caller's
 * own project, while any explicit external project target gets an independent
 * durable permission subject. The normal permission engine can therefore offer
 * once/session/project ("always") without granting every external project at
 * once. A deny on the base tool still wins before target-specific evaluation.
 */
export function polythSessionAuthorizationSubjects(
  tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>,
  grant: Pick<AgentToolGrant, "projectId">,
  input: JsonObject,
): Array<Extract<AgentCapabilityDescriptor, { kind: "tool" }>> {
  if (tool.id !== POLYTH_SESSION_CONTROL_TOOL_ID) return [tool];
  const baseGuard = { ...tool, trust: "pure" as const, mutating: false };
  const targetProjectId = stringProjectTarget(input);
  if (!targetProjectId || targetProjectId === grant.projectId) return [baseGuard];
  const targetKey = createHash("sha256").update(targetProjectId).digest("hex").slice(0, 20);
  return [
    baseGuard,
    {
      ...tool,
      id: `${tool.id}.external-project.${targetKey}`,
      name: `polyth external project ${targetProjectId}`,
    },
  ];
}

export function createAgentToolBridge(opts: {
  executor(id: string): ToolExecutor | undefined;
  contribution?(id: string): { descriptor: AgentCapabilityDescriptor; execute?: ToolExecutor } | undefined;
  resolveSession?: (grant: AgentToolGrant) => Promise<string | undefined>;
  requested?: (tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>, grant: AgentToolGrant) => Promise<void>;
  authorize?: (
    tool: Extract<AgentCapabilityDescriptor, { kind: "tool" }>,
    grant: AgentToolGrant,
    signal?: AbortSignal,
  ) => AgentToolAuthz | Promise<AgentToolAuthz>;
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
      const controller = new AbortController();
      const abort = () => controller.abort();
      rc.req.once?.("aborted", abort);
      rc.res?.once?.("close", abort);
      try {
        const sessionId = opts.resolveSession ? await opts.resolveSession(grant) : grant.sessionId;
        if (opts.resolveSession && !sessionId) {
          rc.json(403, { error: { code: "session-unavailable", message: "No unambiguous active Polyth session owns this request" } });
          return true;
        }
        const scopedGrant = { ...grant, ...(sessionId ? { sessionId } : {}) };
        if (controller.signal.aborted || rc.req.aborted || rc.res?.destroyed) return true;
        await opts.requested?.(descriptor, scopedGrant);
        const input = (body.arguments ?? {}) as JsonObject;
        const authorize = opts.authorize ?? defaultAuthorize;
        for (const subject of polythSessionAuthorizationSubjects(descriptor, scopedGrant, input)) {
          const decision = await authorize(subject, scopedGrant, controller.signal);
          if (decision === "deny") {
            rc.json(403, { error: { code: "forbidden", message: "tool is not permitted" } });
            return true;
          }
          if (decision === "permission-required") {
            rc.json(403, { error: { code: "permission-required", message: "Polyth authorization is required before this tool can run" } });
            return true;
          }
        }
        const liveGrant = grantFor(token);
        const liveBinding = liveGrant?.bindings.find((item) => item.id === id);
        const liveContribution = opts.contribution?.(id);
        const liveDescriptor = liveContribution?.descriptor.kind === "tool"
          ? liveContribution.descriptor
          : undefined;
        const liveExecute = liveContribution?.execute;
        if (!liveGrant || !liveBinding || !liveDescriptor || !liveExecute) {
          rc.json(404, { error: { code: "not-found", message: "tool is not available" } });
          return true;
        }
        if (liveContribution !== contribution || !matchesBinding(liveBinding, liveDescriptor)) {
          rc.json(403, { error: { code: "stale-capability", message: "tool grant no longer matches the registered capability" } });
          return true;
        }
        if (controller.signal.aborted || rc.req.aborted || rc.res?.destroyed) return true;
        if (opts.resolveSession && await opts.resolveSession(scopedGrant) !== sessionId) {
          rc.json(403, { error: { code: "session-unavailable", message: "The requesting Polyth session is no longer active" } });
          return true;
        }
        if (controller.signal.aborted || rc.req.aborted || rc.res?.destroyed) return true;
        if (grantFor(token) !== liveGrant || opts.contribution?.(id) !== liveContribution
          || !matchesBinding(liveBinding, liveDescriptor)) {
          rc.json(403, { error: { code: "stale-capability", message: "tool grant is no longer active" } });
          return true;
        }
        try {
          const result = await liveExecute(input, {
            sessionId: sessionId ?? "",
            signal: controller.signal,
            projectId: liveGrant.projectId,
            cwd: liveGrant.cwd,
            spaceId: liveGrant.spaceId,
          });
          rc.json(200, result);
        } catch (error) {
          rc.json(400, { error: { code: "tool-failed", message: (error as Error).message } });
        }
        return true;
      } finally {
        rc.req.off?.("aborted", abort);
        rc.res?.off?.("close", abort);
      }
    },
  };
}

/** JSON Schema writeOnly fields are execution inputs, never audit content. */
export function redactToolInput(input: JsonObject, schema: JsonObject): JsonObject {
  const visit = (value: unknown, definition: unknown): unknown => {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return value;
    const rule = definition as Record<string, unknown>;
    if (rule.writeOnly === true) return "[redacted]";
    if (Array.isArray(value)) return value.map((item) => visit(item, rule.items));
    if (!value || typeof value !== "object") return value;
    const properties = rule.properties as Record<string, unknown> | undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, properties?.[key])]));
  };
  return visit(input, schema) as JsonObject;
}
