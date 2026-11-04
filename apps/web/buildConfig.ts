import type { BuildOptions, Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { scaleUiFontSizes } from "./fontScaleCss.ts";

export const reactExternals = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

export const uiFontScalePlugin: Plugin = {
  name: "ui-font-scale",
  setup(buildApi) {
    buildApi.onLoad({ filter: /styles\.css$/ }, async (args) => ({
      contents: scaleUiFontSizes(await readFile(args.path, "utf8")),
      loader: "css",
    }));
  },
};

export const browserBuildOptions = {
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  jsx: "automatic",
  external: [...reactExternals, "/assets/*"],
  sourcemap: true,
  minify: true,
  // Escaped \uXXXX sequences bloat non-ASCII strings 6x; every response is
  // served as UTF-8 anyway.
  charset: "utf8",
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
} satisfies BuildOptions;

/** The uppercase hex form HASHED_ASSET (httpCore.ts) recognizes as content-addressed. */
const contentHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 16).toUpperCase();

/** `inter-normal.woff2` + its bytes -> `inter-normal-<HASH>.woff2`. */
export const contentAddressedName = (name: string, bytes: Uint8Array): string => {
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)}-${contentHash(bytes)}${extension}`;
};

export const FONT_ASSET_PREFIX = "/assets/fonts/";

/**
 * Fonts are addressed by their bytes, not by the build id: a redeploy that
 * leaves a font unchanged keeps the exact URL the browser already cached, so a
 * warm launch makes no font request at all. The plain names are copied too —
 * a page loaded before the rebuild (or the native shell's own markup) still
 * references them and must keep resolving.
 */
export const emitFontAssets = async (options: {
  sourceDir: string;
  targetDir: string;
  css: string;
}): Promise<string> => {
  const { sourceDir, targetDir } = options;
  await cp(sourceDir, targetDir, { recursive: true });
  let css = options.css;
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".woff2") continue;
    const source = join(sourceDir, entry.name);
    const hashed = contentAddressedName(entry.name, await readFile(source));
    await copyFile(source, join(targetDir, hashed));
    css = css.replaceAll(`${FONT_ASSET_PREFIX}${entry.name}`, `${FONT_ASSET_PREFIX}${hashed}`);
  }
  return css;
};

/** Copy one file under a content-addressed name and return that name. */
export const emitContentAddressedCopy = async (sourceFile: string, targetDir: string): Promise<string> => {
  const name = contentAddressedName(basename(sourceFile), await readFile(sourceFile));
  await mkdir(targetDir, { recursive: true });
  await copyFile(sourceFile, join(targetDir, name));
  return name;
};

export const shellModuleName = (repositoryRelativePath: string): string =>
  `shell-api/${repositoryRelativePath.replaceAll(".", "__")}`;

export const shellModuleUrl = (repositoryRelativePath: string): string =>
  `/${shellModuleName(repositoryRelativePath)}.js`;

// A proxy can retain a failed response for an otherwise immutable chunk URL.
// Keep content hashes for immutable caching, but give each published build a
// distinct directory so the next generation cannot inherit that failed key.
export const chunkNamesForBuild = (buildId: string): string =>
  `chunks/g-${createHash("sha256").update(buildId).digest("hex").slice(0, 12)}/[name]-[hash]`;

/**
 * /main.js, /main.css and the importmap-ed /shared/react*.js are the only
 * shell URLs esbuild emits without a content hash. The server answers them
 * `no-store`, but index.html is the only document a caching reverse proxy or
 * an installed PWA is guaranteed to revalidate: a proxy that rewrites asset
 * `expires` pins the previous stylesheet and bundle for hours, so a rebuilt
 * shell boots with the old CSS. Version the unhashed entries per build and
 * leave content-hashed chunk URLs alone; their build namespace is assigned
 * when the bundles are emitted.
 *
 * `moduleUrls` are the other unhashed modules: /shell-api/* and package
 * entries. Package code imports them by absolute URL, so the import map remaps
 * them. A browser that kept the previous build's /shell-api/.../store__ts.js
 * links packages to that build's store chunk: a second, empty store beside the
 * shell's (packages then see no projects).
 */
export const versionUnhashedShellUrls = (
  html: string,
  buildId: string,
  moduleUrls: readonly string[] = [],
): string =>
  html.replace(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (match, open: string, body: string, close: string) => {
    if (moduleUrls.length === 0) return match;
    const map = JSON.parse(body) as { imports?: Record<string, string> };
    const imports = { ...map.imports };
    for (const url of moduleUrls) imports[url] = `${url}?b=${buildId}`;
    return `${open}${JSON.stringify({ ...map, imports })}${close}`;
  }).replace(
    /"(\/(?:main|shared\/)[^"]*\.(?:js|css))"/g,
    (_match, url: string) => `"${/-[A-Z0-9]{8}\.(?:js|css)$/.test(url) ? url : `${url}?b=${buildId}`}"`,
  );
