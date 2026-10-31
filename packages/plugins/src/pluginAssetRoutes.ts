import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import type { PluginRegistry } from "./managedRegistry.ts";
import { MAX_SCREENSHOT_BYTES } from "./managedRegistry.ts";
import { notFound } from "./pluginRouteShared.ts";

/** Raster formats only. SVG is deliberately absent: it can execute script and
 *  would turn a package gallery into same-origin code execution. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
};

function imageType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : IMAGE_TYPES[path.slice(dot).toLowerCase()] ?? null;
}

export function pluginAssetRoutes(opts: {
  plugins: Pick<PluginRegistry, "has" | "installDir">;
  /** Resolve one declared gallery frame for a package version. Returning null
   *  means the request does not name a published frame. */
  screenshot?: (id: string, version: string, index: number) => { src: string } | null;
}): RouteHandler {
  const diskOf = (id: string): string => {
    try {
      return opts.plugins.installDir(id);
    } catch {
      throw notFound();
    }
  };
  const screenshots = opts.screenshot;
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
    const shot = request.path.match(
      /^\/api\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/screenshots\/([^/]+)\/(\d{1,2})\/([^/]+)$/,
    );
    if (shot && request.method === "GET") {
      if (!screenshots) throw notFound();
      const id = shot[1]!;
      const version = decodeURIComponent(shot[2]!);
      const index = Number(shot[3]!);
      const name = decodeURIComponent(shot[4]!);
      if (!opts.plugins.has(id)) throw notFound();
      // The URL only ever names a frame the active manifest declares: the
      // index selects it, the trailing name must match that frame's basename,
      // and a version other than the one the URL carries must not resolve.
      const declared = screenshots(id, version, index);
      if (!declared || basename(declared.src) !== name) throw notFound();
      const type = imageType(declared.src);
      if (!type) throw notFound();
      const root = resolve(diskOf(id));
      const target = resolve(root, declared.src);
      if (target !== root && !target.startsWith(root + sep)) throw notFound();
      let contents: Buffer;
      try {
        const info = await stat(target);
        if (!info.isFile() || info.size === 0 || info.size > MAX_SCREENSHOT_BYTES) throw notFound();
        contents = await readFile(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
        throw error;
      }
      request.res.writeHead(200, {
        "content-type": type,
        "content-length": contents.length,
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      });
      request.res.end(contents);
      return true;
    }
    return false;
  };
}
