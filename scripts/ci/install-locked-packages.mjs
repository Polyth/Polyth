#!/usr/bin/env node
// Install packages that package-lock.json pins but `npm ci` skips on this
// machine (optional per-platform binaries, such as both macOS esbuild builds
// for a universal app). Each tarball is downloaded from the lockfile's
// `resolved` URL and must match its `integrity` hash before it is unpacked
// into node_modules, so nothing outside the lockfile can be installed.
//
// Usage: node scripts/ci/install-locked-packages.mjs <name> [<name> ...]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message) => {
  console.error(`install-locked-packages: ${message}`);
  process.exit(1);
};

const names = process.argv.slice(2);
if (names.length === 0) fail("name at least one package");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "locked-packages-"));

try {
  for (const name of names) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.resolved || !entry.integrity) fail(`${name} has no resolved URL and integrity in package-lock.json`);
    const url = new URL(entry.resolved);
    if (url.protocol !== "https:" || url.host !== "registry.npmjs.org") fail(`${name} does not resolve to registry.npmjs.org`);
    const response = await fetch(url);
    if (!response.ok) fail(`${name}: registry answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const [algorithm, expected] = entry.integrity.split(" ")[0].split(/-(.*)/s);
    if (algorithm !== "sha512") fail(`${name}: expected a sha512 integrity, got ${algorithm}`);
    if (createHash("sha512").update(bytes).digest("base64") !== expected) fail(`${name}: integrity mismatch`);
    const tarball = join(scratch, `${name.replaceAll("/", "__")}.tgz`);
    writeFileSync(tarball, bytes);
    const target = join("node_modules", name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], { stdio: "inherit" });
    if (unpacked.status !== 0) fail(`${name}: unpacking failed`);
    console.log(`installed ${name}@${entry.version} (integrity verified)`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
