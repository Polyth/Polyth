import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PROMOTED_FROM_TRAILER,
  applyPlan,
  dropWorkspaceLockEntries,
  dropWorkspaceNegations,
  lastPromotion,
  masterDrift,
  releasePlan,
} from "../ci/promote-master.mjs";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function write(root: string, path: string, contents: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function pkg(root: string, id: string, manifest: Record<string, unknown>): void {
  write(root, `packages/${id}/package.json`, json({ name: `@polyth/${id}`, version: "0.1.0", ...manifest }));
  write(root, `packages/${id}/src/index.ts`, `export const id = "${id}";\n`);
}

const preview = (maturity: string) => ({ polyth: { descriptor: { enabled: false, maturity } } });

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "polyth-promote-"));
  write(root, "package.json", json({ name: "polyth", private: true, workspaces: ["packages/*", "!packages/runtime-only", "apps/*"] }));
  pkg(root, "core", { polyth: { descriptor: { enabled: true } } });
  pkg(root, "beta-thing", preview("beta"));
  pkg(root, "unfinished", preview("in-progress"));
  pkg(root, "runtime-only", preview("in-progress"));
  write(root, "package-lock.json", json({
    name: "polyth",
    lockfileVersion: 3,
    packages: {
      "": { name: "polyth", workspaces: ["packages/*", "!packages/runtime-only", "apps/*"] },
      "node_modules/@polyth/core": { resolved: "packages/core", link: true },
      "node_modules/@polyth/unfinished": { resolved: "packages/unfinished", link: true },
      "packages/core": { name: "@polyth/core", version: "0.1.0" },
      "packages/unfinished": { name: "@polyth/unfinished", version: "0.1.0" },
      "packages/unfinished/node_modules/left-pad": { version: "1.0.0" },
    },
  }));
  return root;
}

test("only in-progress packages leave master; beta previews stay", () => {
  const root = checkout();
  try {
    const plan = releasePlan(root);
    assert.deepEqual(plan.excluded.map((entry: { id: string }) => entry.id), ["runtime-only", "unfinished"]);
    assert.deepEqual(plan.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a kept package that needs a devel-only package blocks the promotion", () => {
  const root = checkout();
  try {
    pkg(root, "needs-it", { dependencies: { "@polyth/unfinished": "0.1.0" } });
    pkg(root, "peers-it", {
      peerDependencies: { "@polyth/unfinished": "0.1.0", "@polyth/runtime-only": "0.1.0" },
      peerDependenciesMeta: { "@polyth/runtime-only": { optional: true } },
    });
    const plan = releasePlan(root);
    assert.deepEqual(plan.problems, [
      "packages/needs-it depends on devel-only package @polyth/unfinished",
      "packages/peers-it depends on devel-only package @polyth/unfinished",
    ]);
    assert.throws(() => applyPlan(root, plan, { npmInstall: () => {}, generate: () => {} }), /Refusing to promote/);
    assert.ok(existsSync(join(root, "packages/unfinished")), "a refused plan removes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lockfile and workspace helpers drop exactly the removed folders", () => {
  const lock = { packages: { "": {}, "packages/a": {}, "packages/a/node_modules/x": {}, "packages/ab": {}, "node_modules/x": {} } };
  assert.equal(dropWorkspaceLockEntries(lock, ["packages/a"]), 2);
  assert.deepEqual(Object.keys(lock.packages), ["", "packages/ab", "node_modules/x"]);
  assert.deepEqual(dropWorkspaceNegations(["packages/*", "!packages/a", "!packages/ab"], ["packages/a"]), ["packages/*", "!packages/ab"]);
});

test("apply removes devel-only folders, prunes the lockfile and regenerates", () => {
  const root = checkout();
  try {
    const calls: string[] = [];
    applyPlan(root, releasePlan(root), {
      npmInstall: () => calls.push("npm"),
      generate: () => calls.push("generate"),
    });
    assert.deepEqual(calls, ["npm", "npm", "generate"]);
    assert.ok(!existsSync(join(root, "packages/unfinished")));
    assert.ok(!existsSync(join(root, "packages/runtime-only")));
    assert.ok(existsSync(join(root, "packages/beta-thing")));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.workspaces, ["packages/*", "apps/*"]);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.packages).filter((key) => key.startsWith("packages/")), ["packages/core"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply drops removed folders from the agent navigation maps only", () => {
  const root = checkout();
  try {
    write(root, "docs/agents/task-map.json", json({
      schemaVersion: 1,
      areas: [{
        id: "packages",
        match: ["packages/unfinished/**", "packages/*/package.json"],
        entrypoints: ["packages/unfinished/src/index.ts", "packages/core/src/index.ts"],
        references: ["docs/dev/README.md"],
        testHints: ["packages/unfinished/test", "packages/unfinished-two/test"],
      }],
    }));
    write(root, "docs/agents/evidence.json", json({
      schemaVersion: 1,
      sources: [{ path: "packages/unfinished/src/index.ts" }, { path: "packages/core/src/index.ts" }],
    }));
    applyPlan(root, releasePlan(root), { npmInstall: () => {}, generate: () => {} });
    const [area] = JSON.parse(readFileSync(join(root, "docs/agents/task-map.json"), "utf8")).areas;
    assert.deepEqual(area.match, ["packages/*/package.json"]);
    assert.deepEqual(area.entrypoints, ["packages/core/src/index.ts"]);
    assert.deepEqual(area.references, ["docs/dev/README.md"]);
    assert.deepEqual(area.testHints, ["packages/unfinished-two/test"]);
    const evidence = JSON.parse(readFileSync(join(root, "docs/agents/evidence.json"), "utf8"));
    assert.deepEqual(evidence.sources, [{ path: "packages/core/src/index.ts" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses a lockfile that npm keeps rewriting", () => {
  const root = checkout();
  try {
    let pass = 0;
    const npmInstall = (cwd: string) => {
      pass += 1;
      if (pass === 2) writeFileSync(join(cwd, "package-lock.json"), "{}\n");
    };
    assert.throws(() => applyPlan(root, releasePlan(root), { npmInstall, generate: () => {} }), /did not settle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function identity(): { name: string; email: string } {
  const read = (key: string): string => {
    try {
      return git(process.cwd(), "config", key);
    } catch {
      return "";
    }
  };
  return { name: read("user.name") || "Polyth Fixture", email: read("user.email") || "fixture@invalid" };
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "polyth-promote-git-"));
  git(root, "init", "-q", "-b", "devel");
  const { name, email } = identity();
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", email);
  git(root, "config", "commit.gpgsign", "false");
  write(root, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  write(root, "b.txt", "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "branch", "master");
  return root;
}

function commitOn(root: string, branch: string, path: string, contents: string, message = `edit ${path}`): string {
  git(root, "checkout", "-q", branch);
  write(root, path, contents);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

test("master drift: a master-only change blocks until devel carries it", () => {
  const root = repository();
  try {
    assert.deepEqual(masterDrift(root, "master", "devel").drift, []);
    commitOn(root, "master", "b.txt", "hotfix\n");
    assert.deepEqual(masterDrift(root, "master", "devel").drift, ["b.txt"]);
    commitOn(root, "devel", "b.txt", "hotfix\n");
    assert.deepEqual(masterDrift(root, "master", "devel").drift, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("master drift: devel carrying the change among its own edits is not drift", () => {
  const root = repository();
  try {
    // A forwarded release bump on devel while devel also changed the file elsewhere.
    commitOn(root, "devel", "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN-devel\n");
    commitOn(root, "master", "a.txt", "ONE-bump\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    assert.deepEqual(masterDrift(root, "master", "devel").drift, ["a.txt"]);
    commitOn(root, "devel", "a.txt", "ONE-bump\ntwo\nthree\nfour\nfive\nsix\nSEVEN-devel\n");
    assert.deepEqual(masterDrift(root, "master", "devel").drift, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("master drift counts only changes after the newest promotion", () => {
  const root = repository();
  try {
    const develSha = commitOn(root, "devel", "c.txt", "devel feature\n");
    commitOn(root, "master", "c.txt", "devel feature\n", `chore: promote devel\n\n${PROMOTED_FROM_TRAILER}: ${develSha}`);
    const promotion = git(root, "rev-parse", "master");
    assert.deepEqual(lastPromotion(root, "master"), { commit: promotion, devel: develSha });
    commitOn(root, "devel", "c.txt", "devel moved on\n");
    assert.deepEqual(masterDrift(root, "master", "devel"), { base: promotion, drift: [] });
    commitOn(root, "master", "b.txt", "direct master edit\n");
    assert.deepEqual(masterDrift(root, "master", "devel").drift, ["b.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
