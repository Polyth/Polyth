// The Polyth version a server reports (health, system info, agent sessions).
// A host that bundles the server passes its own (`BootOptions.version`: the
// packaged server's BUILD.json, Desktop's app version); a checkout reports its
// root package.json, as a nightly when `POLYTH_RELEASE_CHANNEL=nightly` (a
// tester running the live checkout: nightly-only features such as bug reports
// key on the `-nightly` suffix).
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

/** A plain `X.Y.Z` checkout version marked nightly; anything else (a suffix
 *  already, the unknown version) stays as it is. */
export function checkoutChannelVersion(version: string, channel: string | undefined): string {
  return channel?.trim() === "nightly" && /^\d+\.\d+\.\d+$/.test(version) ? `${version}-nightly` : version;
}

/** A host's version as it is (its build already names its channel), else the
 *  checkout's in the channel `POLYTH_RELEASE_CHANNEL` names. */
export function serverVersion(
  hostVersion?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const named = hostVersion?.trim();
  return named ? named : checkoutChannelVersion(checkoutVersion(), env.POLYTH_RELEASE_CHANNEL);
}

/** The command that updates this install: the host's, else a container's or a
 *  checkout's. */
export function updateCommand(hostCommand?: string, inContainer: boolean = existsSync("/.dockerenv")): string {
  const named = hostCommand?.trim();
  if (named) return named;
  return inContainer
    ? "docker compose pull && docker compose up -d"
    : "git pull && npm ci && npm run build && npm run polyth:restart";
}
