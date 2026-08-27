import type { BuildOptions, Plugin } from "esbuild";
import { readFile } from "node:fs/promises";
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
  external: reactExternals,
  sourcemap: true,
  minify: true,
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
} satisfies BuildOptions;

export const shellModuleName = (repositoryRelativePath: string): string =>
  `shell-api/${repositoryRelativePath.replaceAll(".", "__")}`;

export const shellModuleUrl = (repositoryRelativePath: string): string =>
  `/${shellModuleName(repositoryRelativePath)}.js`;
