// Source execution uses discovery; the desktop build replaces this module with
// static imports generated from the same polyth.serverEntry manifests.
import { resolve } from "node:path";
import { loadDesktopServerPackages } from "../serverPackageInventory.ts";

export const desktopServerPackages = await loadDesktopServerPackages(
  resolve(import.meta.dirname, "../../.."),
);
