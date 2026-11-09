// The workstation desktop edition: a local-only shell for coding harnesses on a
// managed work computer. It is the same app (appId com.polyth.desktop, product
// name Polyth) built for stable releases only, for every desktop target, and
// published as extra assets on the same GitHub release. It never appears on
// the website or in the server's downloads list, and it updates from its own
// stable-only feed (workstation.yml, workstation-mac.yml, workstation-linux.yml).
//
// remote-build.mjs (targets *-workstation) packages it with the helpers below
// and refuses a package that carries anything the edition must not ship;
// update-feed.mjs publishes its feed. Rules: docs/security/workstation-edition.md,
// build: docs/dev/desktop.md, "Workstation edition build".
//
// Plain node and plain fs on purpose: CI runs this on a bare runner, with no
// TypeScript loader and no workspace install beyond the desktop build itself.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

/** The `POLYTH_DESKTOP_FLAVOR` build define the desktop main process keys on. */
export const WORKSTATION_FLAVOR = "workstation";
/** electron-updater reads `<channel>.yml`, `<channel>-mac.yml`, `<channel>-linux.yml`. */
export const WORKSTATION_CHANNEL = "workstation";
/** Update metadata names of the edition, as published on the stable release. */
export const WORKSTATION_METADATA = {
  windows: "workstation.yml",
  mac: "workstation-mac.yml",
  linux: "workstation-linux.yml",
};
/** Every workstation installer carries this infix, which the download lists key on. */
// The edition goes AFTER os-arch (`Polyth-1.2.300-win-x64-workstation.exe`), so no
// download filter written for the standard names (`-win-x64.exe$`: polyth.app,
// the server's releases route of any version) can ever pick a workstation asset.
export const WORKSTATION_ASSET_INFIX = "-workstation.";
export const WORKSTATION_SUMS_NAME = "SHA256SUMS-workstation.txt";

export const workstationMacPartialName = (arch) => `workstation-mac.${arch}.partial.yml`;
export const workstationSbomName = (version, os, arch) => `Polyth-${version}-workstation-sbom-${os}-${arch}.cdx.json`;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function packageDirs(repoRoot) {
  const root = join(repoRoot, "packages");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "package.json")))
    .map((entry) => ({ id: entry.name, manifest: readJson(join(root, entry.name, "package.json")) }));
}

/** Directory names of the packages whose manifest lists the workstation edition. */
export function workstationPackageIds(repoRoot) {
  return packageDirs(repoRoot)
    .filter(({ manifest }) => Array.isArray(manifest.polyth?.editions) && manifest.polyth.editions.includes(WORKSTATION_FLAVOR))
    .map(({ id }) => id)
    .sort();
}

/** Directory names of the packages that declare a server entry (feature packages). */
function serverEntryPackageIds(repoRoot) {
  return new Set(packageDirs(repoRoot).filter(({ manifest }) => manifest.polyth?.serverEntry).map(({ id }) => id));
}

/**
 * The electron-builder configuration of the workstation package, derived from
 * the `build` field of apps/desktop/package.json:
 *  - artifact names carry `-workstation-`;
 *  - no Chromium and no Polyth Link binaries are packaged;
 *  - only the web bundles and assets of workstation packages are packaged;
 *  - playwright-core is left out of the app files;
 *  - update metadata uses the `workstation` channel.
 */
export function workstationBuildConfig(baseConfig, { packageIds }) {
  const config = structuredClone(baseConfig);
  config.artifactName = "${productName}-${version}-${os}-${arch}-workstation.${ext}";
  config.files = [...(config.files ?? []), "!**/node_modules/playwright-core/**"];
  config.extraResources = (config.extraResources ?? [])
    .filter((entry) => {
      const to = typeof entry === "string" ? entry : entry.to ?? "";
      return !/^chromium(\/|$)/.test(to) && !/^polyth-link(\/|$)/.test(to);
    })
    .map((entry) => {
      if (typeof entry === "string" || entry.to !== "packages") return entry;
      return {
        ...entry,
        filter: packageIds.flatMap((id) => [`${id}/dist/web/**/*`, `${id}/assets/**/*`]),
      };
    });
  config.publish = { ...(Array.isArray(config.publish) ? config.publish[0] : config.publish), channel: WORKSTATION_CHANNEL };
  return config;
}

/**
 * Writes the derived configuration to `file` and returns the electron-builder
 * arguments that use it. `--config <file>` replaces the package.json `build`
 * field entirely (app-builder-lib util/config/load.js getConfig reads only the
 * named file), so the file is the full configuration; relative `from` paths
 * still resolve against the project directory (apps/desktop), not the file.
 * `--config.*` options passed afterwards are merged on top.
 */
export function workstationBuilderArgs({ repoRoot, file, packageIds = workstationPackageIds(repoRoot) }) {
  const base = readJson(join(repoRoot, "apps/desktop/package.json")).build;
  writeFileSync(file, `${JSON.stringify(workstationBuildConfig(base, { packageIds }), null, 2)}\n`);
  return ["--config", file];
}

const posix = (path) => path.split(sep).join("/");

/** Resources directory of an unpacked electron-builder output (win-unpacked, linux-unpacked, mac/Polyth.app). */
export function resourcesDirOf(appOutDir) {
  const plain = join(appOutDir, "resources");
  if (existsSync(plain)) return plain;
  const app = existsSync(appOutDir) && statSync(appOutDir).isDirectory()
    ? readdirSync(appOutDir).find((name) => name.endsWith(".app"))
    : undefined;
  if (app) return join(appOutDir, app, "Contents", "Resources");
  if (appOutDir.endsWith(".app")) return join(appOutDir, "Contents", "Resources");
  throw new Error(`No resources directory under ${appOutDir}`);
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Metafile input keys as repo-relative posix paths; virtual (`namespace:`) inputs are dropped. */
function metafileInputs(metafilePath, repoRoot, workingDir) {
  const inputs = Object.keys(readJson(metafilePath).inputs ?? {});
  return inputs
    .filter((key) => !/^[A-Za-z][A-Za-z0-9-]+:/.test(key))
    .map((key) => posix(relative(repoRoot, resolve(workingDir, key))));
}

/**
 * Throws when an unpacked workstation package or its main-process bundle holds
 * anything the edition must not ship (see docs/security/workstation-edition.md).
 * Every problem is listed in the one error.
 */
export function assertWorkstationPackage({ appOutDir, resourcesDir, metafilePath, packageIds, repoRoot, workingDir = join(repoRoot, "apps/desktop") }) {
  const problems = [];
  const resources = resourcesDir ?? resourcesDirOf(appOutDir);
  const allowed = new Set(packageIds);

  if (existsSync(join(resources, "chromium"))) problems.push("resources/chromium is packaged");
  const link = filesUnder(join(resources, "polyth-link"));
  if (link.length > 0) problems.push(`resources/polyth-link holds ${link.map((file) => basename(file)).join(", ")}`);

  const packagesDir = join(resources, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!allowed.has(entry.name)) problems.push(`resources/packages/${entry.name} is not a workstation package`);
    }
  }

  const feature = serverEntryPackageIds(repoRoot);
  const foreign = new Set();
  let playwright = false;
  for (const input of metafileInputs(metafilePath, repoRoot, workingDir)) {
    const owner = /^packages\/([^/]+)\//.exec(input)?.[1];
    if (owner && feature.has(owner) && !allowed.has(owner)) foreign.add(owner);
    if (/(^|\/)node_modules\/playwright-core\//.test(input)) playwright = true;
  }
  // External imports never appear among the inputs: an excluded package that
  // still imported playwright-core would leave a bare import in dist/main.js.
  for (const output of Object.values(readJson(metafilePath).outputs ?? {})) {
    if ((output.imports ?? []).some((entry) => entry.external && /^playwright-core(\/|$)/.test(entry.path))) playwright = true;
  }
  for (const id of [...foreign].sort()) problems.push(`main bundle includes packages/${id}, which is not a workstation package`);
  if (playwright) problems.push("main bundle includes or imports playwright-core");

  for (const archive of ["app.asar", "app.asar.unpacked"]) {
    const path = join(resources, archive);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory()
      ? filesUnder(path).map((file) => posix(relative(path, file)))
      : asarFiles(path);
    const shipped = files.filter((file) => /(^|\/)node_modules\/playwright-core(\/|$)/.test(file));
    if (shipped.length > 0) problems.push(`${archive} ships node_modules/playwright-core`);
  }

  if (problems.length > 0) throw new Error(`Workstation package check failed:\n- ${problems.join("\n- ")}`);
}

/**
 * File paths inside an asar archive, read from its header: a Chromium pickle
 * holding the header pickle's size, then a pickle with one string (the JSON
 * file tree). No dependency on @electron/asar.
 */
export function asarFiles(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonLength = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || jsonLength <= 0 || jsonLength > 256 * 1024 * 1024) throw new Error(`Not an asar archive: ${file}`);
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    const walk = (node, prefix) => Object.entries(node.files ?? {}).flatMap(([name, child]) =>
      child.files ? walk(child, `${prefix}${name}/`) : [`${prefix}${name}`]);
    return walk(JSON.parse(json.toString("utf8")), "");
  } finally {
    closeSync(fd);
  }
}

/** `node_modules/<name>` root (scoped or not) of the last node_modules segment of a path, or null. */
function nodeModulesRoot(path) {
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const rest = path.slice(at + "node_modules/".length).split("/");
  const length = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length < length || rest.slice(0, length).some((part) => !part)) return null;
  return { dir: path.slice(0, at + "node_modules/".length) + rest.slice(0, length).join("/"), name: rest.slice(0, length).join("/") };
}

const purl = (name, version) => `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}${version ? `@${version}` : ""}`;

/**
 * CycloneDX 1.5 bill of materials of what the workstation bundle contains:
 * every node_modules package esbuild read into dist/main.js (from the
 * metafile), the Electron runtime and the bundled opencode binary. Owned code;
 * no SBOM dependency.
 */
export function workstationSbom({ metafilePath, repoRoot, version, workingDir = join(repoRoot, "apps/desktop"), timestamp = new Date().toISOString() }) {
  const desktop = readJson(join(repoRoot, "apps/desktop/package.json"));
  const components = new Map();
  const add = (component) => {
    const key = `${component["bom-ref"]}`;
    if (!components.has(key)) components.set(key, component);
  };
  for (const input of metafileInputs(metafilePath, repoRoot, workingDir)) {
    const found = nodeModulesRoot(input);
    if (!found) continue;
    const manifestPath = join(repoRoot, found.dir, "package.json");
    const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
    const name = typeof manifest.name === "string" ? manifest.name : found.name;
    const packageVersion = typeof manifest.version === "string" ? manifest.version : undefined;
    const ref = purl(name, packageVersion);
    add({
      type: "library",
      "bom-ref": ref,
      name,
      ...(packageVersion ? { version: packageVersion } : {}),
      purl: ref,
      ...(typeof manifest.license === "string" ? { licenses: [{ expression: manifest.license }] } : {}),
    });
  }
  const electronVersion = String(desktop.devDependencies?.electron ?? "").replace(/^[\^~=v]+/, "");
  if (electronVersion) {
    const ref = purl("electron", electronVersion);
    add({ type: "framework", "bom-ref": ref, name: "electron", version: electronVersion, purl: ref, licenses: [{ expression: "MIT" }] });
  }
  const opencode = readJson(join(repoRoot, "apps/desktop/opencode.json"));
  if (opencode.version) {
    const ref = `pkg:github/${opencode.repository ?? "anomalyco/opencode"}@${opencode.version}`;
    add({ type: "application", "bom-ref": ref, name: "opencode", version: String(opencode.version), purl: ref });
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      component: { type: "application", "bom-ref": `pkg:generic/polyth-workstation@${version}`, name: "Polyth (workstation edition)", version },
    },
    components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version))),
  };
}

/** `sha256sum`-format text (`<hex>  <name>` per line) for the given files, sorted by name. */
export function sha256Sums(files) {
  return `${[...files]
    .sort((a, b) => basename(a).localeCompare(basename(b)))
    .map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`)
    .join("\n")}\n`;
}
