// Boot rules of the workstation edition (docs/security/workstation-edition.md):
// a local-only shell, so the listener stays on loopback and no switch that
// widens who may reach it can be turned on from the environment.
import { isWorkstationEdition } from "@polyth/contracts/edition";

export interface WorkstationListenerInput {
  hostname: string;
  publicOrigin: string;
  env: Readonly<Record<string, string | undefined>>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Environment switches that let something other than the desktop window act
 *  as the owner, or publish the server; none may be on in the edition. */
const REFUSED_SWITCHES: ReadonlyArray<readonly [name: string, refused: (value: string) => boolean]> = [
  ["POLYTH_PUBLIC_ORIGIN", (value) => value.trim() !== ""],
  ["POLYTH_TRUSTED_PROXIES", (value) => value.trim() !== ""],
  ["POLYTH_AGENT_BETA", (value) => value === "1"],
  ["POLYTH_DEBUG_AGENT_ACCESS", (value) => value === "1"],
  ["POLYTH_UI_PASSWORD_LOCALHOST", (value) => value === "optional"],
];

const refused = (message: string): Error =>
  Object.assign(new Error(`Workstation edition: ${message}`), { code: "unavailable-in-edition" });

/**
 * Throws when the workstation edition would boot with a non-loopback listener
 * (0.0.0.0 included) or with a switch that publishes the server or skips the
 * owner's sign-in. A no-op in the standard edition.
 */
export function assertWorkstationListener(input: WorkstationListenerInput): void {
  if (!isWorkstationEdition(input.env)) return;
  const host = input.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) throw refused(`the server listens on loopback only, not "${input.hostname}"`);
  if (input.publicOrigin) throw refused("POLYTH_PUBLIC_ORIGIN cannot be set");
  for (const [name, isRefused] of REFUSED_SWITCHES) {
    const value = input.env[name];
    if (value !== undefined && isRefused(value)) throw refused(`${name} cannot be set`);
  }
}

/** The edition sends no push notifications: no relay, no direct APNs. */
export const workstationPushDisabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  isWorkstationEdition(env);
