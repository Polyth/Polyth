// The server packages a bundled Polyth server carries, shared by every host
// that bundles one: Polyth Desktop (apps/desktop) and the packaged server
// (apps/server). Each host keeps a small module exporting its package list;
// source execution loads it by discovery, and the host's esbuild build
// replaces it with static imports generated from the same manifests.
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Plugin } from "esbuild";
import { discoverServerPackages, type ServerPackageFactory } from "@polyth/plugins";
import type { ServerPackageRegistration } from "@polyth/server";
import type { PackageDescriptorDto } from "@polyth/contracts";
import { packageInEdition, type PolythEdition } from "@polyth/contracts/edition";

/** The server packages an edition bundles: every one for standard, only those
 *  whose manifest lists the edition for the workstation build. */
export async function editionServerPackages(root: string, edition: PolythEdition) {
  const packages = await discoverServerPackages(resolve(root, "packages"));
  return packages.filter((pkg) => packageInEdition(pkg.editions, edition));
}

async function inventory(root: string, edition: PolythEdition) {
  const packages = await editionServerPackages(root, edition);
  return Promise.all(packages.map(async (pkg) => {
    const manifest = JSON.parse(await readFile(resolve(pkg.dir, "package.json"), "utf8")) as {
      polyth: { descriptor: Omit<PackageDescriptorDto, "id"> };
    };
    const packageRoot = await realpath(pkg.dir);
    // Every package loads its own manifest entry.
    const modulePath = await realpath(resolve(pkg.dir, pkg.entryPath));
    if (!modulePath.startsWith(packageRoot + sep) || !(await stat(modulePath)).isFile()) {
      throw new Error(`Bundled server entry escapes its package or is not a file: ${pkg.id}`);
    }
    return { ...pkg,
      // Keep the package's declared presentation order; discovery has already validated the descriptor.
      descriptor: { ...pkg.descriptor, ...manifest.polyth.descriptor, id: pkg.id },
      modulePath,
    };
  }));
}

/** Unbundled development/test path. Bundled builds substitute static imports. */
export async function loadServerPackages(root: string, edition: PolythEdition = "standard"): Promise<ServerPackageRegistration[]> {
  const packages = await inventory(root, edition);
  return Promise.all(packages.map(async (pkg) => {
    const loaded = await import(pathToFileURL(pkg.modulePath).href) as { default?: ServerPackageFactory };
    if (typeof loaded.default !== "function") throw new Error(`Invalid bundled server factory: ${pkg.id}`);
    return { id: pkg.id, descriptor: pkg.descriptor, factory: loaded.default, ...(pkg.formerIds?.length ? { formerIds: pkg.formerIds } : {}) };
  }));
}

export interface ServerPackagesPluginOptions {
  /** Repository root. */
  root: string;
  edition?: PolythEdition;
  /** Absolute path of the host module this plugin replaces. */
  modulePath: string;
  /** Name of the array that module exports. */
  exportName: string;
}

/** Every feature of the edition is included by esbuild; no runtime filesystem
 *  scan in an installed build. Packages outside the edition are never
 *  imported, so none of their code reaches the bundle. */
export function serverPackagesPlugin({ root, edition = "standard", modulePath, exportName }: ServerPackagesPluginOptions): Plugin {
  const target = resolve(modulePath);
  return { name: `polyth-server-packages:${exportName}`, setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]serverPackages\.ts$/ }, async (args) => {
      if (args.path !== target) return;
      const packages = await inventory(root, edition);
      return { loader: "js", resolveDir: root, contents: [
        ...packages.map((pkg, i) => `import factory${i} from ${JSON.stringify(pkg.modulePath)};`),
        `export const ${exportName} = [`,
        ...packages.map((pkg, i) => `{id:${JSON.stringify(pkg.id)},descriptor:${JSON.stringify(pkg.descriptor)},factory:factory${i}${pkg.formerIds?.length ? `,formerIds:${JSON.stringify(pkg.formerIds)}` : ""}},`),
        "];",
      ].join("\n") };
    });
  } };
}
