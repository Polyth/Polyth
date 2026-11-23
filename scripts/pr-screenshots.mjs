#!/usr/bin/env node
// Attach the screenshots of a visible change to its pull request.
//
// Screenshots live under the checkout's `.scratch/` (gitignored, never
// committed; docs/agents/verification.md). This script publishes them to the
// orphan `pr-assets` branch of the pull request's remote — built with a private
// index, so the working tree, the index and the current branch are untouched —
// and writes a "Screenshots" section into the pull request body (before/after
// pairs side by side). Running it again replaces that section, so it is safe to
// rerun after new captures.
//
//   node scripts/pr-screenshots.mjs                 # current branch's PR
//   node scripts/pr-screenshots.mjs --pr 123        # a given PR
//   node scripts/pr-screenshots.mjs --print         # publish, print the section
//   node scripts/pr-screenshots.mjs --dry-run       # list what would be published
//   node scripts/pr-screenshots.mjs --dir .scratch/<task-slug>
//   node scripts/pr-screenshots.mjs a.png b.png     # exactly these files
//   node scripts/pr-screenshots.mjs adopt <child-worktree>
//       copy a delegated child's `.scratch` screenshots into this checkout
//       (`.scratch/from-<child>/`) before its isolated workspace is merged and
//       removed, so the parent's pull request carries them too.
//
// The repository is public: only publish images that show synthetic fixture or
// isolated test data — never a live instance's people, chats, projects, hosts
// or paths. Look at every listed file before publishing.
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const ASSETS_BRANCH = "pr-assets";
export const SECTION_START = "<!-- polyth:screenshots -->";
export const SECTION_END = "<!-- /polyth:screenshots -->";
export const MAX_FILES = 24;
export const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Image format from the file's magic bytes, or null when it is not an image we publish. */
export function imageKind(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Image files under `dir`, relative to it, sorted; symlinks are never followed. */
export function collectImages(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && IMAGE_EXT.test(entry.name)) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** A path segment safe in a URL and a git tree: letters, digits, `.`, `_`, `-`. */
export const safeSegment = (value) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "x";

/** Where an image lives on the assets branch: one folder per head branch, content-addressed names. */
export const assetPath = (branch, blobSha, name) => `${safeSegment(branch)}/${blobSha.slice(0, 12)}-${safeSegment(basename(name))}`;

/** `owner/repo` of a GitHub remote URL, or null. */
export function githubSlug(remoteUrl) {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Link GitHub renders for an image committed at `commit` (works in private repositories for viewers with access). */
export const imageUrl = (slug, commit, path) => `https://github.com/${slug}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;

const PAIR_TOKEN = /(^|[-_.])(before|after)(?=[-_.]|$)/i;

/**
 * Before/after pairs and the remaining single images. `before-phone.png` pairs
 * with `after-phone.png` (also `phone-before.png` / `phone.after.png`) in the
 * same folder.
 */
export function pairImages(names) {
  const groups = new Map();
  const singles = [];
  for (const name of names) {
    const file = basename(name);
    const match = PAIR_TOKEN.exec(file);
    if (!match) {
      singles.push(name);
      continue;
    }
    const key = `${dirname(name)}\0${file.replace(PAIR_TOKEN, "").replace(/^[-_.]+/, "").toLowerCase()}`;
    const group = groups.get(key) ?? {};
    const side = match[2].toLowerCase();
    if (group[side]) singles.push(name);
    else group[side] = name;
    groups.set(key, group);
  }
  const pairs = [];
  for (const group of groups.values()) {
    if (group.before && group.after) pairs.push({ before: group.before, after: group.after });
    else singles.push(group.before ?? group.after);
  }
  return { pairs, singles: singles.sort() };
}

const altText = (name) => name.replace(/[[\]|]/g, " ");

/** The Markdown section for the pull request body. `urlOf(name)` gives each image's link. */
export function screenshotSection(names, urlOf, note = "") {
  const { pairs, singles } = pairImages(names);
  const lines = [SECTION_START, "## Screenshots", ""];
  if (note) lines.push(note, "");
  if (pairs.length) {
    lines.push("| Before | After |", "| --- | --- |");
    for (const pair of pairs) {
      lines.push(`| ![${altText(pair.before)}](${urlOf(pair.before)}) | ![${altText(pair.after)}](${urlOf(pair.after)}) |`);
    }
    lines.push("");
  }
  for (const name of singles) lines.push(`**${altText(name)}**`, "", `![${altText(name)}](${urlOf(name)})`, "");
  lines.push(SECTION_END);
  return lines.join("\n");
}

/** `body` with its screenshot section replaced, or the section appended. */
export function upsertSection(body, section) {
  const text = body ?? "";
  const start = text.indexOf(SECTION_START);
  const end = start === -1 ? -1 : text.indexOf(SECTION_END, start);
  if (start !== -1 && end !== -1) return `${text.slice(0, start)}${section}${text.slice(end + SECTION_END.length)}`;
  return `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${section}\n`;
}

// ---- git / gh ---------------------------------------------------------------

const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
  maxBuffer: 64 * 1024 * 1024,
  ...options,
}).trim();

const tryRun = (cmd, args, options) => {
  try {
    return run(cmd, args, options);
  } catch {
    return null;
  }
};

/** Commit the images onto `pr-assets` and push it; retries when another agent pushed first. */
export function publish({ cwd, remote, branch, files, attempts = 5 }) {
  const remoteRef = `refs/heads/${ASSETS_BRANCH}`;
  const localRef = `refs/polyth/${ASSETS_BRANCH}`;
  let lastError = "no attempt made";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const listed = run("git", ["ls-remote", "--heads", remote, ASSETS_BRANCH], { cwd });
    let parent = null;
    if (listed) {
      run("git", ["fetch", "--quiet", "--no-tags", remote, `+${remoteRef}:${localRef}`], { cwd });
      parent = run("git", ["rev-parse", `${localRef}^{commit}`], { cwd });
    }
    const temp = mkdtempSync(join(tmpdir(), "polyth-pr-assets-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    try {
      if (parent) run("git", ["read-tree", parent], { cwd, env });
      const paths = new Map();
      for (const file of files) {
        const blob = run("git", ["hash-object", "-w", "--", file.absolute], { cwd });
        const path = assetPath(branch, blob, file.name);
        run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { cwd, env });
        paths.set(file.name, path);
      }
      const tree = run("git", ["write-tree"], { cwd, env });
      if (parent && tree === run("git", ["rev-parse", `${parent}^{tree}`], { cwd })) return { commit: parent, paths };
      const commit = run("git", [
        "-c", "commit.gpgsign=false",
        "commit-tree", tree, ...(parent ? ["-p", parent] : []),
        "-m", `[Chore] Pull request screenshots for ${safeSegment(branch)}`,
      ], { cwd });
      try {
        run("git", ["push", "--quiet", "--no-verify", remote, `${commit}:${remoteRef}`], { cwd });
        return { commit, paths };
      } catch (error) {
        // Another agent moved the branch first: rebuild on its new tip.
        lastError = error?.stderr?.toString().trim() || error?.message || String(error);
        if (!/non-fast-forward|fetch first|rejected|stale info/i.test(lastError)) break;
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  throw new Error(`could not push ${ASSETS_BRANCH} to ${remote}: ${lastError}`);
}

function parseArgs(argv) {
  const options = { files: [], pr: null, dir: null, remote: null, print: false, dryRun: false, command: "attach" };
  const args = [...argv];
  if (args[0] === "adopt") {
    options.command = "adopt";
    args.shift();
  }
  while (args.length) {
    const arg = args.shift();
    if (arg === "--pr") options.pr = args.shift() ?? null;
    else if (arg === "--dir") options.dir = args.shift() ?? null;
    else if (arg === "--remote") options.remote = args.shift() ?? null;
    else if (arg === "--print") options.print = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") options.command = "help";
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

const fail = (message) => {
  console.error(`pr-screenshots: ${message}`);
  process.exit(1);
};

function adopt(root, source) {
  if (!source) fail("adopt needs the child's worktree path");
  const from = resolve(source, ".scratch");
  const names = collectImages(from);
  if (!names.length) {
    console.log(`No screenshots under ${relative(root, from) || from}.`);
    return;
  }
  const target = join(root, ".scratch", `from-${safeSegment(basename(resolve(source)))}`);
  for (const name of names) {
    const destination = join(target, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(from, name), destination);
  }
  console.log(`Adopted ${names.length} screenshot(s) into ${relative(root, target)}/:`);
  for (const name of names) console.log(`  ${name}`);
}

function selectFiles(root, options) {
  const scratch = join(root, ".scratch");
  let entries;
  if (options.files.length) {
    entries = options.files.map((file) => {
      const absolute = resolve(file);
      const rel = relative(root, absolute);
      if (rel.startsWith("..") || resolve(root, rel) !== absolute) fail(`${file} is outside this checkout`);
      const fromScratch = relative(scratch, absolute);
      return { absolute, name: (fromScratch.startsWith("..") ? rel : fromScratch).split(sep).join("/") };
    });
  } else {
    const dir = options.dir ? resolve(options.dir) : scratch;
    if (relative(root, dir).startsWith("..")) fail(`${options.dir} is outside this checkout`);
    const names = collectImages(dir);
    if (!options.dir) {
      const tasks = [...new Set(names.map((name) => (name.includes("/") ? name.split("/")[0] : ".")))];
      if (tasks.length > 1) {
        fail(`.scratch holds screenshots of several tasks (${tasks.join(", ")}); pass --dir .scratch/<task-slug> or the files`);
      }
    }
    entries = names.map((name) => ({ absolute: join(dir, name), name }));
  }
  if (entries.length > MAX_FILES) fail(`${entries.length} images; at most ${MAX_FILES} — pass the ones the pull request needs`);
  for (const entry of entries) {
    const stat = lstatSync(entry.absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) fail(`${entry.name} is not a regular file`);
    if (stat.size > MAX_BYTES) fail(`${entry.name} is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    if (!imageKind(readFileSync(entry.absolute))) fail(`${entry.name} is not a PNG, JPEG, GIF or WebP image`);
  }
  return entries;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "help") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\nimport ")[0].replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, ""));
    return;
  }
  const root = run("git", ["rev-parse", "--show-toplevel"]);
  if (options.command === "adopt") return adopt(root, options.files[0]);

  const files = selectFiles(root, options);
  if (!files.length) {
    console.log("No screenshots under .scratch/. A visible change needs before/after captures first (docs/agents/verification.md#screenshots-in-pull-requests).");
    return;
  }
  const branch = tryRun("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root }) ?? `detached-${run("git", ["rev-parse", "--short", "HEAD"], { cwd: root })}`;
  const remote = options.remote ?? tryRun("git", ["config", `branch.${branch}.pushRemote`], { cwd: root })
    ?? tryRun("git", ["config", "remote.pushDefault"], { cwd: root })
    ?? tryRun("git", ["config", `branch.${branch}.remote`], { cwd: root })
    ?? "origin";
  const slug = githubSlug(run("git", ["remote", "get-url", remote], { cwd: root }));
  if (!slug) fail(`remote ${remote} is not a GitHub repository`);

  console.error(`Screenshots for ${branch} → ${slug} (${ASSETS_BRANCH}):`);
  for (const file of files) console.error(`  ${file.name}`);
  if (options.dryRun) return;

  let pr = null;
  if (!options.print) {
    const view = tryRun("gh", ["pr", "view", ...(options.pr ? [options.pr] : []), "--json", "number,body,url"], { cwd: root });
    if (!view) fail(`no pull request ${options.pr ? options.pr : "for this branch"}; open it first (gh pr create), or use --print`);
    pr = JSON.parse(view);
  }

  const { commit, paths } = publish({ cwd: root, remote, branch, files });
  const section = screenshotSection(files.map((file) => file.name), (name) => imageUrl(slug, commit, paths.get(name)));
  if (options.print) {
    console.log(section);
    return;
  }
  run("gh", ["pr", "edit", String(pr.number), "--body-file", "-"], { cwd: root, input: upsertSection(pr.body, section) });
  console.error(`Attached ${files.length} screenshot(s) to ${pr.url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error?.stderr?.toString().trim() || error?.message || String(error));
  }
}
