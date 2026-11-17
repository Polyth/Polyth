// `polyth update` for a packaged server install (release archive or the
// `polyth` npm package). Installs managed by something else (Homebrew,
// Docker, a source checkout) are told how that manager updates them.
//
// A release archive is replaced inside its own directory: the new tree is
// unpacked into `<root>/.update-<version>/`, the current entries move to
// `<root>/.previous/` and the new ones take their place. Paths a service unit
// names (`<root>/bin/polyth.mjs`) never change, the server's user only needs
// write access to its own install, and `.previous/` is the way back
// (`polyth update --rollback`). Databases are protected by the server itself:
// it copies each one before migrating it (pre-migration/ in the data
// directory), and only those copies take a migrated schema back.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export type InstallKind =
  | { kind: "archive"; root: string }
  | { kind: "npm"; root: string; global: boolean; prefix: string }
  | { kind: "homebrew"; root: string }
  | { kind: "docker" }
  | { kind: "checkout"; root: string }
  | { kind: "unknown" };

export function installKind(input: {
  bundle?: string;
  checkout?: string;
  docker: boolean;
  /** `npm root -g`, when npm answered. */
  npmGlobalRoot?: string;
}): InstallKind {
  if (input.docker) return { kind: "docker" };
  const bundle = input.bundle;
  if (bundle) {
    if (bundle.includes(`${sep}Cellar${sep}polyth${sep}`)) return { kind: "homebrew", root: bundle };
    const nodeModules = dirname(bundle);
    if (basename(bundle) === "polyth" && basename(nodeModules) === "node_modules") {
      const global = input.npmGlobalRoot !== undefined && nodeModules === input.npmGlobalRoot;
      return { kind: "npm", root: bundle, global, prefix: dirname(nodeModules) };
    }
    return { kind: "archive", root: bundle };
  }
  if (input.checkout) return { kind: "checkout", root: input.checkout };
  return { kind: "unknown" };
}

/** How the install's own manager updates it, for installs `polyth update` leaves alone. */
export function managedElsewhere(kind: InstallKind): string | null {
  switch (kind.kind) {
    case "homebrew": return "This Polyth is installed by Homebrew: update it with `brew upgrade polyth`, then `brew services restart polyth`.";
    case "docker": return "This Polyth runs in a container: pull a newer image (`docker compose pull && docker compose up -d`).";
    case "checkout": return "This Polyth runs from a source checkout: `git pull && npm ci && npm run build && npm run polyth:restart`.";
    case "unknown": return "No packaged Polyth server install found here; `polyth update` updates the npm package or a release archive.";
    default: return null;
  }
}

// ---- versions and releases ------------------------------------------------

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Release order: numbers first, then a stable release above any prerelease of the same numbers. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) throw new Error(`not a Polyth version: ${left ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  return left[4] < right[4] ? -1 : 1;
}

export type Channel = "stable" | "nightly";

export function channelOf(version: string): Channel {
  return /-nightly$/.test(version) ? "nightly" : "stable";
}

export interface Release {
  version: string;
  prerelease: boolean;
  assets: Map<string, string>;
}

/** GitHub's `GET /repos/{owner}/{repo}/releases` answer, published releases only. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) throw new Error("unexpected releases answer");
  return json.flatMap((entry: { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }) => {
    if (entry.draft === true || typeof entry.tag_name !== "string") return [];
    const version = entry.tag_name.replace(/^v/, "");
    if (!VERSION.test(version)) return [];
    const assets = new Map<string, string>();
    for (const asset of Array.isArray(entry.assets) ? entry.assets as Array<{ name?: unknown; browser_download_url?: unknown }> : []) {
      if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") assets.set(asset.name, asset.browser_download_url);
    }
    return [{ version, prerelease: entry.prerelease === true, assets }];
  });
}

export function pickRelease(releases: Release[], channel: Channel, version?: string): Release | undefined {
  if (version) return releases.find((release) => release.version === version);
  const wanted = releases.filter((release) => channelOf(release.version) === channel
    && (channel === "nightly" || !release.prerelease));
  return wanted.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export const serverArchiveName = (version: string, target: string) => `polyth-server-${version}-${target}.tar.gz`;
export const SERVER_SUMS_NAME = "SHA256SUMS-server.txt";

export function expectedDigest(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return undefined;
}

// ---- archive installs -----------------------------------------------------

/** Entries of an install directory that belong to the release, not to updates. */
const releaseEntries = (dir: string): string[] => readdirSync(dir).filter((name) => !name.startsWith("."));

export const PREVIOUS_DIR = ".previous";
export const stagingDir = (root: string, version: string) => join(root, `.update-${version}`);

export interface BuildInfo { version: string; target: string }

export function readBuild(root: string): BuildInfo {
  const build = JSON.parse(readFileSync(join(root, "BUILD.json"), "utf8")) as Partial<BuildInfo>;
  if (typeof build.version !== "string" || typeof build.target !== "string") throw new Error(`${root}/BUILD.json is incomplete`);
  return { version: build.version, target: build.target };
}

/** Verifies and unpacks a downloaded archive into the install's staging directory. */
export function stageArchive(input: { root: string; version: string; target: string; archive: Uint8Array; sums: string }): string {
  const name = serverArchiveName(input.version, input.target);
  const expected = expectedDigest(input.sums, name);
  if (!expected) throw new Error(`${SERVER_SUMS_NAME} has no checksum for ${name}`);
  const actual = createHash("sha256").update(input.archive).digest("hex");
  if (actual !== expected) throw new Error(`${name} does not match its checksum (got ${actual.slice(0, 12)}…, want ${expected.slice(0, 12)}…)`);
  const staging = stagingDir(input.root, input.version);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const file = join(staging, name);
  writeFileSync(file, input.archive);
  const unpacked = spawnSync("tar", ["-xzf", file, "-C", staging], { encoding: "utf8" });
  rmSync(file, { force: true });
  if (unpacked.status !== 0) throw new Error(`could not unpack ${name}: ${unpacked.stderr.trim()}`);
  const tree = join(staging, "polyth");
  const build = readBuild(tree);
  if (build.version !== input.version || build.target !== input.target) {
    throw new Error(`${name} holds ${build.version} for ${build.target}, not ${input.version} for ${input.target}`);
  }
  return tree;
}

/** Moves every entry of `from` into `to`, undoing the moves if one fails. */
function moveEntries(names: string[], from: string, to: string): void {
  const moved: string[] = [];
  try {
    for (const name of names) {
      renameSync(join(from, name), join(to, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse()) renameSync(join(to, name), join(from, name));
    throw error;
  }
}

/** The new tree takes the install's place; the current one moves to .previous/. */
export function swapInstall(root: string, staged: string): void {
  const previous = join(root, PREVIOUS_DIR);
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(previous);
  const current = releaseEntries(root);
  moveEntries(current, root, previous);
  try {
    moveEntries(releaseEntries(staged), staged, root);
  } catch (error) {
    moveEntries(current, previous, root);
    throw error;
  }
  rmSync(dirname(staged), { recursive: true, force: true });
}

/** Puts .previous/ back; the replaced release is removed. Returns the restored version. */
export function rollbackInstall(root: string): string {
  const previous = join(root, PREVIOUS_DIR);
  if (!existsSync(join(previous, "BUILD.json"))) throw new Error(`no previous release kept in ${previous}`);
  const restored = readBuild(previous).version;
  const replaced = join(root, `.replaced-${Date.now()}`);
  mkdirSync(replaced);
  const current = releaseEntries(root);
  moveEntries(current, root, replaced);
  try {
    moveEntries(releaseEntries(previous), previous, root);
  } catch (error) {
    moveEntries(current, replaced, root);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  rmSync(replaced, { recursive: true, force: true });
  return restored;
}

// ---- one update at a time -------------------------------------------------

export function acquireUpdateLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".polyth-update.lock");
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch {
    throw new Error(`another update is running (${file}); remove the file if it is not`);
  }
  writeFileSync(fd, `${process.pid}\n`);
  closeSync(fd);
  return () => rmSync(file, { force: true });
}
