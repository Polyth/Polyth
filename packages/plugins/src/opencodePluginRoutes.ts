import type {
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginImportResponseDto,
  OpenCodePluginListResponseDto,
  OpenCodePluginRemoveResponseDto,
  RouteHandler,
} from "@polyth/contracts";
import type { PluginConfigService } from "./pluginRouteShared.ts";

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
