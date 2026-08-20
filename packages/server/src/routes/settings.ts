// WP9 routes: global behavior instructions, system info, MCP configuration,
// and the managed plugin registry. Secret values never leave this boundary —
// requests may carry them in, responses only ever name their keys.
import type { McpTransport, SystemInfoDto } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { BehaviorService } from "../behavior.ts";
import type { McpConfigService } from "../mcp.ts";
import type { PluginRegistry } from "@polyth/plugins";

export interface SettingsRouteDeps {
  behavior: BehaviorService;
  mcp: McpConfigService;
  plugins: PluginRegistry;
  systemInfo(local: boolean): SystemInfoDto;
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

const isLocal = (addr: string | undefined): boolean =>
  !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

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

    // ---- system info ------------------------------------------------------------
    if (path === "/api/system/info" && method === "GET") {
      rc.json(200, deps.systemInfo(isLocal(rc.req.socket.remoteAddress)));
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

    // ---- managed plugins ----------------------------------------------------------
    if (path === "/api/plugins" && method === "GET") {
      rc.json(200, deps.plugins.list());
      return true;
    }
    if (path === "/api/plugins/install" && method === "POST") {
      const b = await rc.body();
      rc.json(200, await deps.plugins.install(String(b.source ?? "")));
      return true;
    }
    m = path.match(/^\/api\/plugins\/([^/]+)\/(reload|enable|disable|update)$/);
    if (m && method === "POST") {
      const id = m[1]!;
      const op = m[2]!;
      if (op === "enable") rc.json(200, await deps.plugins.enable(id));
      else if (op === "disable") rc.json(200, await deps.plugins.disable(id));
      else if (op === "reload") rc.json(200, await deps.plugins.reload(id));
      else rc.json(501, { error: "unsupported", message: "in-place update is not implemented; remove and reinstall the newer version" });
      return true;
    }
    m = path.match(/^\/api\/plugins\/([^/]+)\/logs$/);
    if (m && method === "GET") {
      rc.json(200, deps.plugins.logs(m[1]!, {
        after: Number(rc.url.searchParams.get("after") ?? 0),
        limit: Number(rc.url.searchParams.get("limit") ?? 200),
      }));
      return true;
    }
    m = path.match(/^\/api\/plugins\/([^/]+)$/);
    if (m && method === "DELETE") {
      rc.json(200, { ok: await deps.plugins.remove(m[1]!) });
      return true;
    }

    return false;
  };
}
