// The Polyth version a server reports (health, system info, agent sessions).
// A host that bundles the server passes its own (`BootOptions.version`: the
// packaged server's BUILD.json, Desktop's app version); a checkout reports its
// root package.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reported when neither a host nor a checkout names a version. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

/** The version of the checkout this module runs from, if it runs from one. */
export function checkoutVersion(here: string = import.meta.dirname): string {
  const root = join(here, "..", "..", "..");
  try {
    if (!existsSync(join(root, "packages", "server", "package.json"))) return UNKNOWN_VERSION;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return manifest.name === "polyth" && typeof manifest.version === "string" ? manifest.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function serverVersion(hostVersion?: string): string {
  const named = hostVersion?.trim();
  return named ? named : checkoutVersion();
}
