// The packaged Polyth server process (dist/server.mjs). It is what
// `node packages/server/src/index.ts` is in a checkout, with every server
// package compiled in and its resources beside it (layout.ts).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { boot } from "@polyth/server";
import { serverDataDir } from "@polyth/cli/target";
import { installKind } from "@polyth/cli/update";
import { bundleLayout, bundleTarget, platformPackageName } from "./layout.ts";
import { serverAppPackages } from "./serverPackages.ts";

const layout = bundleLayout(resolve(import.meta.dirname, ".."));
const build = JSON.parse(readFileSync(join(layout.root, "BUILD.json"), "utf8")) as { version: string };

/** `resources/` beside the server (release archive), else the one in this
 *  platform's `@polyth/server-<target>` package (npm). */
function resourcesRoot(): string {
  if (existsSync(join(layout.resources, "web", "index.html"))) return layout.resources;
  let target: string;
  try {
    target = bundleTarget(process.platform, process.arch);
  } catch {
    throw new Error(`Polyth has no server build for ${process.platform}-${process.arch}`);
  }
  const name = platformPackageName(target);
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve(`${name}/package.json`);
  } catch {
    throw new Error(`${name} is not installed: reinstall polyth with optional dependencies enabled (npm install --global polyth)`);
  }
  const installed = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
  if (installed !== build.version) {
    throw new Error(`${name} ${installed ?? "?"} does not match polyth ${build.version}: reinstall polyth`);
  }
  return join(dirname(manifest), "resources");
}

const resources = resourcesRoot();

// Read by the Link host lookup (packages/tunnel), the runtime supervisor
// (packages/harness-runtime) and packages with packaged assets.
process.env.POLYTH_RESOURCES_DIR ??= resources;

// Shown with a newer release in Settings → About.
const kind = installKind({ bundle: layout.root, docker: existsSync("/.dockerenv") });
const updateCommand = kind.kind === "homebrew"
  ? "brew upgrade polyth && brew services restart polyth"
  : kind.kind === "docker" ? undefined : "polyth update";

await boot({
  version: build.version,
  ...(updateCommand ? { updateCommand } : {}),
  dataDir: resolve(process.env.POLYTH_DATA_DIR?.trim() || serverDataDir()),
  webDist: join(resources, "web"),
  webPackagesDir: join(resources, "packages"),
  serverPackages: serverAppPackages,
});
