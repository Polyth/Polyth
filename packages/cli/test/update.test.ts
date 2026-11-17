import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { main } from "../src/main.ts";
import { serviceRunsInstall } from "../src/commands/update.ts";
import {
  acquireUpdateLock,
  channelOf,
  compareVersions,
  expectedDigest,
  installKind,
  managedElsewhere,
  parseReleases,
  pickRelease,
  PREVIOUS_DIR,
  readBuild,
  rollbackInstall,
  SERVER_SUMS_NAME,
  serverArchiveName,
  stageArchive,
  stagingDir,
  swapInstall,
} from "../src/update.ts";

const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("each install is updated by what installed it", () => {
  assert.deepEqual(installKind({ docker: true, bundle: "/opt/polyth" }), { kind: "docker" });
  assert.deepEqual(installKind({ docker: false, bundle: `${sep}opt${sep}homebrew${sep}Cellar${sep}polyth${sep}1.2.3${sep}libexec` }).kind, "homebrew");
  const globalRoot = join("/usr", "lib", "node_modules");
  assert.deepEqual(installKind({ docker: false, bundle: join(globalRoot, "polyth"), npmGlobalRoot: globalRoot }),
    { kind: "npm", root: join(globalRoot, "polyth"), global: true, prefix: join("/usr", "lib") });
  assert.deepEqual(installKind({ docker: false, bundle: join("/srv", "app", "node_modules", "polyth"), npmGlobalRoot: globalRoot }),
    { kind: "npm", root: join("/srv", "app", "node_modules", "polyth"), global: false, prefix: join("/srv", "app") });
  assert.deepEqual(installKind({ docker: false, bundle: "/opt/polyth" }), { kind: "archive", root: "/opt/polyth" });
  assert.deepEqual(installKind({ docker: false, checkout: "/src/polyth" }), { kind: "checkout", root: "/src/polyth" });
  assert.deepEqual(installKind({ docker: false }), { kind: "unknown" });
  assert.match(managedElsewhere({ kind: "homebrew", root: "/x" })!, /brew upgrade polyth/);
  assert.match(managedElsewhere({ kind: "docker" })!, /docker compose pull/);
  assert.match(managedElsewhere({ kind: "checkout", root: "/x" })!, /git pull/);
  assert.equal(managedElsewhere({ kind: "archive", root: "/x" }), null);
});

test("release order: numbers, then stable above its own prerelease", () => {
  assert.equal(compareVersions("1.2.357", "1.2.356"), 1);
  assert.equal(compareVersions("1.2.356", "1.2.357-nightly"), -1);
  assert.equal(compareVersions("1.2.357", "1.2.357-nightly"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1, "numeric, not lexical");
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.throws(() => compareVersions("v1.2.3", "1.2.3"), /not a Polyth version/);
  assert.equal(channelOf("1.2.360-nightly"), "nightly");
  assert.equal(channelOf("1.2.360"), "stable");
});

test("the newest published release of a channel is picked", () => {
  const releases = parseReleases([
    { tag_name: "v1.2.358-nightly", prerelease: true, draft: false, assets: [{ name: "a", browser_download_url: "https://x/a" }] },
    { tag_name: "v1.2.359", prerelease: false, draft: true, assets: [] },
    { tag_name: "v1.2.357", prerelease: false, draft: false, assets: [] },
    { tag_name: "v1.2.360-nightly", prerelease: true, draft: false, assets: [] },
    { tag_name: "not-a-version", prerelease: false, draft: false, assets: [] },
    { tag_name: "v1.2.356", prerelease: false, draft: false, assets: [] },
  ]);
  assert.deepEqual(releases.map((release) => release.version), ["1.2.358-nightly", "1.2.357", "1.2.360-nightly", "1.2.356"]);
  assert.equal(pickRelease(releases, "stable")?.version, "1.2.357", "drafts never");
  assert.equal(pickRelease(releases, "nightly")?.version, "1.2.360-nightly");
  assert.equal(pickRelease(releases, "stable", "1.2.356")?.version, "1.2.356");
  assert.equal(pickRelease(releases, "stable", "1.2.999"), undefined);
  assert.equal(releases[0]!.assets.get("a"), "https://x/a");
});

/** An install tree as the release archive unpacks it. */
function tree(dir: string, version: string, target: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "BUILD.json"), JSON.stringify({ version, commit: "c", target }));
  writeFileSync(join(dir, "bin", "polyth.mjs"), `// ${version}\n`);
  writeFileSync(join(dir, "dist", "server.mjs"), `// server ${version}\n`);
}

function archiveOf(dir: string, version: string, target: string): { archive: Uint8Array; sums: string } {
  const source = join(dir, `src-${version}`);
  tree(join(source, "polyth"), version, target);
  const file = join(dir, serverArchiveName(version, target));
  assert.equal(spawnSync("tar", ["-czf", file, "-C", source, "polyth"]).status, 0);
  const archive = new Uint8Array(readFileSync(file));
  const digest = createHash("sha256").update(archive).digest("hex");
  return { archive, sums: `${"0".repeat(64)}  other.tar.gz\n${digest}  ${serverArchiveName(version, target)}\n` };
}

test("an archive install is replaced in place, keeps the previous release and can go back", (t) => {
  const dir = scratch(t);
  const root = join(dir, "polyth");
  tree(root, "1.2.356", "linux-x64");
  const { archive, sums } = archiveOf(dir, "1.2.357", "linux-x64");
  assert.equal(expectedDigest(sums, serverArchiveName("1.2.357", "linux-x64"))?.length, 64);

  const tampered = new Uint8Array(archive);
  tampered[tampered.length - 1] = tampered.at(-1)! ^ 1;
  assert.throws(() => stageArchive({ root, version: "1.2.357", target: "linux-x64", archive: tampered, sums }), /does not match its checksum/);
  assert.throws(() => stageArchive({ root, version: "1.2.357", target: "linux-x64", archive, sums: "" }), new RegExp(`${SERVER_SUMS_NAME} has no checksum`));
  assert.throws(() => stageArchive({ root, version: "1.2.357", target: "darwin-arm64", archive, sums }), /no checksum/);
  assert.equal(readBuild(root).version, "1.2.356", "a rejected archive leaves the install alone");

  const staged = stageArchive({ root, version: "1.2.357", target: "linux-x64", archive, sums });
  assert.equal(staged, join(stagingDir(root, "1.2.357"), "polyth"));
  swapInstall(root, staged);
  assert.equal(readBuild(root).version, "1.2.357");
  assert.equal(readFileSync(join(root, "bin", "polyth.mjs"), "utf8"), "// 1.2.357\n", "same paths, new files");
  assert.equal(readBuild(join(root, PREVIOUS_DIR)).version, "1.2.356");
  assert.equal(existsSync(stagingDir(root, "1.2.357")), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".")), [PREVIOUS_DIR]);

  assert.equal(rollbackInstall(root), "1.2.356");
  assert.equal(readBuild(root).version, "1.2.356");
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".")), [], "nothing left behind");
  assert.throws(() => rollbackInstall(root), /no previous release kept/);
});

test("an archive of another release or platform is refused", (t) => {
  const dir = scratch(t);
  const root = join(dir, "polyth");
  tree(root, "1.2.356", "linux-x64");
  const { archive } = archiveOf(dir, "1.2.357", "linux-x64");
  // A checksum file that vouches for the bytes under the wrong release's name.
  const digest = createHash("sha256").update(archive).digest("hex");
  assert.throws(
    () => stageArchive({ root, version: "1.2.358", target: "linux-x64", archive, sums: `${digest}  ${serverArchiveName("1.2.358", "linux-x64")}\n` }),
    /holds 1\.2\.357 for linux-x64, not 1\.2\.358/,
  );
  assert.equal(readBuild(root).version, "1.2.356");
});

test("only a service that runs this install is restarted", () => {
  const unit = "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/polyth/bin/polyth.mjs server start ; ignore_errors=no }";
  assert.equal(serviceRunsInstall(unit, "/opt/polyth"), true);
  // A polyth.service that runs a checkout (or another install) is someone else's.
  assert.equal(serviceRunsInstall("{ argv[]=/opt/node/bin/node --experimental-strip-types packages/server/src/index.ts }", "/opt/polyth"), false);
  assert.equal(serviceRunsInstall(unit, "/opt/polyth-next"), false);
});

test("one update at a time", (t) => {
  const dir = scratch(t);
  const release = acquireUpdateLock(dir);
  assert.throws(() => acquireUpdateLock(dir), /another update is running/);
  release();
  acquireUpdateLock(dir)();
});

test("polyth update sends a checkout to git", async () => {
  const previous = process.env.POLYTH_SERVER_BUNDLE;
  delete process.env.POLYTH_SERVER_BUNDLE;
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    if (existsSync("/.dockerenv")) return;
    assert.equal(await main(["update", "--check"]), 2);
  } finally {
    process.stderr.write = write;
    if (previous !== undefined) process.env.POLYTH_SERVER_BUNDLE = previous;
  }
  assert.match(errors.join(""), /source checkout: `git pull/);
});
