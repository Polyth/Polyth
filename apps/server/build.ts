// Builds the packaged Polyth server for this machine's platform:
//   apps/server/dist/polyth/                                  the install tree (src/layout.ts)
//   apps/server/release/polyth-server-<version>-<target>.tar.gz (+ .sha256)
// Needs the web build first (`npm run build:server` runs both). POLYTH_VERSION
// sets the version (release builds); POLYTH_LINK_BIN_DIR takes an already
// built polyth-link-host instead of running cargo.
import { build, type BuildOptions, type Metafile } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeThirdPartyNotices } from "../../scripts/third-party-notices.mjs";
import { serverPackagesPlugin } from "../../scripts/server-packages-bundle.ts";
import {
  bundleLayout,
  bundleTarget,
  LAUNCHER,
  releaseName,
  RUNTIME_EXTERNALS,
  stagePackageJson,
} from "./src/layout.ts";

const here = import.meta.dirname;
const repoRoot = join(here, "..", "..");
const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
};
const version = process.env.POLYTH_VERSION?.trim() || rootManifest.version;
const target = bundleTarget(process.platform, process.arch);
const exe = process.platform === "win32" ? ".exe" : "";
const distRoot = join(here, "dist");
const releaseDir = join(here, "release");
const layout = bundleLayout(join(distRoot, "polyth"));
const name = releaseName(version, target);

const webDist = join(repoRoot, "apps", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error(`the web build is missing at ${webDist}: run \`npm run build:server\`, which builds it first`);
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(layout.dist, { recursive: true });
await mkdir(layout.resources, { recursive: true });

// ---- native helpers -------------------------------------------------------

const supervisorBuilder = join(repoRoot, "packages", "harness-runtime", "build-supervisor.mjs");
const supervisorBin = join(repoRoot, "packages", "harness-runtime", "native", "bin");
if (process.platform === "linux") {
  const built = spawnSync(process.execPath, [supervisorBuilder, `--target=${target}`], { stdio: "inherit" });
  if (built.status !== 0) throw new Error(`failed to build the Polyth runtime supervisor for ${target}`);
  const into = join(layout.resources, "runtime-supervisor", target);
  await mkdir(into, { recursive: true });
  await copyFile(join(supervisorBin, target, "polyth-supervisor"), join(into, "polyth-supervisor"));
  await chmod(join(into, "polyth-supervisor"), 0o755);
} else if (process.platform === "win32") {
  spawnSync(process.execPath, [supervisorBuilder], { stdio: "inherit" });
  const helper = join(supervisorBin, "win32", "polyth-job.exe");
  if (existsSync(helper)) {
    await mkdir(join(layout.resources, "runtime-supervisor", "win32"), { recursive: true });
    await copyFile(helper, join(layout.resources, "runtime-supervisor", "win32", "polyth-job.exe"));
  } else {
    // Harnesses still run; after a server crash they stay fenced until reboot.
    console.warn("polyth-job.exe was not built: this bundle has no Windows harness job boundary");
  }
}

const linkHost = `polyth-link-host${exe}`;
let linkBinDir = process.env.POLYTH_LINK_BIN_DIR?.trim();
if (!linkBinDir) {
  const cargo = spawnSync("cargo", ["build", "--release", "-p", "polyth-link-host"], { cwd: repoRoot, stdio: "inherit" });
  if (cargo.status !== 0) throw new Error("failed to build polyth-link-host");
  linkBinDir = join(repoRoot, "target", "release");
}
if (!existsSync(join(linkBinDir, linkHost))) throw new Error(`polyth-link-host is missing at ${join(linkBinDir, linkHost)}`);
await mkdir(join(layout.resources, "polyth-link"), { recursive: true });
await copyFile(join(linkBinDir, linkHost), join(layout.resources, "polyth-link", linkHost));
await chmod(join(layout.resources, "polyth-link", linkHost), 0o755);

// ---- bundles --------------------------------------------------------------

const common: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "bundle",
  external: [...RUNTIME_EXTERNALS],
  // Bundled CommonJS dependencies such as ws still use dynamic built-in
  // requires, which an ES module has no `require` for.
  banner: {
    js: 'import { createRequire as __polythCreateRequire } from "node:module"; const require = __polythCreateRequire(import.meta.url);',
  },
  // Dependency notices ship in THIRD_PARTY_NOTICES.txt, written from the metafiles below.
  legalComments: "none",
  metafile: true,
  logLevel: "info",
};

const bundles = await Promise.all([
  build({
    ...common,
    entryPoints: [join(here, "src", "main.ts")],
    outfile: join(layout.dist, "server.mjs"),
    plugins: [serverPackagesPlugin({
      root: repoRoot,
      modulePath: join(here, "src", "serverPackages.ts"),
      exportName: "serverAppPackages",
    })],
  }),
  build({ ...common, entryPoints: [join(here, "src", "cli.ts")], outfile: join(layout.dist, "cli.mjs") }),
  // One-shot operator tools: no source maps (they would double the archive's share of them).
  build({ ...common, sourcemap: false, entryPoints: [join(repoRoot, "scripts", "setup-claim.ts")], outfile: join(layout.dist, "setup-claim.mjs") }),
  build({ ...common, sourcemap: false, entryPoints: [join(repoRoot, "scripts", "break-glass-password.ts")], outfile: join(layout.dist, "break-glass.mjs") }),
]);
await copyFile(join(repoRoot, "packages", "server", "src", "agentToolsMcp.mjs"), join(layout.dist, "agentToolsMcp.mjs"));
await writeThirdPartyNotices(
  join(layout.resources, "THIRD_PARTY_NOTICES.txt"),
  bundles.map((result) => result.metafile as Metafile),
  { product: "The Polyth server", workingDir: process.cwd() },
);

// ---- web resources --------------------------------------------------------

await cp(webDist, layout.webDist, { recursive: true });
// Each package's browser bundle and assets, as Desktop's extraResources does.
for (const id of (await readdir(join(repoRoot, "packages"))).sort()) {
  const packageDir = join(repoRoot, "packages", id);
  if (!existsSync(join(packageDir, "package.json"))) continue;
  for (const part of [join("dist", "web"), "assets"]) {
    if (existsSync(join(packageDir, part))) {
      await cp(join(packageDir, part), join(layout.webPackages, id, part), { recursive: true });
    }
  }
}

// ---- runtime dependencies -------------------------------------------------

interface RuntimePackage { name: string; dir: string; version: string }

/** Where Node would find `name` from `fromDir`: the nearest node_modules. */
function findPackage(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The externals and everything they need at run time, as installed here.
 *  Optional dependencies are taken only when installed (esbuild's binary for
 *  this platform). */
async function runtimeClosure(): Promise<RuntimePackage[]> {
  const found = new Map<string, RuntimePackage>();
  const queue: Array<{ name: string; from: string; optional: boolean }> =
    RUNTIME_EXTERNALS.map((external) => ({ name: external, from: repoRoot, optional: false }));
  while (queue.length > 0) {
    const next = queue.shift()!;
    const located = findPackage(next.name, next.from);
    if (!located) {
      if (next.optional) continue;
      throw new Error(`runtime dependency ${next.name} is not installed (run npm ci)`);
    }
    const dir = await realpath(located);
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const seen = found.get(next.name);
    if (seen) {
      if (seen.dir !== dir) throw new Error(`two installed copies of ${next.name} are needed (${seen.version}, ${manifest.version})`);
      continue;
    }
    found.set(next.name, { name: next.name, dir, version: manifest.version });
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const runtime = await runtimeClosure();

// What ships is what the lockfile pins: a checkout whose node_modules drifted
// from it would otherwise put an untested version into a release.
const locked = (JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
}).packages;
const drift = runtime
  .map((pkg) => ({ pkg, pinned: locked[`node_modules/${pkg.name}`]?.version }))
  .filter(({ pkg, pinned }) => pinned !== undefined && pinned !== pkg.version)
  .map(({ pkg, pinned }) => `${pkg.name} ${pkg.version} (lockfile ${pinned})`);
if (drift.length > 0) {
  const message = `installed runtime dependencies differ from package-lock.json: ${drift.join(", ")}; run npm ci`;
  if (process.env.CI) throw new Error(message);
  console.warn(`WARNING: ${message}. This local bundle is not a release candidate.`);
}

const ptyNative = runtime.find((pkg) => pkg.name === "node-pty");
if (process.platform === "linux" && ptyNative && !existsSync(join(ptyNative.dir, "build", "Release", "pty.node"))) {
  throw new Error("node-pty has no native build for this machine (run `npm rebuild node-pty`)");
}

/** node-pty ships its C++ sources, Windows ConPTY binaries and every
 *  platform's prebuilds; at run time it loads lib/ and one native addon
 *  (build/Release, or prebuilds/<platform>-<arch>), plus ConPTY on Windows. */
function nodePtyKeeps(relative: string): boolean {
  const parts = relative.split(/[/\\]/);
  if (parts[0] === "") return true;
  if (parts.length === 1) return ["package.json", "LICENSE", "lib", "build", "prebuilds", "third_party"].includes(parts[0]!);
  if (parts[0] === "lib") return true;
  if (parts[0] === "build") return parts[1] === "Release" && (parts.length === 2 || /^(pty\.node|spawn-helper|conpty\.node|conpty_console_list\.node)$/.test(parts[2]!));
  if (parts[0] === "prebuilds") return parts[1] === target;
  if (parts[0] === "third_party") return process.platform === "win32";
  return false;
}

for (const pkg of runtime) {
  await cp(pkg.dir, join(layout.root, "node_modules", pkg.name), {
    recursive: true,
    dereference: true,
    filter: (source) => pkg.name === "node-pty"
      ? nodePtyKeeps(source.slice(pkg.dir.length + 1))
      // The browsers Playwright may have downloaded.
      : !/[/\\]\.local-browsers([/\\]|$)/.test(source),
  });
}

// ---- package root ---------------------------------------------------------

const byName = new Map(runtime.map((pkg) => [pkg.name, pkg.version]));
await writeFile(join(layout.root, "package.json"), `${JSON.stringify(stagePackageJson({
  version,
  dependencies: Object.fromEntries(RUNTIME_EXTERNALS.map((external) => [external, byName.get(external)!])),
  nodeEngine: rootManifest.engines.node,
}), null, 2)}\n`);
const commit = process.env.GITHUB_SHA?.trim()
  || spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
await writeFile(join(layout.root, "BUILD.json"), `${JSON.stringify({ version, commit, target }, null, 2)}\n`);
await mkdir(join(layout.root, "bin"), { recursive: true });
await writeFile(join(layout.root, "bin", "polyth.mjs"), LAUNCHER);
await chmod(join(layout.root, "bin", "polyth.mjs"), 0o755);
await copyFile(join(repoRoot, "LICENSE"), join(layout.root, "LICENSE"));

// ---- archive --------------------------------------------------------------

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const archive = join(releaseDir, `${name}.tar.gz`);
// Entries carry no build machine account names.
const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU tar");
const ownership = gnuTar ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--numeric-owner"];
const packed = spawnSync("tar", [...ownership, "-czf", archive, "-C", distRoot, "polyth"], { stdio: "inherit" });
if (packed.status !== 0) throw new Error(`failed to write ${archive}`);
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
console.log(`Polyth server ${version} (${target}): ${archive}`);
