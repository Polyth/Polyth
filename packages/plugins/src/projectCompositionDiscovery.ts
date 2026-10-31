import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PACKAGE_CATEGORIES,
  parseProjectAffinity,
  type PackageCategory,
} from "@polyth/contracts/project-composition";
import {
  discoverServerPackages as discoverStructuralServerPackages,
  type DiscoveredServerPackage,
} from "./serverPackage.ts";

const invalid = (id: string, field: string) =>
  Object.assign(new Error(`package "${id}" polyth.descriptor.${field} is invalid`), { code: "invalid-input" });

/** Composition-aware public discovery seam.
 *
 * `serverPackage.ts` remains the low-level package/entry-point scanner. This
 * adapter owns optional Project Composition metadata so legacy/external
 * descriptors remain valid while all public discovery consumers receive one
 * validated canonical descriptor shape.
 */
export async function discoverServerPackages(packagesDir: string): Promise<DiscoveredServerPackage[]> {
  const packages = await discoverStructuralServerPackages(packagesDir);
  return Promise.all(packages.map(async (pkg) => {
    const manifest = JSON.parse(await readFile(join(pkg.dir, "package.json"), "utf8")) as {
      polyth?: { descriptor?: Record<string, unknown> };
    };
    const raw = manifest.polyth?.descriptor;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid(pkg.id, "projectAffinity");
    }

    const rawCategory = raw.category;
    let category: PackageCategory | undefined;
    if (rawCategory !== undefined) {
      if (typeof rawCategory !== "string" || !(PACKAGE_CATEGORIES as readonly string[]).includes(rawCategory)) {
        throw invalid(pkg.id, "category");
      }
      category = rawCategory as PackageCategory;
    }

    const projectAffinity = raw.projectAffinity === undefined
      ? undefined
      : parseProjectAffinity(raw.projectAffinity);

    return {
      ...pkg,
      descriptor: {
        ...pkg.descriptor,
        ...(category ? { category } : {}),
        ...(projectAffinity ? { projectAffinity } : {}),
      },
    };
  }));
}
