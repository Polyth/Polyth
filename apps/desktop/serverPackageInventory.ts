import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Plugin } from "esbuild";
import { discoverServerPackages, type ServerPackageFactory } from "@polyth/plugins";
import type { ServerPackageRegistration } from "@polyth/server";
import type { PackageDescriptorDto } from "@polyth/contracts";

async function inventory(root: string) {
  const packages = await discoverServerPackages(resolve(root, "packages"));
  return Promise.all(packages.map(async (pkg) => {
    const manifest = JSON.parse(await readFile(resolve(pkg.dir, "package.json"), "utf8")) as {
      polyth: { descriptor: Omit<PackageDescriptorDto, "id"> };
    };
    const packageRoot = await realpath(pkg.dir);
    // Every package, desktop included, loads its own manifest entry.
    const modulePath = await realpath(resolve(pkg.dir, pkg.entryPath));
    if (!modulePath.startsWith(packageRoot + sep) || !(await stat(modulePath)).isFile()) {
      throw new Error(`Desktop server entry escapes its package or is not a file: ${pkg.id}`);
    }
    return { ...pkg,
      // Keep the package's declared presentation order; discovery has already validated the descriptor.
      descriptor: { ...pkg.descriptor, ...manifest.polyth.descriptor, id: pkg.id },
      modulePath,
    };
  }));
}

/** Unbundled development/test path. Packaged builds substitute static imports below. */
export async function loadDesktopServerPackages(root: string): Promise<ServerPackageRegistration[]> {
  const packages = await inventory(root);
  return Promise.all(packages.map(async (pkg) => {
    const loaded = await import(pathToFileURL(pkg.modulePath).href) as { default?: ServerPackageFactory };
    if (typeof loaded.default !== "function") throw new Error(`Invalid desktop server factory: ${pkg.id}`);
    return { id: pkg.id, descriptor: pkg.descriptor, factory: loaded.default, ...(pkg.formerIds?.length ? { formerIds: pkg.formerIds } : {}) };
  }));
}

/** Every discovered feature is included by esbuild; no runtime filesystem scan in an installed app. */
export function desktopServerPackagesPlugin(root: string): Plugin {
  const modulePath = resolve(root, "apps/desktop/src/serverPackages.ts");
  return { name: "polyth-desktop-server-packages", setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]serverPackages\.ts$/ }, async (args) => {
      if (args.path !== modulePath) return;
      const packages = await inventory(root);
      return { loader: "js", resolveDir: root, contents: [
        ...packages.map((pkg, i) => `import factory${i} from ${JSON.stringify(pkg.modulePath)};`),
        "export const desktopServerPackages = [",
        ...packages.map((pkg, i) => `{id:${JSON.stringify(pkg.id)},descriptor:${JSON.stringify(pkg.descriptor)},factory:factory${i}${pkg.formerIds?.length ? `,formerIds:${JSON.stringify(pkg.formerIds)}` : ""}},`),
        "];",
      ].join("\n") };
    });
  } };
}
