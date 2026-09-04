// WP9 routes: global behavior instructions, system info, MCP configuration,
// and the managed plugin registry. Secret values never leave this boundary —
// requests may carry them in, responses only ever name their keys.
import type { AgentDescriptor, ClientSettingsDto, McpTransport, ModelRef, SystemInfoDto } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { BehaviorService } from "../behavior.ts";
import type { ClientSettingsService } from "../clientSettings.ts";
import type { McpConfigService } from "../mcp.ts";

export interface SettingsRouteDeps {
  behavior: BehaviorService;
  mcp: McpConfigService;
  systemInfo(local: boolean): SystemInfoDto;
  saveRole?(name: string, role: { prompt?: string; model?: ModelRef; mode: AgentDescriptor["mode"] }): Promise<AgentDescriptor>;
  /** Server-persisted client preferences shared across every device. */
  clientSettings?: ClientSettingsService;
  /** Fan a just-accepted client-settings write out to the other devices. */
  broadcastClientSettings?(state: ClientSettingsDto): void;
}

const parseTransport = (raw: unknown): McpTransport => {
  const t = raw as Record<string, unknown>;
  if (t?.kind === "stdio") {
    return {
      kind: "stdio",
      command: String(t.command ?? ""),
      args: Array.isArray(t.args) ? t.args.map(String) : [],
      envKeys: Array.isArray(t.envKeys) ? t.envKeys.map(String) : [],
    };
  }
  return {
    kind: "http",
    url: String(t?.url ?? ""),
    headersSecretRefs: Array.isArray(t?.headersSecretRefs) ? (t.headersSecretRefs as unknown[]).map(String) : [],
  };
};

const parseSecrets = (raw: unknown): Record<string, string> | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
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
      const b = await rc.body();
      rc.json(200, await deps.behavior.put(String(b.text ?? ""), String(b.expectedRevision ?? "")));
      return true;
    }
    if (path === "/api/settings/behavior/subagents" && method === "GET") {
      rc.json(200, await deps.behavior.subagentPolicy());
      return true;
    }
    if (path === "/api/settings/behavior/subagents" && method === "PUT") {
      const b = await rc.body();
      if (typeof b.enabled !== "boolean") {
        throw Object.assign(new Error("enabled must be a boolean"), { code: "invalid-input" });
      }
      rc.json(200, await deps.behavior.putSubagentPolicy(b.enabled));
      return true;
    }

    // ---- shared client preferences -----------------------------------------
    if (path === "/api/settings/client" && deps.clientSettings) {
      if (method === "GET") {
        rc.json(200, deps.clientSettings.get());
        return true;
      }
      if (method === "PUT") {
        const b = await rc.body();
        const next = deps.clientSettings.put((b as { settings?: unknown }).settings);
        deps.broadcastClientSettings?.(next);
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
      const b = await rc.body();
      const mode = b.mode === "subagent" || b.mode === "all" ? b.mode : "primary";
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
        ...(model ? { model } : {}),
        mode,
      }));
      return true;
    }

    // ---- MCP servers ------------------------------------------------------------
    if (path === "/api/mcp/servers" && method === "GET") {
      rc.json(200, deps.mcp.list());
      return true;
    }
    if (path === "/api/mcp/servers" && method === "POST") {
      const b = await rc.body();
      rc.json(200, await deps.mcp.create({
        name: String(b.name ?? ""),
        transport: parseTransport(b.transport),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(b.enabled === false ? { enabled: false } : {}),
      }));
      return true;
    }
    let m = path.match(/^\/api\/mcp\/servers\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = await rc.body();
      rc.json(200, await deps.mcp.update(m[1]!, {
        ...(b.name !== undefined ? { name: String(b.name) } : {}),
        ...(b.transport !== undefined ? { transport: parseTransport(b.transport) } : {}),
        ...(parseSecrets(b.secrets) ? { secrets: parseSecrets(b.secrets)! } : {}),
        ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      }, Number(b.expectedRevision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      rc.json(200, { ok: await deps.mcp.remove(m[1]!) });
      return true;
    }
    // F10 names this "probe"; "test" remains as the original spelling. Both hit
    // the same reachability check, which stores status/lastError on the entry.
    m = path.match(/^\/api\/mcp\/servers\/([^/]+)\/(?:test|probe)$/);
    if (m && method === "POST") {
      rc.json(200, await deps.mcp.test(m[1]!));
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
