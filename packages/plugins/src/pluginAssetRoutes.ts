import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import type { PluginRegistry } from "./managedRegistry.ts";
import { notFound } from "./pluginRouteShared.ts";

export function pluginAssetRoutes(opts: {
  plugins: Pick<PluginRegistry, "has" | "installDir">;
}): RouteHandler {
  const diskOf = (id: string): string => {
    try {
      return opts.plugins.installDir(id);
    } catch {
      throw notFound();
    }
  };
  return async (request) => {
    const ui = request.path.match(
      /^\/api\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/ui\/([a-f0-9]{64})\.mjs$/,
    );
    if (ui && request.method === "GET") {
      const id = ui[1]!;
      const integrity = ui[2]!;
      if (!opts.plugins.has(id)) throw notFound();
      let contents: Buffer;
      try {
        contents = await readFile(join(diskOf(id), ".polyth", "ui", `ui-${integrity}.mjs`));
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
    }
    const sandbox = request.path.match(
      /^\/api\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/sandbox\/([a-f0-9]{64})\/entry\.js$/,
    );
    if (sandbox && request.method === "GET") {
      const id = sandbox[1]!;
      const integrity = sandbox[2]!;
      if (!opts.plugins.has(id)) throw notFound();
      let contents: Buffer;
      try {
        contents = await readFile(join(diskOf(id), ".polyth", "sandbox", `sandbox-${integrity}.js`));
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
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      });
      request.res.end(contents);
      return true;
    }
    return false;
  };
}
