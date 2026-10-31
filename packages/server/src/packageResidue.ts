// Leftover data of packages that are no longer installed.
//
// Every package keeps its data under directories named after its id:
// `<dataDir>/packages/<id>` (deployment-wide, `packageDataDir`),
// `<space>/packages/<id>` (per Space, `spaceStorage(ctx).packageDir`) and, for
// a person's own accounts, `<dataDir>/people/<user>/packages/<id>` and
// `<dataDir>/people/<user>/vault/<id>` (`host.people`). Removing
// a workspace package is deleting its folder; removing a managed package goes
// through the registry, which already sweeps its own data. Whatever remains
// under an id that no installed package claims is residue.
//
// Residue is listed, never deleted on its own: a package folder that is
// missing for a moment (a checkout switch, a failed copy) must not cost the
// operator its data. The instance owner removes it explicitly.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PackageResidueDto } from "@polyth/contracts";

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PackageResidueRoot {
  /** `null` for the deployment-wide root, otherwise the owning Space id. */
  spaceId: string | null;
  /** The directory that holds `<id>` package directories. */
  dir: string;
}

export interface PackageResidueOptions {
  roots(): readonly PackageResidueRoot[];
  /** Every id an installed package (workspace, bundled or managed) owns. */
  installedIds(): ReadonlySet<string>;
}

export interface PackageResidue {
  list(): PackageResidueDto[];
  /** Delete every leftover directory of one uninstalled package id. */
  purge(id: string): PackageResidueDto | null;
}

function directorySize(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat;
    try { stat = lstatSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(current); } catch { continue; }
      for (const name of names) stack.push(join(current, name));
    } else {
      total += stat.size;
    }
  }
  return total;
}

/** Every person's package storage and secrets, reported as deployment-wide
 *  locations. Only real directories count: a planted link is never walked. */
export function personPackageResidueRoots(peopleRoot: string): PackageResidueRoot[] {
  let people: string[] = [];
  try {
    people = readdirSync(peopleRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return people.flatMap((person) => [
    { spaceId: null, dir: join(peopleRoot, person, "packages") },
    { spaceId: null, dir: join(peopleRoot, person, "vault") },
  ]);
}

function packageDirs(root: PackageResidueRoot): string[] {
  try {
    return readdirSync(root.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PACKAGE_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function createPackageResidue(opts: PackageResidueOptions): PackageResidue {
  const collect = (only?: string): Map<string, PackageResidueDto & { paths: string[] }> => {
    const installed = opts.installedIds();
    const byId = new Map<string, PackageResidueDto & { paths: string[] }>();
    for (const root of opts.roots()) {
      for (const id of packageDirs(root)) {
        if (installed.has(id) || (only !== undefined && id !== only)) continue;
        const path = join(root.dir, id);
        const entry = byId.get(id) ?? { id, bytes: 0, locations: [], paths: [] };
        const bytes = directorySize(path);
        entry.bytes += bytes;
        entry.locations.push({ spaceId: root.spaceId, bytes });
        entry.paths.push(path);
        byId.set(id, entry);
      }
    }
    return byId;
  };

  return {
    list: () => [...collect().values()]
      .map(({ paths: _paths, ...dto }) => dto)
      .sort((left, right) => left.id.localeCompare(right.id)),
    purge(id) {
      if (!PACKAGE_ID.test(id)) {
        throw Object.assign(new Error("package id must be lowercase letters, digits, and dashes"), { code: "invalid-input" });
      }
      if (opts.installedIds().has(id)) {
        throw Object.assign(new Error(`package "${id}" is installed; remove it before deleting its data`), { code: "conflict" });
      }
      const residue = collect(id).get(id);
      if (!residue) return null;
      // Only real directories are collected; rmSync never follows a symlink
      // nested inside one.
      for (const path of residue.paths) rmSync(path, { recursive: true, force: true });
      const { paths: _paths, ...dto } = residue;
      return dto;
    },
  };
}
