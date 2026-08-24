import type {
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginImportResponseDto,
  OpenCodePluginListResponseDto,
  OpenCodePluginRemoveResponseDto,
} from "@polyth/contracts";
import type { BackendConfigApplier } from "@polyth/backend-opencode";
import type { RouteHandler } from "../http.ts";

const dto = (entry: OpenCodePluginConfigEntry): OpenCodePluginEntryDto =>
  typeof entry === "string"
    ? { spec: entry }
    : { spec: entry[0], options: entry[1] };

const listResponse = (plugins: OpenCodePluginConfigEntry[]): OpenCodePluginListResponseDto => ({
  plugins: plugins.map(dto),
});

/** Dedicated OpenCode-config plugin routes. These never touch the managed
 * Polyth plugin registry (`/api/plugins/install`). */
export function opencodePluginRoutes(config: Pick<
  BackendConfigApplier,
  "listPlugins" | "applyPlugins" | "removePlugin"
>): RouteHandler {
  return async ({ path, method, body, json }) => {
    if (path === "/api/plugins/opencode" && method === "GET") {
      json(200, listResponse(await config.listPlugins()));
      return true;
    }

    if (path === "/api/plugins/opencode/import" && method === "POST") {
      const request = await body();
      // Accept the normalized Polyth request as well as an OpenCode config
      // object copied directly from opencode.json.
      const field = Object.prototype.hasOwnProperty.call(request, "plugins") ? "plugins" : "plugin";
      const raw = request[field];
      if (!Array.isArray(raw)) {
        throw Object.assign(new Error(`${field} must be an array`), {
          code: "invalid-input",
          field,
        });
      }
      const plugins = await config.applyPlugins(raw);
      // applyPlugins has validated every entry before writing, so this mapping
      // is safe and reports the unique specs represented by the paste.
      const imported = [...new Set(raw.map((entry) =>
        typeof entry === "string"
          ? entry.trim()
          : String((entry as unknown[])[0]).trim()))];
      const response: OpenCodePluginImportResponseDto = {
        ...listResponse(plugins),
        imported,
        restartRequired: true,
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
        restartRequired: result.removed,
      };
      json(200, response);
      return true;
    }

    return false;
  };
}
