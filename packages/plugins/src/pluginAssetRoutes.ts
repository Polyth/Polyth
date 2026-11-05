import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, gzip } from "node:zlib";
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

const gzipAsync = promisify(gzip);

const sha256 = (contents: Buffer): string => createHash("sha256").update(contents).digest("hex");

/** True when Accept-Encoding admits gzip (or `*`) with a non-zero weight. */
function acceptsGzip(header: string | string[] | undefined): boolean {
  let gzipWeight: number | undefined;
  let anyWeight: number | undefined;
  for (const part of (Array.isArray(header) ? header.join(",") : header ?? "").split(",")) {
    const [token = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (token === "gzip" || token === "x-gzip") gzipWeight = weight;
    else if (token === "*") anyWeight = weight;
  }
  const weight = gzipWeight ?? anyWeight ?? 0;
  return Number.isFinite(weight) && weight > 0;
}

/** Verified UI bundles kept per route instance, at most this many. */
const UI_BUNDLE_CACHE_LIMIT = 32;

interface VerifiedBundle {
  /** Identity of the file the bytes were hashed from; any change re-verifies. */
  signature: string;
  body: Buffer;
  /** False when gzip did not make the bundle smaller and `body` is plain. */
  gzip: boolean;
}

/** `utimes` cannot rewind ctime, so an in-place rewrite always changes this. */
const fileSignature = (info: Stats): string =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

const readBundle = async (file: string): Promise<Buffer> => {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
    throw error;
  }
};

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
  // A UI bundle is immutable and named by its sha256, so bytes that hashed to
  // that name once stay valid for it. They are kept gzip-compressed here and
  // served without re-reading or re-hashing while the file's stat identity is
  // unchanged; only the integrity-checked bytes ever leave this map. Install
  // trees are not touched, so tree integrity of every install is unchanged.
  const uiBundles = new Map<string, VerifiedBundle>();
  const uiBundle = async (
    file: string,
    integrity: string,
    wantsGzip: boolean,
  ): Promise<{ body: Buffer; gzip: boolean }> => {
    let info: Stats;
    try {
      info = await stat(file);
    } catch (error) {
      uiBundles.delete(file);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
      throw error;
    }
    const signature = fileSignature(info);
    const cached = uiBundles.get(file);
    if (cached?.signature === signature && (wantsGzip || !cached.gzip)) {
      uiBundles.delete(file);
      uiBundles.set(file, cached);
      return cached;
    }
    const contents = await readBundle(file);
    if (sha256(contents) !== integrity) {
      uiBundles.delete(file);
      throw notFound();
    }
    // A client without gzip gets the plain bytes it just verified; the
    // compressed copy for everyone else is already current.
    if (cached?.signature === signature) return { body: contents, gzip: false };
    const compressed = await gzipAsync(contents, { level: zlibConstants.Z_BEST_COMPRESSION });
    const entry: VerifiedBundle = compressed.length < contents.length
      ? { signature, body: compressed, gzip: true }
      : { signature, body: contents, gzip: false };
    uiBundles.delete(file);
    uiBundles.set(file, entry);
    while (uiBundles.size > UI_BUNDLE_CACHE_LIMIT) {
      uiBundles.delete(uiBundles.keys().next().value!);
    }
    return wantsGzip || !entry.gzip ? entry : { body: contents, gzip: false };
  };
  return async (request) => {
    const ui = request.path.match(
      /^\/api\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/ui\/([a-f0-9]{64})\.mjs$/,
    );
    if (ui && request.method === "GET") {
      const id = ui[1]!;
      const integrity = ui[2]!;
      if (!opts.plugins.has(id)) throw notFound();
      const bundle = await uiBundle(
        join(diskOf(id), ".polyth", "ui", `ui-${integrity}.mjs`),
        integrity,
        acceptsGzip(request.req.headers["accept-encoding"]),
      );
      request.res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": bundle.body.length,
        "cache-control": "public, max-age=31536000, immutable",
        // Both representations name the header they depend on, so a shared
        // cache never hands the gzip body to a client that did not ask for it.
        vary: "accept-encoding",
        ...(bundle.gzip ? { "content-encoding": "gzip" } : {}),
      });
      request.res.end(bundle.body);
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
      if (sha256(contents) !== integrity) throw notFound();
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
