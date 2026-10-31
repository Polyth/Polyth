// A fresh managed worktree holds only tracked files. Installed dependencies
// and other ignored local assets stay in the checkout it branched from, so
// tests, typechecks and builds could not run inside an isolate. Inherit them
// through symlinks instead of copying: nothing is duplicated on disk and the
// links leave with the worktree.
//
// Safety rules:
// - Never link a whole `node_modules` directory. An `npm install` inside the
//   isolate would then rewrite the parent checkout's tree. Each farm is a real
//   directory of per-package links, so a reinstall only replaces links.
// - Only paths ignored in the worktree itself are created, so an inherited
//   link can never show up as a change, be snapshotted or be merged back.
// - Existing paths are never replaced.
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveGitBinary } from "./gitBinary.ts";

/** Tracked file listing extra ignored paths to inherit, in .gitignore syntax.
 * The same convention as Claude Code's worktrees, but linked, not copied. */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDED_FILES = 2_000;

export interface InheritanceResult {
  /** Dependency folders rebuilt as per-package link farms (repo-relative). */
  dependencyFolders: string[];
  /** Ignored files linked from `.worktreeinclude` (repo-relative). */
  files: string[];
  /** Number of symlinks created. */
  links: number;
}

const gitLines = (cwd: string, args: string[], input?: string): Promise<string[]> =>
  new Promise((resolveLines) => {
    const child = execFile(resolveGitBinary(), args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => {
      // `check-ignore` exits 1 when nothing matched; every other failure
      // just means there is nothing to inherit.
      const code = (error as { code?: unknown } | null)?.code;
      if (error && code !== 1) return resolveLines([]);
      resolveLines(String(stdout).split("\0").filter(Boolean));
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Of `paths`, those Git ignores in `worktree`. */
async function ignoredIn(worktree: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const matched = await gitLines(worktree, ["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`);
  return new Set(matched.map((path) => path.replace(/\/$/, "")));
}

function createInheritance(sourceRoot: string, worktree: string) {
  let links = 0;

  /** Link one dependency entry. A relative link that stays inside the source
   * checkout (a workspace package, a `.bin` shim) is copied verbatim so it
   * resolves inside the worktree, to the branch's own package sources. Every
   * other entry points at its real location, so chains of isolates nested in
   * isolates never stack links on links. */
  const linkEntry = async (from: string, to: string): Promise<void> => {
    if (await exists(to)) return;
    const stat = await lstat(from);
    let target: string;
    if (stat.isSymbolicLink()) {
      const text = await readlink(from);
      if (!isAbsolute(text) && inside(sourceRoot, resolve(dirname(from), text))) {
        target = text;
      } else {
        try { target = await realpath(from); } catch { return; }
      }
    } else {
      target = from;
    }
    await symlink(target, to);
    links += 1;
  };

  const farm = async (from: string, to: string, depth = 0): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      // `.package-lock.json` and other npm bookkeeping describe the source
      // tree; copying them would make npm trust a tree it did not build.
      if (entry.name.startsWith(".") && entry.name !== ".bin") continue;
      const nested = depth === 0 && entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin");
      if (nested) await farm(join(from, entry.name), join(to, entry.name), depth + 1);
      else await linkEntry(join(from, entry.name), join(to, entry.name));
    }
  };

  return {
    farm,
    get links() { return links; },
  };
}

/** Link installed dependencies and `.worktreeinclude` files from `source` (the
 * checkout the worktree branched from) into `worktree`. Best effort: a failure
 * leaves a partial set of links, never a modified source. */
export async function inheritCheckoutEnvironment(source: string, worktree: string): Promise<InheritanceResult> {
  const sourceRoot = await realpath(source);
  const worktreeRoot = await realpath(worktree);
  const inheritance = createInheritance(sourceRoot, worktreeRoot);
  const result: InheritanceResult = { dependencyFolders: [], files: [], links: 0 };

  const ignoredFolders = await gitLines(sourceRoot, [
    "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z",
  ]);
  const candidates: string[] = [];
  for (const entry of ignoredFolders) {
    const path = entry.replace(/\/$/, "");
    if (!entry.endsWith("/") || path.split("/").at(-1) !== "node_modules") continue;
    // A package folder that does not exist on this branch has nothing to use it.
    if (path !== "node_modules" && !await exists(join(worktreeRoot, dirname(path)))) continue;
    candidates.push(path);
  }
  // Ask about directories: the folders do not exist in the fresh worktree yet,
  // and a directory-only rule (`node_modules/`, the common spelling) never
  // matches a path Git cannot see is a directory.
  const ignoredDeps = await ignoredIn(worktreeRoot, candidates.map((path) => `${path}/`));
  for (const path of candidates) {
    if (!ignoredDeps.has(path) || await exists(join(worktreeRoot, path))) continue;
    await inheritance.farm(join(sourceRoot, path), join(worktreeRoot, path));
    result.dependencyFolders.push(path);
  }

  const includeFile = await exists(join(worktreeRoot, WORKTREE_INCLUDE_FILE))
    ? join(worktreeRoot, WORKTREE_INCLUDE_FILE)
    : join(sourceRoot, WORKTREE_INCLUDE_FILE);
  const patterns = await readFile(includeFile, "utf8").catch(() => "");
  if (patterns.trim()) {
    const included = (await gitLines(sourceRoot, [
      "ls-files", "--others", "--ignored", `--exclude-from=${includeFile}`, "-z",
    ])).filter((path) => !path.split("/").includes("node_modules")).slice(0, MAX_INCLUDED_FILES);
    const ignoredFiles = await ignoredIn(worktreeRoot, included);
    for (const path of included) {
      if (!ignoredFiles.has(path)) continue;
      const to = join(worktreeRoot, path);
      if (await exists(to)) continue;
      const from = join(sourceRoot, path);
      let target: string;
      try { target = await realpath(from); } catch { continue; }
      if (!(await lstat(target)).isFile()) continue;
      await mkdir(dirname(to), { recursive: true });
      // A parent that resolves outside the worktree (an existing link) is
      // not ours to write through.
      const parent = await realpath(dirname(to));
      if (parent !== worktreeRoot && !inside(worktreeRoot, parent)) continue;
      await symlink(target, to);
      result.files.push(path);
    }
  }
  result.links = inheritance.links + result.files.length;
  return result;
}
