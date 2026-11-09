// A skill's files, stored by content so an identical copy is one folder and a
// stored copy never changes. Nothing here runs a file: a bundle is data until an
// agent, under its own permissions, chooses to read or run part of it.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { SkillFileDto, SkillFileKind } from "@polyth/contracts/capability-installations";

/** The longest instructions a harness accepts directly; longer ones are read from the bundle. */
export const MAX_DIRECT_INSTRUCTIONS = 64 * 1024;
export const BUNDLE_LIMITS = {
  files: 1024,
  bytes: 16 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  /** Instructions kept in the skill record, for review and editing. */
  instructionBytes: 256 * 1024,
} as const;
const PREVIEW_BYTES = 128 * 1024;

export interface SkillBundleFile {
  /** Forward-slash path inside the skill folder. */
  path: string;
  bytes: Buffer;
  executable: boolean;
}

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const HASH = /^[a-f0-9]{64}$/;
export const validBundleHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);

const SCRIPT = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|tsx|rb|pl|php|ps1|bat|cmd|lua)$/i;
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|tar|bz2|xz|7z|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|docx?|pptx?|xlsx?|wasm|so|dylib|dll|exe|bin|node|jar|class|pyc)$/i;

/** What a file is to a person reviewing it: something an agent can run, text to
 * read, or bytes neither can show. Path only, so it also works from an index. */
export function skillFileKind(path: string, executable = false): SkillFileKind {
  if (BINARY.test(path)) return "binary";
  if (SCRIPT.test(path) || executable) return "script";
  if (/(?:^|\/)scripts\/[^/]+$/.test(path) && !/\.(?:md|txt|json|ya?ml|toml)$/i.test(path)) return "script";
  return "text";
}

/** Zero-width and direction-control characters, which show nothing to a reader
 * yet reach the model. A leading byte-order mark and the emoji joiner are fine. */
export function hasHiddenText(text: string): boolean {
  return /[​‌⁠-⁤‪-‮⁦-⁩﻿\u{E0000}-\u{E007F}]/u.test(text.replace(/^﻿/, ""));
}

/** Covers every path and byte, so any change to any file changes the hash. */
export function bundleContentHash(files: readonly Pick<SkillBundleFile, "path" | "bytes">[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.bytes.length}\0`);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

const safeRelative = (path: string): boolean => {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const normal = posix.normalize(path);
  return normal === path && normal !== ".." && !normal.startsWith("../");
};

export function checkBundleLimits(files: readonly SkillBundleFile[]): void {
  if (files.length > BUNDLE_LIMITS.files) throw failure("invalid-input", `a skill can hold at most ${BUNDLE_LIMITS.files} files`);
  let total = 0;
  for (const file of files) {
    if (!safeRelative(file.path)) throw failure("invalid-input", `unsafe path in skill: ${file.path}`);
    if (file.bytes.length > BUNDLE_LIMITS.fileBytes) throw failure("invalid-input", `${file.path} is too large for a skill`);
    total += file.bytes.length;
  }
  if (total > BUNDLE_LIMITS.bytes) throw failure("invalid-input", "this skill's files are too large to install");
}

/** Stores files under `<root>/<hash>` and returns the hash. Written beside the
 * target and renamed into place, so a reader never sees half a bundle. */
export function writeBundle(root: string, files: readonly SkillBundleFile[]): string {
  checkBundleLimits(files);
  const hash = bundleContentHash(files);
  const target = join(root, hash);
  if (existsSync(target)) return hash;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = join(root, `.staging-${randomBytes(6).toString("hex")}`);
  try {
    for (const file of files) {
      const out = resolve(staging, file.path);
      if (!out.startsWith(resolve(staging) + sep)) throw failure("invalid-input", `unsafe path in skill: ${file.path}`);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      writeFileSync(out, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
    }
    try {
      renameSync(staging, target);
    } catch (cause) {
      // Another install stored the same content first; the bytes are identical.
      if (!existsSync(target)) throw cause;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return hash;
}

export function removeBundle(root: string, hash: string): void {
  if (validBundleHash(hash)) rmSync(join(root, hash), { recursive: true, force: true });
}

/** A skill folder's regular files. Links are skipped, never followed, so nothing
 * outside the folder is read; housekeeping files are left out of the copy. */
export function readFolderBundle(dir: string): SkillBundleFile[] {
  const files: SkillBundleFile[] = [];
  let total = 0;
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === ".git" || name === ".DS_Store" || name === "node_modules" || name === ".polyth-owned") continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) {
        walk(path, relative);
      } else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > BUNDLE_LIMITS.fileBytes || total > BUNDLE_LIMITS.bytes || files.length >= BUNDLE_LIMITS.files) {
          throw failure("invalid-input", "this skill's files are too large to copy");
        }
        files.push({ path: relative, bytes: readFileSync(path), executable: (stat.mode & 0o111) !== 0 });
      }
    }
  };
  walk(dir, "");
  return files;
}

export const fileRows = (files: readonly SkillBundleFile[]): SkillFileDto[] =>
  files.map((file) => ({ path: file.path, bytes: file.bytes.length, kind: skillFileKind(file.path, file.executable) }));

/** What a reviewer can read of one file, whichever store it came from. */
export function previewFile(path: string, bytes: Buffer, executable = false) {
  const kind = skillFileKind(path, executable);
  const binary = kind === "binary" || bytes.subarray(0, 4096).includes(0);
  if (binary) return { path, kind: "binary" as const, bytes: bytes.length };
  const truncated = bytes.length > PREVIEW_BYTES;
  return {
    path,
    kind,
    bytes: bytes.length,
    text: bytes.subarray(0, PREVIEW_BYTES).toString("utf8"),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** The first thing an agent reads of a skill stored with its files: where those
 * files are, since a copy has no folder of its own in the harness. */
export function instructionsWithBundle(instructions: string, dir: string): string {
  const head = [
    `Base directory for this skill: ${dir}`,
    "Paths in these instructions, such as references/guide.md or scripts/run.py, are relative to that directory.",
  ].join("\n");
  const whole = `${head}\n\n${instructions}`;
  // Too long to hand over directly: the same file is there to read.
  if (whole.length <= MAX_DIRECT_INSTRUCTIONS) return whole;
  return `${head}\n\nThese instructions are long, so they are kept in a file. Read ${join(dir, "SKILL.md")} now and follow it.`;
}
