import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginRegistry } from "@polyth/plugins";
import type { RouteHandler } from "../http.ts";

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
