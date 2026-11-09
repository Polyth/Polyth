/**
 * Build editions. The standard edition is everything Polyth ships. The
 * workstation edition is a local-only shell for coding harnesses on a managed
 * work computer: no Polyth Link, relay, phone pairing or push, no client mode,
 * no runtime package installs and no app-initiated downloads. Its rules and the
 * network endpoints it may contact are in docs/security/workstation-edition.md.
 *
 * Browser-safe: no Node imports. Server code reads the edition from the
 * environment variable the desktop main process sets from its build flavor.
 */

export type PolythEdition = "standard" | "workstation";

export const WORKSTATION_EDITION = "workstation" satisfies PolythEdition;

/** Editions a package may opt into beyond standard (`polyth.editions`). */
export const OPTIONAL_EDITIONS: readonly PolythEdition[] = [WORKSTATION_EDITION];

/** Environment variable carrying the edition into the server process. */
export const POLYTH_EDITION_ENV = "POLYTH_EDITION";

/** Unknown or absent values are the standard edition. */
export function polythEdition(value: string | null | undefined): PolythEdition {
  return value === WORKSTATION_EDITION ? WORKSTATION_EDITION : "standard";
}

/** True when the process runs as the workstation edition. */
export function isWorkstationEdition(env: Readonly<Record<string, string | undefined>>): boolean {
  return polythEdition(env[POLYTH_EDITION_ENV]) === WORKSTATION_EDITION;
}

/**
 * Whether a package ships in an edition. Every package ships in standard; the
 * workstation edition is default-deny: a package is included only when its
 * manifest lists the edition in `polyth.editions`.
 */
export function packageInEdition(editions: readonly string[] | undefined, edition: PolythEdition): boolean {
  return edition === "standard" || (editions ?? []).includes(edition);
}

/** Error code for a request that the running edition does not offer. */
export const EDITION_UNAVAILABLE_CODE = "unavailable-in-edition";
