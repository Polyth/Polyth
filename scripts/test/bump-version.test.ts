import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MANIFEST_PATHS,
  applyBump,
  compareVersions,
  computeBump,
  deriveBumpLevel,
  hasBreakingTrailer,
  isStableTag,
  latestReachableStableTag,
  listStableTags,
  lockfileKeysFor,
  nextVersion,
  parseArgs,
  parseConventionalSubject,
  readCommits,
  replaceManifestVersion,
  summariseBump,
} from "../bump-version.mjs";

/**
 * @param {string} subject
 * @param {string} [body]
 */
function commit(subject, body = "") {
  return {
    subject,
    body,
    subjectBreaking: parseConventionalSubject(subject).breaking,
    bodyBreaking: hasBreakingTrailer(body),
  };
}

/** Run git in a fixture repository, failing loudly on error. */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Identity for fixture repositories. Prefers the repository's own configured
 * identity; a CI checkout has none, so fixtures fall back to an explicit
 * throwaway one. These commits never touch the project repository.
 */
function configuredIdentity() {
  const read = (key) => {
    try {
      return git(process.cwd(), "config", key).trim();
    } catch {
      return "";
    }
  };
  return {
    name: read("user.name") || "Polyth Fixture",
    email: read("user.email") || "fixture@invalid",
  };
}

/**
 * A throwaway checkout with the five aligned manifests and a lockfile,
 * optionally initialised as a git repository.
 * @param {{ version?: string, git?: boolean }} [options]
 */
function createCheckout(options = {}) {
  const version = options.version ?? "0.1.0";
  const root = mkdtempSync(join(tmpdir(), "polyth-bump-"));

  for (const path of MANIFEST_PATHS) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    const name = path === "package.json" ? "polyth" : `@polyth/${path.split("/").at(-2)}`;
    writeFileSync(absolute, `${JSON.stringify({ name, version }, null, 2)}\n`);
  }

  // Mirrors the real single-line formatting of packages/contracts/package.json.
  writeFileSync(
    join(root, "packages/contracts/package.json"),
    `{"name":"@polyth/contracts","version":"${version}","license":"Apache-2.0","type":"module","exports":{".":"./src/public.ts"}}\n`,
  );

  const packages = { "": { name: "polyth", version } };
  for (const path of MANIFEST_PATHS) {
    const key = path === "package.json" ? "" : path.replace("/package.json", "");
    packages[key] = { name: `@polyth/${key}`, version };
  }
  // An unrelated internal workspace keeps its own version and must stay untouched.
  // It pins an aligned package exactly, as the real workspaces do.
  packages["packages/backend-cli"] = {
    name: "@polyth/backend-cli",
    version: "0.1.0",
    dependencies: { "@polyth/contracts": version, "@polyth/other": version },
  };
  mkdirSync(join(root, "packages/backend-cli"), { recursive: true });
  writeFileSync(
    join(root, "packages/backend-cli/package.json"),
    `${JSON.stringify({ name: "@polyth/backend-cli", version: "0.1.0", dependencies: packages["packages/backend-cli"].dependencies }, null, 2)}\n`,
  );
  // Excluded from the root workspaces, so it has no lockfile entry.
  mkdirSync(join(root, "packages/excluded-tool"), { recursive: true });
  writeFileSync(
    join(root, "packages/excluded-tool/package.json"),
    `{"name":"@polyth/excluded-tool","devDependencies":{"@polyth/package-sdk":"${version}"}}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: "polyth", version, lockfileVersion: 3, packages }, null, 2)}\n`,
  );

  if (options.git) {
    const identity = configuredIdentity();
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.name", identity.name);
    git(root, "config", "user.email", identity.email);
    git(root, "config", "commit.gpgsign", "false");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "--message", "chore: initial fixture");
  }

  return root;
}

/**
 * @param {string} cwd
 * @param {string} subject
 */
function commitFixture(cwd, subject) {
  // A unique path per commit keeps independent branches mergeable.
  const slug = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(cwd, `marker-${slug}.txt`), `${subject}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--message", subject);
}

test("nextVersion maps each level", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(nextVersion("1.9.9", "patch"), "1.9.10");
  assert.equal(nextVersion("1.9.9", "minor"), "1.10.0");
});

test("nextVersion rejects unknown levels and out-of-domain results", () => {
  assert.throws(() => nextVersion("1.0.0", "huge"), /Unknown bump level/);
  // The release gate maps minor/patch into an Android versionCode, so a bump
  // that would leave the supported domain must fail here, not at release time.
  assert.throws(() => nextVersion("1.999.999", "patch"), /minor and patch <= 999/);
  assert.throws(() => nextVersion("1.999.999", "minor"), /minor and patch <= 999/);
});

test("compareVersions orders numerically, not lexically", () => {
  assert.ok(compareVersions("0.1.9", "0.1.10") < 0);
  assert.ok(compareVersions("0.2.0", "0.1.99") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("isStableTag accepts only aligned stable tags", () => {
  assert.ok(isStableTag("v1.2.3"));
  assert.ok(!isStableTag("1.2.3"));
  assert.ok(!isStableTag("v1.2.3-beta"));
  assert.ok(!isStableTag("v1.2"));
});

test("parseConventionalSubject extracts type, scope and breaking marker", () => {
  assert.deepEqual(parseConventionalSubject("feat(web): add thing"), {
    type: "feat",
    scope: "web",
    breaking: false,
    description: "add thing",
  });
  assert.equal(parseConventionalSubject("fix!: drop legacy").breaking, true);
  assert.equal(parseConventionalSubject("FEAT: shout").type, "feat");
  assert.equal(parseConventionalSubject("Fix the thing").type, "");
});

test("hasBreakingTrailer recognises both conventional spellings", () => {
  assert.ok(hasBreakingTrailer("some body\n\nBREAKING CHANGE: removed flag"));
  assert.ok(hasBreakingTrailer("BREAKING-CHANGE: removed flag"));
  assert.ok(!hasBreakingTrailer("a body mentioning breaking change without the colon"));
});

test("deriveBumpLevel maps conventional commits deterministically", () => {
  const zero = { major: 0 };
  const one = { major: 1 };

  assert.equal(deriveBumpLevel([commit("fix: patch it")], zero), "patch");
  assert.equal(deriveBumpLevel([commit("chore: tidy")], zero), "patch");
  assert.equal(deriveBumpLevel([], zero), "patch");
  assert.equal(deriveBumpLevel([commit("feat: add it")], zero), "minor");
  assert.equal(
    deriveBumpLevel([commit("fix: a"), commit("feat: b"), commit("docs: c")], zero),
    "minor",
  );

  // 0.x has no stability promise, so a breaking change only bumps minor.
  assert.equal(deriveBumpLevel([commit("feat!: break it")], zero), "minor");
  assert.equal(deriveBumpLevel([commit("feat!: break it")], one), "major");
  assert.equal(
    deriveBumpLevel([commit("fix: tidy", "BREAKING CHANGE: gone")], one),
    "major",
  );
  // A breaking change outranks a feature.
  assert.equal(deriveBumpLevel([commit("feat: a"), commit("fix!: b")], one), "major");
});

test("summariseBump names the commit that decided the level", () => {
  assert.match(summariseBump([commit("feat: add it")], "minor"), /feature: feat: add it/);
  assert.match(
    summariseBump([commit("fix!: break")], "major"),
    /breaking change: fix!: break/,
  );
  assert.match(summariseBump([commit("fix: a")], "patch"), /1 commit\(s\)/);
});

test("replaceManifestVersion preserves the manifest's own formatting", () => {
  const pretty = '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n';
  assert.equal(
    replaceManifestVersion(pretty, "0.1.0", "0.2.0"),
    '{\n  "name": "x",\n  "version": "0.2.0",\n  "private": true\n}\n',
  );

  const single = '{"name":"x","version":"0.1.0","type":"module"}\n';
  assert.equal(
    replaceManifestVersion(single, "0.1.0", "0.2.0"),
    '{"name":"x","version":"0.2.0","type":"module"}\n',
  );
});

test("replaceManifestVersion refuses a stale or missing version", () => {
  assert.throws(
    () => replaceManifestVersion('{"version": "0.9.0"}', "0.1.0", "0.2.0"),
    /does not match the aligned version/,
  );
  assert.throws(
    () => replaceManifestVersion('{"name": "x"}', "0.1.0", "0.2.0"),
    /no top-level "version" field/,
  );
});

test("lockfileKeysFor dedupes the root manifest into packages[\"\"]", () => {
  const keys = lockfileKeysFor(MANIFEST_PATHS);
  // "package.json" maps to "", which is the root workspace entry.
  assert.equal(keys.filter((key) => key === "").length, 1);
  assert.deepEqual(new Set(keys), new Set(["", "apps/mobile", "apps/desktop", "packages/contracts", "packages/package-sdk"]));
});

test("applyBump updates every aligned manifest and the matching lockfile entries", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    const result = {
      current: "0.1.0",
      next: "0.2.0",
    };
    const applied = applyBump(result, { repoRoot: root, write: true });

    assert.ok(applied.changed);
    for (const path of MANIFEST_PATHS) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
      assert.equal(manifest.version, "0.2.0", `${path} must be bumped`);
      assert.equal(manifest.name.length > 0, true, `${path} must keep its other fields`);
    }

    // The single-line contracts manifest stays single-line.
    assert.match(
      readFileSync(join(root, "packages/contracts/package.json"), "utf8"),
      /^\{"name":"@polyth\/contracts","version":"0\.2\.0"/,
    );

    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.2.0");
    assert.equal(lock.packages[""].version, "0.2.0");
    assert.equal(lock.packages["apps/desktop"].version, "0.2.0");
    assert.equal(lock.packages["packages/package-sdk"].version, "0.2.0");
    // An unrelated internal workspace is not part of the aligned contract.
    assert.equal(lock.packages["packages/backend-cli"].version, "0.1.0");
    // ...but its exact pins on aligned packages follow the bump, or npm ci
    // would look the old version up in the public registry.
    assert.deepEqual(lock.packages["packages/backend-cli"].dependencies, {
      "@polyth/contracts": "0.2.0",
      "@polyth/other": "0.1.0",
    });
    const cli = JSON.parse(readFileSync(join(root, "packages/backend-cli/package.json"), "utf8"));
    assert.equal(cli.version, "0.1.0");
    assert.deepEqual(cli.dependencies, { "@polyth/contracts": "0.2.0", "@polyth/other": "0.1.0" });
    assert.equal(
      readFileSync(join(root, "packages/excluded-tool/package.json"), "utf8"),
      '{"name":"@polyth/excluded-tool","devDependencies":{"@polyth/package-sdk":"0.2.0"}}\n',
    );

    // The lockfile stays in npm's canonical format.
    assert.equal(
      readFileSync(join(root, "package-lock.json"), "utf8"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyBump writes nothing in dry-run mode", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    const before = readFileSync(join(root, "package.json"), "utf8");
    const applied = applyBump(
      { current: "0.1.0", next: "0.3.0" },
      { repoRoot: root, write: false },
    );
    assert.ok(applied.changed);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyBump refuses when the aligned manifests already disagree", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    writeFileSync(join(root, "apps/desktop/package.json"), '{"name":"d","version":"0.2.0"}\n');
    assert.throws(
      () => computeBump({ repoRoot: root, level: "patch" }),
      /Aligned manifests disagree/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyBump refuses a lockfile that disagrees with the manifests", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = "0.9.9";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    assert.throws(
      () => applyBump({ current: "0.1.0", next: "0.2.0" }, { repoRoot: root, write: true }),
      /does not match the aligned version/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyBump refuses a lockfile that npm would reformat", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify(lock));

    assert.throws(
      () => applyBump({ current: "0.1.0", next: "0.2.0" }, { repoRoot: root, write: true }),
      /not in npm's canonical format/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump refuses a downgrade or reuse of the current version", () => {
  const root = createCheckout({ version: "0.5.0" });
  try {
    assert.throws(() => computeBump({ repoRoot: root, set: "0.4.0" }), /not newer than/);
    assert.throws(() => computeBump({ repoRoot: root, set: "0.5.0" }), /not newer than/);
    assert.equal(computeBump({ repoRoot: root, set: "0.6.0" }).next, "0.6.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump derives the level from commits since the reachable stable tag", () => {
  const root = createCheckout({ version: "0.1.0", git: true });
  try {
    git(root, "tag", "v0.1.0");
    commitFixture(root, "chore: tidy up");

    const patch = computeBump({ repoRoot: root });
    assert.equal(patch.level, "patch");
    assert.equal(patch.next, "0.1.1");
    assert.equal(patch.baseTag, "v0.1.0");
    assert.equal(patch.commits.length, 1);
    assert.match(patch.reason, /1 commit\(s\)/);

    commitFixture(root, "feat(web): add a panel");
    const minor = computeBump({ repoRoot: root });
    assert.equal(minor.level, "minor");
    assert.equal(minor.next, "0.2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump never reuses a version that is already tagged", () => {
  const root = createCheckout({ version: "0.1.0", git: true });
  try {
    // The manifests lag behind the newest published tag.
    git(root, "tag", "v0.1.7");
    commitFixture(root, "fix: a small fix");

    const result = computeBump({ repoRoot: root });
    assert.equal(result.base, "0.1.7");
    assert.equal(result.next, "0.1.8");
    assert.ok(compareVersions(result.next, "0.1.7") > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump ignores an unreachable tag as a commit range base", () => {
  const root = createCheckout({ version: "0.1.0", git: true });
  try {
    const base = git(root, "rev-parse", "HEAD").trim();
    git(root, "tag", "v0.1.0");
    git(root, "checkout", "--quiet", "--detach", base);
    commitFixture(root, "feat: develop a feature");
    git(root, "checkout", "--quiet", "--detach", base);
    // Create a tag on a divergent line so it is visible but not reachable.
    writeFileSync(join(root, "side.txt"), "side\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "--message", "chore: side line");
    git(root, "tag", "v0.9.0");
    git(root, "checkout", "--quiet", base);

    // v0.9.0 is a floor for monotonicity even though it is unreachable...
    assert.equal(listStableTags(root)[0], "v0.9.0");
    // ...but it cannot be used as a commit range base for HEAD.
    assert.equal(latestReachableStableTag(root), "v0.1.0");
    assert.equal(computeBump({ repoRoot: root, since: "v0.1.0" }).base, "0.9.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retry of an already-tagged release reuses the version instead of burning one", () => {
  // Simulates a release whose bump commit had already been pushed and tagged
  // when a later job failed: manifests, tag and HEAD all agree.
  const root = createCheckout({ version: "0.2.0", git: true });
  try {
    git(root, "tag", "v0.2.0");

    const result = computeBump({ repoRoot: root });
    assert.equal(result.next, "0.2.0", "a retry must not consume a version");
    assert.equal(result.level, "");
    assert.match(result.reason, /nothing new since v0\.2\.0/);
    assert.equal(applyBump(result, { repoRoot: root, write: true }).changed, false);

    // A new commit after the tag must still bump normally.
    commitFixture(root, "fix: a follow-up fix");
    assert.equal(computeBump({ repoRoot: root }).next, "0.2.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lagging manifest still moves forward when nothing is new since the tag", () => {
  const root = createCheckout({ version: "0.1.0", git: true });
  try {
    // The tag is newer than the checked-in manifests and sits at HEAD.
    git(root, "tag", "v0.9.9");
    const result = computeBump({ repoRoot: root });
    assert.ok(
      compareVersions(result.next, "0.9.9") > 0,
      `expected a version above 0.9.9, got ${result.next}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump with an explicit level ignores the commit rule", () => {
  const root = createCheckout({ version: "1.0.0", git: true });
  try {
    git(root, "tag", "v1.0.0");
    commitFixture(root, "docs: only documentation");
    assert.equal(computeBump({ repoRoot: root, level: "major" }).next, "2.0.0");
    assert.equal(computeBump({ repoRoot: root, level: "minor" }).next, "1.1.0");
    assert.equal(computeBump({ repoRoot: root, level: "patch" }).next, "1.0.1");
    assert.equal(computeBump({ repoRoot: root, level: "patch" }).level, "patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit level and `none` work without a git checkout", () => {
  const root = createCheckout({ version: "2.3.4" });
  try {
    assert.equal(computeBump({ repoRoot: root, level: "patch" }).next, "2.3.5");
    assert.equal(computeBump({ repoRoot: root, level: "major" }).next, "3.0.0");
    assert.equal(computeBump({ repoRoot: root, level: "none" }).next, "2.3.4");
    // `auto` genuinely needs history, and must say so rather than guess.
    assert.throws(() => computeBump({ repoRoot: root }), /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump supports disabling the bump", () => {
  const root = createCheckout({ version: "0.1.0" });
  try {
    const result = computeBump({ repoRoot: root, level: "none" });
    assert.equal(result.next, "0.1.0");
    assert.equal(result.level, "");
    assert.equal(applyBump(result, { repoRoot: root, write: true }).changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeBump raises a breaking change to minor while major is 0", () => {
  const root = createCheckout({ version: "0.3.0", git: true });
  try {
    git(root, "tag", "v0.3.0");
    commitFixture(root, "feat!: rework the public API");
    const result = computeBump({ repoRoot: root });
    assert.equal(result.level, "minor");
    assert.equal(result.next, "0.4.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCommits skips merge commits and keeps subjects", () => {
  const root = createCheckout({ version: "0.1.0", git: true });
  try {
    commitFixture(root, "feat: a feature");
    git(root, "checkout", "--quiet", "-b", "side");
    commitFixture(root, "fix: side fix");
    git(root, "checkout", "--quiet", "main");
    commitFixture(root, "docs: main doc");
    git(root, "merge", "--quiet", "--no-edit", "side");

    const subjects = readCommits(root).map((entry) => entry.subject);
    assert.ok(subjects.includes("feat: a feature"));
    assert.ok(subjects.includes("fix: side fix"));
    assert.ok(!subjects.some((subject) => subject.startsWith("Merge")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseArgs rejects conflicting and unknown input", () => {
  assert.throws(() => parseArgs(["--bump", "patch", "--set", "1.0.0"]), /mutually exclusive/);
  assert.throws(() => parseArgs(["--set", "nope"]), /stable X.Y.Z/);
  assert.throws(() => parseArgs(["--bump"]), /requires a value/);
  assert.throws(() => parseArgs(["--frobnicate"]), /Unknown argument/);

  assert.equal(parseArgs(["--bump=minor"]).level, "minor");
  assert.equal(parseArgs(["--dry-run", "--json"]).dryRun, true);
  assert.equal(parseArgs(["--since", "v1.0.0"]).since, "v1.0.0");
});
