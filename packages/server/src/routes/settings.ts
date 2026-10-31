// Settings routes: global behavior instructions, system info, MCP configuration,
// and the managed plugin registry. Secret values never leave this boundary —
// requests may carry them in, responses only ever name their keys.
import type { AgentDescriptor, ClientSettingsDto, McpTransport, ModelRef, SystemInfoDto } from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { RouteHandler } from "../http.ts";
import type { BehaviorService } from "../behavior.ts";
import type { ClientSettingsService } from "../clientSettings.ts";
import type { McpConfigService } from "../mcp.ts";

export interface SettingsRouteDeps {
  behavior: BehaviorService;
  mcp: McpConfigService;
  systemInfo(local: boolean): SystemInfoDto;
  saveRole?(name: string, role: { prompt?: string; model?: ModelRef; mode: AgentDescriptor["mode"] }): Promise<AgentDescriptor>;
  /** Server-persisted client preferences, isolated by authenticated account. */
  clientSettings?: ClientSettingsService;
  /** Live fan-out is explicitly account-scoped; never publish this blob deployment-wide. */
  broadcastClientSettings?(userId: string, state: ClientSettingsDto): void;
}

const parseTransport = (raw: unknown): McpTransport => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("MCP transport is required"), { code: "invalid-input" });
  const t = raw as Record<string, unknown>;
  if (t.kind === "stdio") {
    if (typeof t.command !== "string" || !Array.isArray(t.args) || t.args.some((a) => typeof a !== "string") || !Array.isArray(t.envKeys) || t.envKeys.some((a) => typeof a !== "string")) throw Object.assign(new Error("Invalid stdio transport"), { code: "invalid-input" });
    return {
      kind: "stdio",
      command: t.command,
      args: t.args as string[],
      envKeys: t.envKeys as string[],
    };
  }
  if (t.kind !== "http" || typeof t.url !== "string" || !Array.isArray(t.headersSecretRefs) || t.headersSecretRefs.some((a) => typeof a !== "string")) throw Object.assign(new Error("Invalid HTTP transport"), { code: "invalid-input" });
  return {
    kind: "http",
    url: t.url,
    headersSecretRefs: t.headersSecretRefs as string[],
  };
};

const parseSecrets = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("MCP secrets must be a map of strings"), { code: "invalid-input" });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") throw Object.assign(new Error("MCP secrets must be strings"), { code: "invalid-input" });
    Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
  }
  return Object.keys(out).length ? out : undefined;
};

export function settingsRoutes(deps: SettingsRouteDeps): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;

    // ---- behavior instructions ------------------------------------------------
    if (path === "/api/settings/behavior" && method === "GET") {
      rc.json(200, await deps.behavior.get());
      return true;
    }
    if (path === "/api/settings/behavior" && method === "PUT") {
      requireInstanceOwnerAuthority(rc, "global behavior changes require the instance owner");
      const b = await rc.body();
      rc.json(200, await deps.behavior.put(String(b.text ?? ""), String(b.expectedRevision ?? "")));
      return true;
    }
    if (path === "/api/settings/behavior/subagents" && method === "GET") {
      rc.json(200, await deps.behavior.subagentPolicy());
      return true;
    }
    if (path === "/api/settings/behavior/subagents" && method === "PUT") {
      requireInstanceOwnerAuthority(rc, "global behavior changes require the instance owner");
      const b = await rc.body();
      if (typeof b.enabled !== "boolean") {
        throw Object.assign(new Error("enabled must be a boolean"), { code: "invalid-input" });
      }
      rc.json(200, await deps.behavior.putSubagentPolicy(b.enabled));
      return true;
    }
    if (path === "/api/settings/behavior/workspace-instructions" && method === "GET") {
      rc.json(200, await deps.behavior.workspaceInstructionsPolicy());
      return true;
    }
    if (path === "/api/settings/behavior/workspace-instructions" && method === "PUT") {
      requireInstanceOwnerAuthority(rc, "global behavior changes require the instance owner");
      const b = await rc.body();
      if (typeof b.enabled !== "boolean") {
        throw Object.assign(new Error("enabled must be a boolean"), { code: "invalid-input" });
      }
      rc.json(200, await deps.behavior.putWorkspaceInstructionsPolicy(b.enabled));
      return true;
    }

    // ---- account-owned client preferences -----------------------------------
    if (path === "/api/settings/client" && deps.clientSettings) {
      const userId = rc.space.userId;
      if (method === "GET") {
        rc.json(200, deps.clientSettings.get(userId));
        return true;
      }
      if (method === "PUT") {
        const b = await rc.body();
        const input = b as { settings?: unknown; expectedRevision?: number };
        const next = deps.clientSettings.put(userId, input.settings, input.expectedRevision);
        deps.broadcastClientSettings?.(userId, next);
        rc.json(200, next);
        return true;
      }
    }

    // ---- system info ------------------------------------------------------------
    if (path === "/api/system/info" && method === "GET") {
      if (rc.principal.kind === "anonymous") {
        throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
      }
      if (rc.principal.kind === "paired-device") {
        throw Object.assign(new Error("not allowed"), { code: "forbidden" });
      }
      const revealLocal = (rc.principal.kind === "local-user" || rc.principal.kind === "ui-session")
        && rc.ingress.kind === "public-http"
        && rc.ingress.loopback;
      rc.json(200, deps.systemInfo(revealLocal));
      return true;
    }

    const roleMatch = path.match(/^\/api\/settings\/roles\/([^/]+)$/);
    if (roleMatch && method === "PUT" && deps.saveRole) {
      requireInstanceOwnerAuthority(rc, "global agent role changes require the instance owner");
      const b = await rc.body();
      if (b.mode === "subagent" || b.mode === "all") {
        throw Object.assign(
          new Error("Native subagent role modes are disabled in Polyth; use agent.spawn for delegated work"),
          { code: "invalid-input" },
        );
      }
      const mode = b.mode === "auto" ? "auto" : "primary";
      const rawModel = b.model as { providerID?: unknown; modelID?: unknown } | undefined;
      const model = rawModel
        && typeof rawModel.providerID === "string"
        && typeof rawModel.modelID === "string"
        && rawModel.providerID
        && rawModel.modelID
        ? { providerID: rawModel.providerID, modelID: rawModel.modelID }
        : undefined;
      rc.json(200, await deps.saveRole(decodeURIComponent(roleMatch[1]!), {
        prompt: typeof b.prompt === "string" ? b.prompt.slice(0, 128 * 1024) : undefined,
        ...(model && mode !== "auto" ? { model } : {}),
        mode,
      }));
      return true;
    }

    // ---- MCP servers ------------------------------------------------------------
    // Space-owned servers (Spaces §14.6): Space admins write; other members
    // list them redacted. Supplying a stable project ID asks the service for
    // that project's effective set (Space + project override).
    const projectId = rc.url.searchParams.has("projectId") ? rc.url.searchParams.get("projectId")! : undefined;
    if (path === "/api/mcp/access" && method === "GET") {
      rc.json(200, deps.mcp.access(rc.space));
      return true;
    }
    // Person-owned servers: always the signed-in person's own, never by id
    // from another person; attached only to that person's private chats.
    if (path === "/api/mcp/personal/servers" && method === "GET") {
      rc.json(200, deps.mcp.listPersonal(rc.space));
      return true;
    }
    if (path === "/api/mcp/personal/servers" && method === "POST") {
      const b = await rc.body();
      if (typeof b.name !== "string" || (b.enabled !== undefined && typeof b.enabled !== "boolean")) throw Object.assign(new Error("Invalid MCP name or enabled state"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.createPersonal(rc.space, {
        name: b.name,
        transport: parseTransport(b.transport),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(b.enabled === false ? { enabled: false } : {}),
      }));
      return true;
    }
    let personal = path.match(/^\/api\/mcp\/personal\/servers\/([^/]+)$/);
    if (personal && method === "PATCH") {
      const b = await rc.body();
      if ((b.name !== undefined && typeof b.name !== "string") || (b.enabled !== undefined && typeof b.enabled !== "boolean")) throw Object.assign(new Error("Invalid MCP name or enabled state"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.updatePersonal(rc.space, personal[1]!, {
        ...(b.name !== undefined ? { name: String(b.name) } : {}),
        ...(b.transport !== undefined ? { transport: parseTransport(b.transport) } : {}),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      }, Number(b.expectedRevision ?? 0)));
      return true;
    }
    if (personal && method === "DELETE") {
      rc.json(200, { ok: await deps.mcp.removePersonal(rc.space, personal[1]!) });
      return true;
    }
    personal = path.match(/^\/api\/mcp\/personal\/servers\/([^/]+)\/tools$/);
    if (personal && method === "GET") {
      rc.json(200, deps.mcp.personalTools(rc.space, personal[1]!));
      return true;
    }
    personal = path.match(/^\/api\/mcp\/personal\/servers\/([^/]+)\/(?:test|probe)$/);
    if (personal && method === "POST") {
      rc.json(200, await deps.mcp.testPersonal(rc.space, personal[1]!));
      return true;
    }
    if (path === "/api/mcp/servers" && method === "GET") {
      rc.json(200, deps.mcp.list(rc.space, projectId));
      return true;
    }
    if (path === "/api/mcp/servers/import" && method === "POST") {
      const b = await rc.body();
      if (!Array.isArray(b.servers)) throw Object.assign(new Error("servers must be an array"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.importServers(rc.space, b.servers.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Invalid MCP import entry"), { code: "invalid-input" });
        const input = value as Record<string, unknown>;
        if (typeof input.name !== "string") throw Object.assign(new Error("name must be a string"), { code: "invalid-input" });
        if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw Object.assign(new Error("enabled must be a boolean"), { code: "invalid-input" });
        return { name: input.name, transport: parseTransport(input.transport), secrets: parseSecrets(input.secrets), ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}) };
      }), projectId));
      return true;
    }
    if (path === "/api/mcp/servers" && method === "POST") {
      const b = await rc.body();
      if (typeof b.name !== "string" || (b.enabled !== undefined && typeof b.enabled !== "boolean")) throw Object.assign(new Error("Invalid MCP name or enabled state"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.create(rc.space, {
        name: String(b.name ?? ""),
        transport: parseTransport(b.transport),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(b.enabled === false ? { enabled: false } : {}),
      }, projectId));
      return true;
    }
    let m = path.match(/^\/api\/mcp\/servers\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = await rc.body();
      if ((b.name !== undefined && typeof b.name !== "string") || (b.enabled !== undefined && typeof b.enabled !== "boolean")) throw Object.assign(new Error("Invalid MCP name or enabled state"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.update(rc.space, m[1]!, {
        ...(b.name !== undefined ? { name: String(b.name) } : {}),
        ...(b.transport !== undefined ? { transport: parseTransport(b.transport) } : {}),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      }, Number(b.expectedRevision ?? 0), projectId));
      return true;
    }
    if (m && method === "DELETE") {
      rc.json(200, { ok: await deps.mcp.remove(rc.space, m[1]!, projectId) });
      return true;
    }
    m = path.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
    if (m && method === "GET") {
      rc.json(200, deps.mcp.tools(rc.space, m[1]!, projectId));
      return true;
    }
    m = path.match(/^\/api\/mcp\/servers\/([^/]+)\/override$/);
    if (m && method === "POST") {
      if (!projectId) throw Object.assign(new Error("projectId is required for an override"), { code: "invalid-input" });
      const b = await rc.body();
      if (typeof b.enabled !== "boolean") throw Object.assign(new Error("enabled must be a boolean"), { code: "invalid-input" });
      rc.json(200, await deps.mcp.override(rc.space, m[1]!, projectId, b.enabled));
      return true;
    }
    // Both spellings run a real initialize + tools/list protocol check.
    m = path.match(/^\/api\/mcp\/servers\/([^/]+)\/(?:test|probe)$/);
    if (m && method === "POST") {
      rc.json(200, await deps.mcp.test(rc.space, m[1]!, projectId));
      return true;
    }
    m = path.match(/^\/api\/mcp\/servers\/([^/]+)\/authorize$/);
    if (m && method === "POST") {
      // Honest state: interactive MCP authorization needs the backend bridge,
      // which the current adapter does not expose. Not silently swallowed.
      rc.json(501, { error: "unsupported", message: "MCP authorization requires the backend bridge; configure credentials as secrets instead" });
      return true;
    }

    return false;
  };
}
