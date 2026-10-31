#!/usr/bin/env node
/**
 * Deterministic aligned version bump for the release manifests.
 *
 * The five manifests checked by `scripts/release-version.mjs` must always carry
 * the same stable `X.Y.Z` version. This script computes the next version from a
 * fixed rule and applies it to those manifests plus the matching
 * `package-lock.json` entries, so a release never needs hand-edited numbers.
 *
 * Default (`--bump auto`) derives the increment from the Conventional Commits
 * since the last reachable stable tag:
 *
 *   - a breaking change (`type!:` or a `BREAKING CHANGE:` trailer) → major,
 *     except while major is 0, where semver has no stability promise and a
 *     breaking change bumps minor;
 *   - `feat` → minor;
 *   - anything else (`fix`, `perf`, `refactor`, `revert`, `docs`, `chore`, …)
 *     → patch.
 *
 * The base version is the higher of the aligned manifest version and the
 * highest stable tag ever published, so a bump can never move backwards even
 * when a tag is newer than the checked-in manifests.
 *
 * Usage:
 *   node scripts/bump-version.mjs [--bump auto|major|minor|patch|none]
 *                                 [--set X.Y.Z] [--dry-run] [--json]
 *                                 [--repo <dir>] [--since <ref>]
 *
 * Exports (when GITHUB_ENV / GITHUB_OUTPUT are set) the same way
 * `release-version.mjs` does: POLYTH_VERSION, POLYTH_PREVIOUS_VERSION,
 * POLYTH_BUMP_LEVEL, POLYTH_VERSION_CHANGED.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEnvFile,
  parseStableSemver,
  STABLE_SEMVER_RE,
} from "./release-version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** The aligned release manifests, also validated by `release-version.mjs`. */
export const MANIFEST_PATHS = [
  "package.json",
  "apps/mobile/package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/package-sdk/package.json",
];

export const LOCKFILE_PATH = "package-lock.json";

/** Explicit bump levels, ordered from least to most significant. */
export const BUMP_LEVELS = ["patch", "minor", "major"];

/** Bump modes accepted by `--bump` (a level, `auto`, or `none`). */
export const BUMP_MODES = [...BUMP_LEVELS, "auto", "none"];

/** Conventional Commit type that maps to a minor bump. */
const MINOR_TYPES = new Set(["feat"]);

/** Git record/field separators for a format string that survives multiline bodies. */
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

/**
 * A tag name that carries an aligned stable version.
 * @param {string} tag
 */
export function isStableTag(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const left = parseStableSemver(a);
  const right = parseStableSemver(b);
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

/**
 * @param {string} version
 * @param {"major"|"minor"|"patch"} level
 * @returns {string}
 */
export function nextVersion(version, level) {
  const { major, minor, patch } = parseStableSemver(version);
  if (!BUMP_LEVELS.includes(level)) {
    throw new Error(`Unknown bump level ${level}; expected ${BUMP_LEVELS.join(", ")}`);
  }

  const next = level === "major"
    ? `${major + 1}.0.0`
    : level === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

  // Reuses the release gate's supported domain, so a bump can never produce a
  // version the Android versionCode mapping would reject later.
  parseStableSemver(next);
  return next;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A parsed commit, as far as the bump rule needs it.
 * @typedef {{ subject: string, body: string, subjectBreaking: boolean, bodyBreaking: boolean }} CommitLike
 */

/**
 * Split a Conventional Commit subject into its type, scope and breaking marker.
 * @param {string} subject
 */
export function parseConventionalSubject(subject) {
  const trimmed = subject.trim();
  const match = /^([a-zA-Z]+)(?:\(([^()]*)\))?(!)?:\s*(.*)$/.exec(trimmed);
  if (!match) {
    return { type: "", scope: "", breaking: false, description: "" };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ?? "",
    breaking: match[3] === "!",
    description: match[4] ?? "",
  };
}

/**
 * True when a commit body declares a breaking change.
 * @param {string} body
 */
export function hasBreakingTrailer(body) {
  return /^\s*BREAKING[ -]CHANGE:/m.test(body);
}

/**
 * @param {CommitLike} commit
 */
export function isBreakingCommit(commit) {
  return commit.subjectBreaking || commit.bodyBreaking;
}

/**
 * Human-readable reason for the chosen level, used in logs.
 * @param {CommitLike[]} commits
 * @param {"major"|"minor"|"patch"} level
 */
export function summariseBump(commits, level) {
  if (commits.length === 0) {
    return level === "patch" ? "no commits since the base tag (patch)" : level;
  }

  const breaking = commits.find(isBreakingCommit);
  if (level === "major" && breaking) {
    return `breaking change: ${breaking.subject}`;
  }

  const feature = commits.find((commit) => {
    const parsed = parseConventionalSubject(commit.subject);
    return MINOR_TYPES.has(parsed.type) && !isBreakingCommit(commit);
  });
  if (level === "minor" && feature) {
    return `feature: ${feature.subject}`;
  }

  return `${commits.length} commit(s) since the base tag (${level})`;
}

/**
 * Deterministic increment for a set of commits.
 *
 * `major` is 0 until the first major release; semver gives 0.x no stability
 * promise, so a breaking change there bumps minor instead.
 * @param {CommitLike[]} commits
 * @param {{ major: number }} current
 * @returns {"major"|"minor"|"patch"}
 */
export function deriveBumpLevel(commits, current) {
  if (commits.some(isBreakingCommit)) {
    return current.major === 0 ? "minor" : "major";
  }
  const hasFeature = commits.some(
    (commit) => MINOR_TYPES.has(parseConventionalSubject(commit.subject).type),
  );
  return hasFeature ? "minor" : "patch";
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 */
function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Stable version tags, highest first. Includes unreachable tags, because a
 * published version must never be reused even if its tag is on another line.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listStableTags(repoRoot) {
  let output;
  try {
    output = git(repoRoot, ["tag", "--list", "v*"]);
  } catch {
    // Not a git checkout (or no git): no published tag can be a floor.
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => isStableTag(tag))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
}

/**
 * Highest stable tag that is an ancestor of HEAD — the base for the commit
 * range. Returns "" when no release tag is reachable.
 * @param {string} repoRoot
 * @returns {string}
 */
export function latestReachableStableTag(repoRoot) {
  let output;
  try {
    output = git(repoRoot, ["tag", "--merged", "HEAD", "--list", "v*"]);
  } catch {
    return "";
  }
  const tags = output
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => isStableTag(tag))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  return tags[0] ?? "";
}

/**
 * @param {string} repoRoot
 * @param {string} [since] Tag/exclusive range start; empty means all history.
 * @returns {CommitLike[]}
 */
export function readCommits(repoRoot, since = "") {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  // `git log` merges into one stream here; the bump rule only needs the set.
  const output = git(repoRoot, [
    "log",
    ...range,
    `--format=%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    "--no-merges",
  ]);

  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return {
        subject: subject.trim(),
        body,
        subjectBreaking: parseConventionalSubject(subject).breaking,
        bodyBreaking: hasBreakingTrailer(body),
      };
    });
}

/**
 * @param {string} path
 * @returns {string}
 */
export function readManifestVersion(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Missing version in ${path}`);
  }
  return parsed.version;
}

/**
 * The single aligned version carried by every release manifest.
 * @param {string} repoRoot
 * @returns {string}
 */
export function readAlignedVersion(repoRoot) {
  const versions = MANIFEST_PATHS.map((path) => ({
    path,
    version: readManifestVersion(join(repoRoot, path)),
  }));
  const unique = [...new Set(versions.map((entry) => entry.version))];
  if (unique.length !== 1) {
    throw new Error(
      `Aligned manifests disagree: ${versions.map((entry) => `${entry.path}=${entry.version}`).join(", ")}`,
    );
  }
  parseStableSemver(unique[0]);
  return unique[0];
}

/**
 * Replace only the top-level `version` value, preserving the file's own
 * formatting (some manifests are single-line).
 * @param {string} text
 * @param {string} current
 * @param {string} next
 * @returns {string}
 */
export function replaceManifestVersion(text, current, next) {
  const match = /"version"(\s*:\s*)"([^"]*)"/.exec(text);
  if (!match) {
    throw new Error('Manifest has no top-level "version" field');
  }
  if (match[2] !== current) {
    throw new Error(
      `Manifest version ${match[2]} does not match the aligned version ${current}`,
    );
  }

  const replacement = `"version"${match[1]}"${next}"`;
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

/**
 * Bump one manifest, asserting that the only semantic change is its version.
 * @param {string} repoRoot
 * @param {string} path
 * @param {string} current
 * @param {string} next
 * @param {{ write: boolean }} options
 */
function bumpManifest(repoRoot, path, current, next, options) {
  const absolute = join(repoRoot, path);
  const original = readFileSync(absolute, "utf8");
  const updated = replaceManifestVersion(original, current, next);

  const before = JSON.parse(original);
  const after = JSON.parse(updated);
  before.version = next;
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(`Refusing to bump ${path}: the edit changed more than the version`);
  }

  if (options.write) {
    writeFileSync(absolute, updated);
  }
  return path;
}

/**
 * Lockfile entries that mirror the aligned manifests. The other workspace
 * packages keep their own version and are deliberately left alone.
 * @param {string[]} manifestPaths
 * @returns {string[]}
 */
export function lockfileKeysFor(manifestPaths) {
  return manifestPaths.map((path) => {
    const directory = dirname(path);
    return directory === "." ? "" : directory.split("\\").join("/");
  });
}

/**
 * Bump the lockfile entries for the aligned manifests, keeping npm's own
 * formatting. Refuses to rewrite a lockfile whose JSON round-trip is not
 * byte-stable, so a bump never carries unrelated formatting churn.
 * @param {string} repoRoot
 * @param {string} current
 * @param {string} next
 * @param {{ write: boolean }} options
 */
function bumpLockfile(repoRoot, current, next, options) {
  const absolute = join(repoRoot, LOCKFILE_PATH);
  const original = readFileSync(absolute, "utf8");
  const lock = JSON.parse(original);

  const canonical = `${JSON.stringify(lock, null, 2)}\n`;
  if (canonical !== original) {
    throw new Error(
      `${LOCKFILE_PATH} is not in npm's canonical format; run "npm install --package-lock-only" first`,
    );
  }

  if (lock.version !== current) {
    throw new Error(
      `${LOCKFILE_PATH} version ${lock.version} does not match the aligned version ${current}`,
    );
  }

  // The root manifest maps to packages[""], which lockfileKeysFor also
  // produces for "package.json"; dedupe so each entry is validated once.
  const keys = [...new Set(["", ...lockfileKeysFor(MANIFEST_PATHS)])];

  // Validate every entry before mutating any, so a mismatch cannot leave the
  // lockfile object half-bumped.
  for (const key of keys) {
    const entry = lock.packages?.[key];
    if (!isRecord(entry)) {
      throw new Error(`${LOCKFILE_PATH} has no packages["${key}"] entry`);
    }
    if (entry.version !== current) {
      throw new Error(
        `${LOCKFILE_PATH} packages["${key}"] version ${String(entry.version)} does not match ${current}`,
      );
    }
  }

  for (const key of keys) {
    lock.packages[key].version = next;
  }
  lock.version = next;

  if (options.write) {
    writeFileSync(absolute, `${JSON.stringify(lock, null, 2)}\n`);
  }
  return keys;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Package names of the aligned manifests other than the private root. */
function alignedPackageNames(repoRoot) {
  return new Set(MANIFEST_PATHS.filter((path) => path !== "package.json")
    .map((path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8")).name));
}

/**
 * Rewrite exact `current` pins on aligned packages in one dependency map;
 * returns true when something changed.
 * @param {unknown} manifest
 * @param {Set<string>} names
 */
function bumpPins(manifest, names, current, next) {
  let changed = false;
  for (const field of DEPENDENCY_FIELDS) {
    const deps = isRecord(manifest) ? manifest[field] : undefined;
    if (!isRecord(deps)) continue;
    for (const name of names) {
      if (deps[name] === current) {
        deps[name] = next;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Workspaces pin aligned packages exactly ("@polyth/contracts": "0.1.0");
 * a pin left on the old version makes npm look the package up in the public
 * registry and `npm ci` fails. Rewrite those pins in every workspace manifest
 * and its lockfile entry, preserving each file's formatting.
 * @param {string} repoRoot
 * @param {string} current
 * @param {string} next
 * @param {{ write: boolean }} options
 * @returns {string[]} manifests that changed
 */
export function bumpDependentPins(repoRoot, current, next, options) {
  const names = alignedPackageNames(repoRoot);
  const lockPath = join(repoRoot, LOCKFILE_PATH);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // Lockfile workspaces plus packages/* and apps/* folders the root
  // `workspaces` list excludes (they still pin aligned packages).
  const workspaceKeys = [...new Set([
    ...Object.keys(lock.packages ?? {})
      .filter((key) => key !== "" && !key.split("/").includes("node_modules")),
    ...["packages", "apps"].flatMap((dir) => {
      try {
        return readdirSync(join(repoRoot, dir)).map((name) => `${dir}/${name}`);
      } catch {
        return [];
      }
    }),
  ])];
  const changed = [];
  for (const key of workspaceKeys) {
    if (lock.packages?.[key]) bumpPins(lock.packages[key], names, current, next);
    const path = `${key}/package.json`;
    const absolute = join(repoRoot, path);
    let original;
    try {
      original = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const expected = JSON.parse(original);
    if (!bumpPins(expected, names, current, next)) continue;
    let updated = original;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      updated = updated.replace(new RegExp(`("${escaped}"\\s*:\\s*)"${current.replace(/\./g, "\\.")}"`, "g"), `$1"${next}"`);
    }
    if (!isDeepStrictEqual(JSON.parse(updated), expected)) {
      throw new Error(`Refusing to bump ${path}: the pin edit changed more than the aligned dependency versions`);
    }
    if (options.write) writeFileSync(absolute, updated);
    changed.push(path);
  }
  if (options.write) writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return changed;
}

/**
 * Compute the next aligned version.
 *
 * @param {{
 *   repoRoot?: string,
 *   level?: "auto"|"major"|"minor"|"patch",
 *   set?: string,
 *   since?: string,
 * }} options
 */
export function computeBump(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const current = readAlignedVersion(repoRoot);
  const currentParts = parseStableSemver(current);

  if (options.set) {
    const next = options.set.replace(/^v/, "").trim();
    parseStableSemver(next);
    if (compareVersions(next, current) <= 0) {
      throw new Error(`Refusing to set version ${next}: it is not newer than ${current}`);
    }
    return {
      current,
      next,
      level: "",
      mode: "set",
      base: current,
      baseTag: "",
      commits: [],
      reason: `explicit version ${next}`,
    };
  }

  // A published tag is a floor: even when the checked-in manifests lag behind,
  // the next version must exceed every tag that already exists.
  const publishedTag = listStableTags(repoRoot)[0] ?? "";
  const published = publishedTag ? publishedTag.slice(1) : "";
  const base = published && compareVersions(published, current) > 0 ? published : current;

  const mode = options.level ?? "auto";
  if (!BUMP_MODES.includes(mode)) {
    throw new Error(`Unknown --bump mode ${mode}; expected ${BUMP_MODES.join(", ")}`);
  }
  if (mode === "none") {
    return {
      current,
      next: current,
      level: "",
      mode,
      base,
      baseTag: "",
      commits: [],
      reason: "bump disabled",
    };
  }

  const baseTag = options.since !== undefined
    ? options.since
    : latestReachableStableTag(repoRoot);

  // Only `auto` needs history to decide, so an explicit level or `none` works
  // in a checkout without git instead of failing on an unused lookup.
  const commits = mode === "auto" ? readCommits(repoRoot, baseTag) : [];

  // A retry of an already-tagged release has nothing new to version. Reusing the
  // current version keeps a failed release from consuming a version number; the
  // draft-release step then reuses the tag it already points at. Only applies
  // when the manifests are already at the published version, so a lagging
  // manifest set still moves forward instead of backwards.
  if (mode === "auto" && baseTag && commits.length === 0 && base === current) {
    return {
      current,
      next: current,
      level: "",
      mode,
      base,
      baseTag,
      commits,
      reason: `nothing new since ${baseTag}`,
    };
  }

  const level = mode === "auto" ? deriveBumpLevel(commits, currentParts) : mode;
  const next = nextVersion(base, level);

  return {
    current,
    next,
    level,
    mode,
    base,
    baseTag,
    commits,
    reason: mode === "auto" ? summariseBump(commits, level) : `explicit ${level} bump`,
  };
}

/**
 * Apply an already computed bump to every manifest and the lockfile.
 * @param {{ next: string, current: string }} result
 * @param {{ repoRoot?: string, write?: boolean }} [options]
 */
export function applyBump(result, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const write = options.write ?? true;
  const { current, next } = result;

  if (current === next) {
    return { changed: false, files: [], lockfileKeys: [] };
  }

  const files = MANIFEST_PATHS.map((path) =>
    bumpManifest(repoRoot, path, current, next, { write }),
  );
  const lockfileKeys = bumpLockfile(repoRoot, current, next, { write });
  // Runs after bumpLockfile, so it reads the already-bumped lockfile when writing.
  files.push(...bumpDependentPins(repoRoot, current, next, { write }));

  return { changed: true, files, lockfileKeys };
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    level: undefined,
    set: undefined,
    dryRun: false,
    json: false,
    repoRoot: REPO_ROOT,
    since: undefined,
    help: false,
  };
  const pending = [...argv];

  while (pending.length > 0) {
    const arg = pending.shift();
    const [name, inlineValue] = arg.split("=", 2);
    const value = () => {
      const resolved = inlineValue ?? pending.shift();
      if (resolved === undefined) {
        throw new Error(`${name} requires a value`);
      }
      return resolved;
    };

    switch (name) {
      case "--bump":
      case "--level":
        options.level = value();
        break;
      case "--set":
        options.set = value();
        break;
      case "--repo":
        options.repoRoot = value();
        break;
      case "--since":
        options.since = value();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (options.level !== undefined && options.set !== undefined) {
    throw new Error("--bump and --set are mutually exclusive");
  }
  if (options.set !== undefined && !STABLE_SEMVER_RE.test(options.set.replace(/^v/, ""))) {
    throw new Error(`--set expects a stable X.Y.Z version; received ${options.set}`);
  }

  return options;
}

const USAGE = `Usage: node scripts/bump-version.mjs [options]

  --bump <auto|major|minor|patch|none>  Increment rule (default: auto).
  --set <X.Y.Z>                         Set an exact version instead of bumping.
  --dry-run                             Print the result without writing files.
  --json                                Print machine-readable output.
  --repo <dir>                          Repository root (default: this checkout).
  --since <ref>                         Commit range base (default: last stable tag).
  -h, --help                            Show this message.
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const result = computeBump({
    repoRoot: options.repoRoot,
    level: options.level ?? "auto",
    set: options.set,
    since: options.since,
  });
  const applied = applyBump(result, {
    repoRoot: options.repoRoot,
    write: !options.dryRun,
  });

  const payload = {
    previous: result.current,
    version: result.next,
    level: result.level,
    mode: result.mode,
    base: result.base,
    baseTag: result.baseTag,
    reason: result.reason,
    changed: applied.changed,
    files: applied.files,
    dryRun: options.dryRun,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const from = applied.changed ? `${result.current} -> ${result.next}` : result.next;
    process.stdout.write(
      `bump-version: ${from}${result.level ? ` (${result.level}: ${result.reason})` : ""}`
        + `${options.dryRun ? " [dry-run]" : ""}\n`,
    );
  }

  appendEnvFile(process.env.GITHUB_ENV, {
    POLYTH_VERSION: result.next,
    POLYTH_PREVIOUS_VERSION: result.current,
    POLYTH_BUMP_LEVEL: result.level,
    POLYTH_VERSION_CHANGED: String(applied.changed),
  });
  appendEnvFile(process.env.GITHUB_OUTPUT, {
    version: result.next,
    previous: result.current,
    level: result.level,
    changed: String(applied.changed),
    // Exact manifests rewritten by this bump (aligned manifests plus workspace
    // pins), so the release commit can add them without sweeping unrelated edits.
    files: applied.files.join(" "),
  });
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`bump-version: ${message}`);
    process.exit(1);
  }
}
