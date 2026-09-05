// Tenant-separated storage layout.
//
//   <dataDir>/spaces/<slug>-<shortId>/{projects,worktrees,attachments,runtime,packages}
//
// Separation here is organizational, not a security boundary by itself: the
// boundary is that a path is only ever derived from an already-validated
// SpaceContext, never from a client-supplied id. `resolveInside` is the
// enforcement primitive — it refuses traversal, absolute-path injection, and
// symlink escape by comparing REAL paths.
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { SpaceDto, SpaceStorage } from "@polyth/contracts";

const error = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** Per-space subdirectories the platform guarantees. Packages get their own
 *  space under `packages/<packageId>` instead of writing anywhere they like. */
export const SPACE_SUBDIRS = [
  "projects",
  "worktrees",
  "attachments",
  "runtime",
  "packages",
] as const;

/** Directory name for a Space. Slug first so the tree stays human-readable;
 *  the id suffix guarantees uniqueness even after a rename. */
export const spaceDirName = (space: Pick<SpaceDto, "id" | "slug">): string =>
  `${space.slug}-${space.id.replace(/^spc_/, "").slice(0, 8)}`;

export const spacesRoot = (dataDir: string): string => join(resolve(dataDir), "spaces");

/** Absolute storage root for one Space. Creates the tree on first use. */
export function spaceStorageDir(dataDir: string, space: Pick<SpaceDto, "id" | "slug">): string {
  const dir = join(spacesRoot(dataDir), spaceDirName(space));
  mkdirSync(dir, { recursive: true });
  for (const sub of SPACE_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  return realpathSync.native(dir);
}

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/**
 * Join `relative` under `base` and prove the result stays inside it.
 *
 * Checked in this order so no single trick gets through:
 *  1. absolute / drive-letter / UNC input is refused outright;
 *  2. the lexical join is compared against the base (catches `..`);
 *  3. the deepest EXISTING ancestor is realpath'd (catches symlink escape,
 *     bind-mount escape, and a symlinked base itself).
 */
export function resolveInside(base: string, relative: string): string {
  if (typeof relative !== "string" || relative.length === 0) {
    throw error("invalid-path", "path is required");
  }
  if (relative.includes("\0")) throw error("invalid-path", "path contains a null byte");
  if (isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.startsWith("\\\\")) {
    throw error("invalid-path", "path must be relative");
  }
  const realBase = realpathSync.native(base);
  const candidate = resolve(realBase, relative);
  if (!inside(realBase, candidate)) throw error("invalid-path", "path escapes its space");

  // Walk up to the deepest component that exists and realpath THAT: a symlink
  // anywhere along the existing prefix would otherwise land outside the base
  // while the lexical check above still passed.
  let probe = candidate;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      if (!inside(realBase, real)) throw error("invalid-path", "path escapes its space");
      break;
    } catch (cause) {
      if ((cause as { code?: string }).code === "invalid-path") throw cause;
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      if (!inside(realBase, parent)) throw error("invalid-path", "path escapes its space");
      probe = parent;
    }
  }
  return candidate;
}

export function createSpaceStorage(root: string): SpaceStorage {
  return {
    root,
    packageDir(packageId) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packageId)) {
        throw error("invalid-input", "package id must be lowercase letters, digits, and dashes");
      }
      const dir = join(root, "packages", packageId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path: (relative) => resolveInside(root, relative),
  };
}
