// A renamed package keeps its data.
//
// Package data lives in directories named after the package id (see
// packageResidue.ts for every root). A package that changes its id lists the
// ids it was installed under in `polyth.formerIds`; at boot, before any
// package registers, each `<root>/<former>` directory moves to `<root>/<id>`.
//
// Like adoptLegacyPackageData: rename once, never overwrite, never copy,
// never delete. When both directories exist (an older build ran after the
// rename, or a backup was restored) the package keeps its current directory
// and the former one is left untouched; it is then listed as residue, where
// the instance owner can inspect and remove it. Only real directories move:
// a symlink under a former id is never followed or taken over.
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { PackageResidueRoot } from "./packageResidue.ts";

export interface PackageRename {
  id: string;
  formerIds: readonly string[];
}

export interface PackageRenameReport {
  moved: Array<{ from: string; to: string }>;
  /** Former directories left in place because the current one exists. */
  kept: string[];
  failed: Array<{ path: string; error: unknown }>;
}

const isRealDirectory = (path: string): boolean => {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
};
/** Anything at all, a dangling link included, blocks the move. */
const occupied = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

export function adoptRenamedPackageData(
  roots: readonly PackageResidueRoot[],
  renames: readonly PackageRename[],
): PackageRenameReport {
  const report: PackageRenameReport = { moved: [], kept: [], failed: [] };
  for (const { id, formerIds } of renames) {
    for (const root of roots) {
      for (const former of formerIds) {
        const from = join(root.dir, former);
        if (!isRealDirectory(from)) continue;
        const to = join(root.dir, id);
        if (occupied(to)) { report.kept.push(from); continue; }
        try {
          renameSync(from, to);
          report.moved.push({ from, to });
        } catch (error) {
          report.failed.push({ path: from, error });
        }
      }
    }
  }
  return report;
}
