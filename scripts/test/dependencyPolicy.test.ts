// Every third-party dependency is a reviewed decision (AGENTS.md
// "Dependencies"). This test keeps the reviewed list in
// scripts/dependency-policy.json honest:
// - each direct npm or Cargo dependency is listed with its exposure and reason,
//   and the list names exactly the manifests that declare it;
// - only listed packages may run install scripts;
// - the lockfiles never grow past their budget. When a change shrinks a tree,
//   lower the budget in the same change so the gain cannot be lost silently.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

type Exposure = "shipped" | "build" | "release";
interface Entry { exposure: Exposure; users: string[] | "*"; why: string }
interface Policy {
  budget: { npmLockPackages: Record<string, number>; cargoLockCrates: Record<string, number> };
  npm: Record<string, Entry>;
  installScripts: Record<string, string>;
  cargo: Record<string, Entry>;
}

const policy = JSON.parse(readFileSync(join(root, "scripts/dependency-policy.json"), "utf8")) as Policy;
const EXPOSURES = new Set<Exposure>(["shipped", "build", "release"]);
const NPM_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const;

/** root, apps/*, packages/* and the release-only tools/release manifests, including folders the root workspace list excludes. */
function npmManifests(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  out.set(".", JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  for (const group of ["apps", "packages"]) {
    for (const dir of readdirSync(join(root, group)).sort()) {
      const file = join(root, group, dir, "package.json");
      if (existsSync(file)) out.set(`${group}/${dir}`, JSON.parse(readFileSync(file, "utf8")));
    }
  }
  out.set("tools/release", JSON.parse(readFileSync(join(root, "tools/release/package.json"), "utf8")));
  return out;
}

function directNpmDependencies(): Map<string, Set<string>> {
  const manifests = npmManifests();
  const own = new Set([...manifests.values()].map((manifest) => manifest.name).filter((name): name is string => typeof name === "string"));
  const users = new Map<string, Set<string>>();
  for (const [dir, manifest] of manifests) {
    for (const field of NPM_FIELDS) {
      const block = manifest[field];
      if (!block || typeof block !== "object") continue;
      for (const [name, spec] of Object.entries(block as Record<string, string>)) {
        if (own.has(name) || name.startsWith("@polyth/") || String(spec).startsWith("file:")) continue;
        if (!users.has(name)) users.set(name, new Set());
        users.get(name)!.add(dir);
      }
    }
  }
  return users;
}

function cargoManifests(): string[] {
  const files = ["Cargo.toml", "fuzz/Cargo.toml"];
  for (const dir of readdirSync(join(root, "crates")).sort()) {
    if (existsSync(join(root, "crates", dir, "Cargo.toml"))) files.push(`crates/${dir}/Cargo.toml`);
  }
  return files;
}

/** Dependency names from every `*dependencies` table of a Cargo.toml (local polyth-* crates excluded). */
export function cargoDependencyNames(text: string): Set<string> {
  const names = new Set<string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim();
      const table = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (table) names.add(table[1]);
      continue;
    }
    if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(section)) continue;
    const key = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\s*=/.exec(line);
    if (key) names.add(key[1]);
  }
  for (const name of names) if (name.startsWith("polyth-")) names.delete(name);
  return names;
}

function directCargoDependencies(): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  for (const file of cargoManifests()) {
    const dir = file === "Cargo.toml" ? "." : file.slice(0, -"/Cargo.toml".length);
    for (const name of cargoDependencyNames(readFileSync(join(root, file), "utf8"))) {
      if (!users.has(name)) users.set(name, new Set());
      users.get(name)!.add(dir);
    }
  }
  return users;
}

function checkEntries(kind: "npm" | "cargo", actual: Map<string, Set<string>>, listed: Record<string, Entry>): void {
  const problems: string[] = [];
  for (const [name, dirs] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = listed[name];
    if (!entry) {
      problems.push(`${name} (declared in ${[...dirs].sort().join(", ")}) is not in the ${kind} policy. Prefer a built-in or a few lines of owned code; if the dependency is really needed, add it with its exposure and reason.`);
      continue;
    }
    if (entry.users === "*") continue;
    const expected = [...entry.users].sort().join(", ");
    const got = [...dirs].sort().join(", ");
    if (expected !== got) problems.push(`${name}: policy users [${expected}] but declared in [${got}]. Update the users list deliberately.`);
  }
  for (const [name, entry] of Object.entries(listed)) {
    if (!actual.has(name)) problems.push(`${name} is in the ${kind} policy but nothing declares it any more. Remove the entry.`);
    if (!EXPOSURES.has(entry.exposure)) problems.push(`${name}: exposure must be shipped, build or release.`);
    if (!entry.why || entry.why.trim().length < 12) problems.push(`${name}: say why the dependency is needed.`);
  }
  assert.deepEqual(problems, []);
}

test("every direct npm dependency is reviewed and names exactly its users", () => {
  checkEntries("npm", directNpmDependencies(), policy.npm);
});

test("every direct Cargo dependency is reviewed and names exactly its users", () => {
  checkEntries("cargo", directCargoDependencies(), policy.cargo);
});

type Lock = { packages: Record<string, { link?: boolean; hasInstallScript?: boolean }> };
const lockName = (key: string): string => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
/** Third-party entries of each npm lockfile with a budget (the root install and the release-only tree). */
const npmLocks = Object.keys(policy.budget.npmLockPackages).map((file) => {
  const lock = JSON.parse(readFileSync(join(root, file), "utf8")) as Lock;
  return { file, installed: Object.entries(lock.packages).filter(([key, entry]) => key.includes("node_modules/") && !entry.link) };
});

test("every npm lockfile has a budget", () => {
  assert.deepEqual(npmLocks.map(({ file }) => file).sort(), ["package-lock.json", "tools/release/package-lock.json"]);
});

test("only reviewed packages run npm install scripts", () => {
  const running = [...new Set(npmLocks.flatMap(({ installed }) => installed.filter(([, entry]) => entry.hasInstallScript).map(([key]) => lockName(key))))].sort();
  const allowed = Object.keys(policy.installScripts).sort();
  assert.deepEqual(running.filter((name) => !allowed.includes(name)), [], "a new package runs an install script; review it and add it to installScripts");
  assert.deepEqual(allowed.filter((name) => !running.includes(name)), [], "installScripts lists a package that no longer runs one; remove it");
});

test("the npm lockfiles stay within their budgets", () => {
  for (const { file, installed } of npmLocks) {
    const unique = new Set(installed.map(([key]) => lockName(key))).size;
    const budget = policy.budget.npmLockPackages[file];
    assert.ok(unique <= budget, `${file} resolves ${unique} third-party packages, over the budget of ${budget}. Find what grew the tree before raising the budget.`);
  }
});

test("the Cargo lockfiles stay within their budgets", () => {
  for (const [file, budget] of Object.entries(policy.budget.cargoLockCrates)) {
    const text = readFileSync(join(root, file), "utf8");
    const crates = text.split("[[package]]").slice(1).filter((block) => /\nsource = /.test(block)).length;
    assert.ok(crates <= budget, `${file} resolves ${crates} third-party crates, over the budget of ${budget}.`);
  }
});

test("Cargo dependency tables are parsed, inline tables included", () => {
  const names = cargoDependencyNames([
    "[package]", "name = \"x\"", "[dependencies]", "serde.workspace = true", "url = \"2\"",
    "polyth-link-core = { path = \"../core\" }", "[dev-dependencies]", "tempfile = \"3\"",
    "[target.'cfg(unix)'.dependencies]", "libc = \"0.2\"", "[dependencies.tokio]", "features = [\"rt\"]",
    "[[bin]]", "name = \"tool\"", "path = \"src/bin/tool.rs\"", "[features]", "default = []",
  ].join("\n"));
  assert.deepEqual([...names].sort(), ["libc", "serde", "tempfile", "tokio", "url"]);
});

test("the release-only Capacitor CLI matches the app's Capacitor major version", () => {
  const major = (spec: string): string => /\d+/.exec(spec)?.[0] ?? spec;
  const tools = JSON.parse(readFileSync(join(root, "tools/release/package.json"), "utf8")) as { dependencies: Record<string, string> };
  const mobile = JSON.parse(readFileSync(join(root, "apps/mobile/package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(major(tools.dependencies["@capacitor/cli"]), major(mobile.dependencies["@capacitor/core"]));
});
