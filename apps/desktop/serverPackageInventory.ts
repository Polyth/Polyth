import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import type { ServerPackageRegistration } from "@polyth/server";
import type { PolythEdition } from "@polyth/contracts/edition";
import {
  editionServerPackages,
  loadServerPackages,
  serverPackagesPlugin,
} from "../../scripts/server-packages-bundle.ts";

// The inventory itself is shared with the packaged server (apps/server):
// scripts/server-packages-bundle.ts. Desktop keeps its own names for it.
export { editionServerPackages };

/** Unbundled development/test path. Packaged builds substitute static imports below. */
export function loadDesktopServerPackages(root: string, edition: PolythEdition = "standard"): Promise<ServerPackageRegistration[]> {
  return loadServerPackages(root, edition);
}

/** Every feature of the edition is included by esbuild; no runtime filesystem
 *  scan in an installed app. Packages outside the edition are never imported,
 *  so none of their code reaches the bundle. */
export function desktopServerPackagesPlugin(root: string, edition: PolythEdition = "standard"): Plugin {
  return serverPackagesPlugin({
    root,
    edition,
    modulePath: resolve(root, "apps/desktop/src/serverPackages.ts"),
    exportName: "desktopServerPackages",
  });
}
