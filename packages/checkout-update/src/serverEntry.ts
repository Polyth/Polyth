// Contributes the git checkout driver to the host's automatic updates when
// this server runs from a source checkout. Packaged servers (npm, Homebrew,
// archive, container) bring their own driver or none; there this package
// contributes nothing.
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Disposable } from "@polyth/contracts";
import { SERVER_SELF_UPDATE, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createCheckoutUpdater } from "./updater.ts";
import { checkoutRoot } from "./index.ts";

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The server's own script lives in `root`: it runs from this checkout. */
export function runsFrom(root: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  const inside = relative(real(root), real(entry));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let contribution: Disposable | undefined;
  return {
    async onEnable() {
      const root = checkoutRoot();
      if (!root || !runsFrom(root)) return;
      const drivers = host.services.get(SERVER_SELF_UPDATE);
      if (!drivers) return;
      try {
        contribution = drivers.contribute(createCheckoutUpdater({ root }));
      } catch (error) {
        // The host already has a driver for this install.
        console.warn(`[polyth] checkout updates not offered: ${(error as Error).message}`);
      }
    },
    async onDisable() {
      contribution?.dispose();
      contribution = undefined;
    },
  };
}
