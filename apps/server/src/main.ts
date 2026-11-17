// The packaged Polyth server process (dist/server.mjs). It is what
// `node packages/server/src/index.ts` is in a checkout, with every server
// package compiled in and its resources beside it (layout.ts).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boot } from "@polyth/server";
import { serverDataDir } from "@polyth/cli/target";
import { bundleLayout } from "./layout.ts";
import { serverAppPackages } from "./serverPackages.ts";

const layout = bundleLayout(resolve(import.meta.dirname, ".."));
const build = JSON.parse(readFileSync(join(layout.root, "BUILD.json"), "utf8")) as { version: string };

// Read by the Link host lookup (packages/tunnel), the runtime supervisor
// (packages/harness-runtime) and packages with packaged assets.
process.env.POLYTH_RESOURCES_DIR ??= layout.resources;

await boot({
  version: build.version,
  dataDir: resolve(process.env.POLYTH_DATA_DIR?.trim() || serverDataDir()),
  webDist: layout.webDist,
  webPackagesDir: layout.webPackages,
  serverPackages: serverAppPackages,
});
