#!/usr/bin/env node
// Builds the `master` tree from a `devel` checkout. `devel` carries every
// package; `master`, the release line, carries every package except the
// unfinished previews (`polyth.descriptor.maturity: "in-progress"`). The
// repository already guarantees that a removable package is one folder
// (scripts/test/packageRemovability.test.ts), so a promotion deletes those
// folders, regenerates what discovery derives, and prunes the lockfile and the
// agent navigation maps.
//
//   node scripts/ci/promote-master.mjs plan                      # print the plan, change nothing
//   node scripts/ci/promote-master.mjs check-drift <master> <devel>
//                                                               # refuse master changes devel lacks
//   node scripts/ci/promote-master.mjs apply                     # edit this working tree into the master tree
//
// `apply` edits the working tree it runs in; run it in a clean checkout of the
// devel commit being promoted. The promote workflow (.github/workflows/promote.yml)
// commits the result with the previous master and the devel commit as parents
// and records `Promoted-from: <devel sha>` in the message.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMOTED_FROM_TRAILER = "Promoted-from";
/** Maturity values that stay on devel only. `beta` packages work and ship off by default. */
export const DEVEL_ONLY_MATURITY = new Set(["in-progress"]);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
// npm writes package.json and package-lock.json as 2-space JSON with a final newline.
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function listManifests(root) {
  const manifests = [];
  for (const dir of ["packages", "apps"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(file)) {
        manifests.push({ id: entry.name, dir: `${dir}/${entry.name}`, manifest: readJson(file) });
      }
    }
  }
  return manifests.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Which packages leave master, and whether removing them is safe.
 * A kept workspace that declares an excluded package as a dependency, dev
 * dependency or required peer would break without it, so it blocks the plan.
 */
export function releasePlan(root) {
  const manifests = listManifests(root);
  const excluded = manifests
    .filter(({ dir, manifest }) => dir.startsWith("packages/")
      && DEVEL_ONLY_MATURITY.has(manifest.polyth?.descriptor?.maturity))
    .map(({ id, dir, manifest }) => ({ id, dir, name: manifest.name, maturity: manifest.polyth.descriptor.maturity }));
  const excludedNames = new Map(excluded.map((entry) => [entry.name, entry.id]));
  const excludedDirs = new Set(excluded.map((entry) => entry.dir));
  const problems = [];
  const dependents = [...manifests.filter(({ dir }) => !excludedDirs.has(dir)),
    { dir: ".", manifest: readJson(join(root, "package.json")) }];
  for (const { dir, manifest } of dependents) {
    const optionalPeers = manifest.peerDependenciesMeta ?? {};
    const required = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => optionalPeers[name]?.optional !== true),
    ];
    for (const name of required) {
      if (excludedNames.has(name)) problems.push(`${dir} depends on devel-only package ${name}`);
    }
  }
  return { excluded, problems };
}

function run(command, args, cwd, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = capture ? `\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ""}${detail}`);
  }
  return result;
}

/** Workspace entries for removed folders, which `npm install` keeps as `extraneous`. */
export function dropWorkspaceLockEntries(lock, removedDirs) {
  let removed = 0;
  for (const key of Object.keys(lock.packages ?? {})) {
    if (removedDirs.some((dir) => key === dir || key.startsWith(`${dir}/`))) {
      delete lock.packages[key];
      removed += 1;
    }
  }
  return removed;
}

/** `!packages/<id>` negations only make sense while the folder exists. */
export function dropWorkspaceNegations(workspaces, removedDirs) {
  if (!Array.isArray(workspaces)) return workspaces;
  return workspaces.filter((pattern) => !removedDirs.some((dir) => pattern === `!${dir}`));
}

const TASK_MAP = "docs/agents/task-map.json";
const EVIDENCE = "docs/agents/evidence.json";

/**
 * The agent navigation kit (scripts/agent-kit.mjs) requires every mapped
 * entrypoint and reference to exist. devel maps its previews; master's map
 * must name only what master ships, so drop the paths inside removed folders.
 */
export function pruneAgentMaps(root, removedDirs) {
  const inside = (path) => removedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
  const mapPath = join(root, TASK_MAP);
  if (existsSync(mapPath)) {
    const map = readJson(mapPath);
    for (const area of map.areas ?? []) {
      for (const field of ["match", "entrypoints", "references", "testHints"]) {
        if (Array.isArray(area[field])) area[field] = area[field].filter((path) => !inside(path));
      }
    }
    writeJson(mapPath, map);
  }
  const evidencePath = join(root, EVIDENCE);
  if (existsSync(evidencePath)) {
    const evidence = readJson(evidencePath);
    if (Array.isArray(evidence.sources)) evidence.sources = evidence.sources.filter((source) => !inside(source.path));
    writeJson(evidencePath, evidence);
  }
}

/**
 * Turn the working tree into the master tree. `options.npmInstall` and
 * `options.generate` exist for tests; production runs npm and the i18n generator.
 */
export function applyPlan(root, plan, options = {}) {
  if (plan.problems.length > 0) {
    throw new Error(`Refusing to promote:\n  ${plan.problems.join("\n  ")}`);
  }
  const npmInstall = options.npmInstall ?? ((cwd) =>
    run(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd));
  const generate = options.generate ?? ((cwd) =>
    run(process.execPath, ["--experimental-strip-types", "apps/web/generateI18n.ts"], cwd));
  const removedDirs = plan.excluded.map((entry) => entry.dir);
  for (const dir of removedDirs) rmSync(join(root, dir), { recursive: true, force: true });

  const manifestPath = join(root, "package.json");
  const manifest = readJson(manifestPath);
  if (manifest.workspaces) {
    manifest.workspaces = dropWorkspaceNegations(manifest.workspaces, removedDirs);
    writeJson(manifestPath, manifest);
  }

  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    // npm drops the links and orphaned dependencies and mirrors `workspaces`;
    // the removed workspace entries themselves need deleting by hand, after
    // which a second pass must leave the lockfile untouched.
    npmInstall(root);
    const lock = readJson(lockPath);
    dropWorkspaceLockEntries(lock, removedDirs);
    writeJson(lockPath, lock);
    const settled = readFileSync(lockPath, "utf8");
    npmInstall(root);
    if (readFileSync(lockPath, "utf8") !== settled) {
      throw new Error("package-lock.json did not settle after pruning the removed workspaces");
    }
  }
  pruneAgentMaps(root, removedDirs);
  generate(root);
  return { removed: removedDirs };
}

function git(cwd, args, options) {
  return run("git", args, cwd, { capture: true, ...options });
}

function blob(cwd, rev, path) {
  const result = git(cwd, ["rev-parse", "-q", "--verify", `${rev}:${path}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function catBlob(cwd, oid) {
  return oid ? git(cwd, ["cat-file", "blob", oid]).stdout : "";
}

/** Newest first-parent master commit whose message records the devel commit it was promoted from. */
export function lastPromotion(cwd, master) {
  const log = git(cwd, ["log", "--first-parent", "--format=%H%x00%B%x01", master]).stdout;
  const pattern = new RegExp(`^${PROMOTED_FROM_TRAILER}: ([0-9a-f]{40})$`, "m");
  for (const record of log.split("\x01")) {
    const [sha, body = ""] = record.replace(/^\n/, "").split("\x00");
    const match = pattern.exec(body);
    if (sha && match) return { commit: sha, devel: match[1] };
  }
  return null;
}

/**
 * Paths changed directly on master since the last promotion (or since master
 * and devel diverged, before the first one) whose change devel does not carry.
 * A promotion rebuilds master from devel, so such a change would be lost:
 * forward it to devel first. A change counts as carried when devel holds the
 * same content, or when merging master's edit into devel's file is a no-op.
 */
export function masterDrift(cwd, master, devel) {
  const previous = lastPromotion(cwd, master);
  const base = previous?.commit ?? git(cwd, ["merge-base", master, devel]).stdout.trim();
  const changed = git(cwd, ["diff", "--name-only", "--no-renames", base, master]).stdout.split("\n").filter(Boolean);
  const drift = [];
  let scratch = null;
  for (const path of changed) {
    const ours = blob(cwd, devel, path);
    const theirs = blob(cwd, master, path);
    if (ours === theirs) continue;
    const ancestor = blob(cwd, base, path);
    if (ours !== null && theirs !== null && ancestor !== null) {
      scratch ??= mkdtempSync(join(tmpdir(), "polyth-promote-"));
      const files = [["ours", ours], ["base", ancestor], ["theirs", theirs]].map(([name, oid]) => {
        const file = join(scratch, name);
        writeFileSync(file, catBlob(cwd, oid));
        return file;
      });
      const merged = run("git", ["merge-file", "-p", "-q", ...files], cwd, { capture: true, allowFailure: true });
      if (merged.status === 0 && merged.stdout === catBlob(cwd, ours)) continue;
    }
    drift.push(path);
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  return { base, drift };
}

function main(argv) {
  const [command, ...rest] = argv;
  const root = resolve(process.cwd());
  // A plan computed anywhere else would find no packages and remove nothing.
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "packages"))) {
    process.stderr.write("promote-master: run from the repository root\n");
    return 2;
  }
  if (command === "plan") {
    const plan = releasePlan(root);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan.problems.length === 0 ? 0 : 1;
  }
  if (command === "check-drift") {
    const [master, devel] = rest;
    if (!master || !devel) throw new Error("usage: promote-master.mjs check-drift <master-ref> <devel-ref>");
    const { base, drift } = masterDrift(root, master, devel);
    if (drift.length > 0) {
      process.stderr.write(`master changed since ${base.slice(0, 12)} in ways devel does not carry; forward these to devel first:\n  ${drift.join("\n  ")}\n`);
      return 1;
    }
    process.stdout.write(`promote-master: no master-only changes since ${base.slice(0, 12)}\n`);
    return 0;
  }
  if (command === "apply") {
    const plan = releasePlan(root);
    const { removed } = applyPlan(root, plan);
    process.stdout.write(`promote-master: removed ${removed.length ? removed.join(", ") : "nothing"}\n`);
    return 0;
  }
  process.stderr.write("usage: promote-master.mjs plan | check-drift <master> <devel> | apply\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
