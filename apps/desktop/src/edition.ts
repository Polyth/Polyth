import { WORKSTATION_EDITION, type PolythEdition } from "@polyth/contracts/edition";
import { DEFAULT_SERVERS_STATE, type DesktopServersState } from "./servers.ts";

/**
 * Build flavor of the workstation edition (scripts/ci/workstation.mjs): a
 * local-only shell for coding harnesses. Rules: docs/security/workstation-edition.md.
 */
export const WORKSTATION_FLAVOR = "workstation";

/** Its electron-updater channel: `workstation.yml`, `workstation-mac.yml` and
 *  `workstation-linux.yml` on stable releases (scripts/ci/update-feed.mjs). */
export const WORKSTATION_UPDATER_CHANNEL = "workstation";

/** The edition a build flavor produces. Every flavor but workstation is standard. */
export const desktopEdition = (flavor: string): PolythEdition =>
  flavor === WORKSTATION_FLAVOR ? WORKSTATION_EDITION : "standard";

/**
 * The workstation edition shows only this computer's server. Remote addresses
 * and Link connections saved by a standard build installed earlier under the
 * same app id are dropped, so nothing the person saw before can be reopened.
 */
export const workstationServersState = (_saved: DesktopServersState): DesktopServersState => ({
  ...DEFAULT_SERVERS_STATE,
});

/** Error carrying the code the window shows for a request the edition does not offer. */
export class EditionUnavailableError extends Error {
  readonly code = "unavailable-in-edition";
  constructor(what: string) {
    super(`${what} is not available in the workstation edition`);
  }
}

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

/**
 * Whether the workstation window may make a request. It talks to this
 * computer's server only (HTTP and its WebSockets on the same loopback
 * origin); in-app schemes (file, data, blob, devtools, the hub scheme) never
 * leave the machine. Every other network request is cancelled, so a message,
 * a package page or a remote image cannot reach the internet from the window.
 */
export const workstationWindowRequestAllowed = (requestUrl: string, localServerUrl: string): boolean => {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  if (!NETWORK_SCHEMES.has(url.protocol)) return true;
  if (!localServerUrl) return false;
  const local = new URL(localServerUrl);
  const sameHostPort = url.hostname === local.hostname && url.port === local.port;
  return sameHostPort && (url.protocol === local.protocol || url.protocol === (local.protocol === "https:" ? "wss:" : "ws:"));
};
