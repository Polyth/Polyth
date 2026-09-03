import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginImportResponseDto,
  OpenCodePluginListResponseDto,
  OpenCodePluginRemoveResponseDto,
  RouteHandler,
} from "@polyth/contracts";
import {
  createPluginRegistry,
  localOnlyRemoteAccess,
  serverServiceKey,
  type PluginRegistry,
  type ServerPackage,
  type ServerPackageHost,
} from "./index.ts";

interface PluginConfigService {
  listPlugins(): Promise<OpenCodePluginConfigEntry[]>;
  applyPlugins(plugins: unknown[]): Promise<OpenCodePluginConfigEntry[]>;
  removePlugin(spec: string): Promise<{
    plugins: OpenCodePluginConfigEntry[];
    removed: boolean;
  }>;
}

const pluginDto = (entry: OpenCodePluginConfigEntry): OpenCodePluginEntryDto =>
  typeof entry === "string"
    ? { spec: entry }
    : { spec: entry[0], options: entry[1] };

const listResponse = (
  plugins: OpenCodePluginConfigEntry[],
): OpenCodePluginListResponseDto => ({ plugins: plugins.map(pluginDto) });

export function opencodePluginRoutes(config: PluginConfigService): RouteHandler {
  return async ({ path, method, body, json }) => {
    if (path === "/api/plugins/opencode" && method === "GET") {
      json(200, listResponse(await config.listPlugins()));
      return true;
    }
    if (path === "/api/plugins/opencode/import" && method === "POST") {
      const request = await body();
      const field = Object.prototype.hasOwnProperty.call(request, "plugins")
        ? "plugins"
        : "plugin";
      const raw = request[field];
      if (!Array.isArray(raw)) {
        throw Object.assign(new Error(`${field} must be an array`), {
          code: "invalid-input",
          field,
        });
      }
      const plugins = await config.applyPlugins(raw);
      const imported = [...new Set(raw.map((entry) =>
        typeof entry === "string"
          ? entry.trim()
          : String((entry as unknown[])[0]).trim()))];
      const response: OpenCodePluginImportResponseDto = {
        ...listResponse(plugins),
        imported,
        pendingRestart: true,
      };
      json(200, response);
      return true;
    }
    const remove = path.match(/^\/api\/plugins\/opencode\/(.+)$/);
    if (remove && method === "DELETE") {
      const result = await config.removePlugin(decodeURIComponent(remove[1]!));
      const response: OpenCodePluginRemoveResponseDto = {
        ...listResponse(result.plugins),
        removed: result.removed,
        pendingRestart: result.removed,
      };
      json(200, response);
      return true;
    }
    return false;
  };
}

export function managedPluginRoutes(registry: PluginRegistry): RouteHandler {
  return async (request) => {
    const { path, method } = request;
    if (path === "/api/plugins" && method === "GET") {
      request.json(200, registry.list());
      return true;
    }
    if (path === "/api/plugins/install" && method === "POST") {
      const input = await request.body();
      request.json(200, await registry.install(String(input.source ?? "")));
      return true;
    }
    let match = path.match(/^\/api\/plugins\/([^/]+)\/(reload|enable|disable|update)$/);
    if (match && method === "POST") {
      const id = match[1]!;
      const operation = match[2]!;
      if (operation === "enable") request.json(200, await registry.enable(id));
      else if (operation === "disable") request.json(200, await registry.disable(id));
      else if (operation === "reload") request.json(200, await registry.reload(id));
      else {
        request.json(501, {
          error: "unsupported",
          message: "in-place update is not implemented; remove and reinstall the newer version",
        });
      }
      return true;
    }
    match = path.match(/^\/api\/plugins\/([^/]+)\/logs$/);
    if (match && method === "GET") {
      request.json(200, registry.logs(match[1]!, {
        after: Number(request.url.searchParams.get("after") ?? 0),
        limit: Number(request.url.searchParams.get("limit") ?? 200),
      }));
      return true;
    }
    match = path.match(/^\/api\/plugins\/([^/]+)$/);
    if (match && method === "DELETE") {
      request.json(200, { ok: await registry.remove(match[1]!) });
      return true;
    }
    return false;
  };
}

const notFound = () => Object.assign(new Error("plugin UI bundle not found"), {
  code: "not-found",
});

export function pluginAssetRoutes(opts: {
  plugins: Pick<PluginRegistry, "list">;
  pluginsDir: string;
}): RouteHandler {
  return async (request) => {
    const match = request.path.match(
      /^\/api\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/ui\/([a-f0-9]{64})\.mjs$/,
    );
    if (!match || request.method !== "GET") return false;
    const id = match[1]!;
    const integrity = match[2]!;
    const plugin = opts.plugins.list().find((candidate) => candidate.id === id);
    if (!plugin || !plugin.enabled || plugin.ui?.integrity !== integrity) {
      throw notFound();
    }
    let contents: Buffer;
    try {
      contents = await readFile(
        join(opts.pluginsDir, plugin.id, ".polyth", "ui", `ui-${integrity}.mjs`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
      throw error;
    }
    if (createHash("sha256").update(contents).digest("hex") !== integrity) {
      throw notFound();
    }
    request.res.writeHead(200, {
      "content-type": "application/javascript",
      "cache-control": "public, max-age=31536000, immutable",
    });
    request.res.end(contents);
    return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let registry: PluginRegistry | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["plugins"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const pluginsDir = join(host.storageDir, "plugins");
      registry = createPluginRegistry({
        dir: pluginsDir,
        trustedDir: process.env.POLYTH_TRUSTED_PLUGIN_DIR
          ?? join(host.storageDir, "trusted-plugins"),
        routes: host.routes,
        root: host.root,
        onChange: (plugin) => host.broadcast.pluginChanged?.(plugin),
      });
      const handlers = [
        pluginAssetRoutes({ plugins: registry, pluginsDir }),
        opencodePluginRoutes(host.services.require(
          serverServiceKey<PluginConfigService>("plugins.config"),
        )),
        managedPluginRoutes(registry),
      ];
      routes = async (request) => {
        for (const handler of handlers) {
          if (await handler(request)) return true;
        }
        return false;
      };
    },
    async onDisable() {
      await registry?.dispose();
      registry = null;
      routes = null;
    },
  };
}
