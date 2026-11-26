// The chat block an agent leaves when it offers the person a package it built.
// Browser-safe: the server writes it, the timeline block reads it. Every field
// is derived on the server from the package folder's manifest, never from the
// agent's words, and `manifestSha256` pins the install to what the block shows.

export const PACKAGE_INSTALL_PROPOSED_EVENT = "plugins/install-proposed";

export interface PackageInstallProposal {
  proposalId: string;
  packageId: string;
  /** Install source the block passes to /api/plugins/install. */
  source: string;
  name: string;
  description: string;
  version: string;
  /** Runs code on the Polyth server (a trusted package), not in the sandbox. */
  server: boolean;
  /** Capability names it asks for; `required: false` is optional access. */
  capabilities: Array<{ name: string; required: boolean }>;
  /** Labels of outside accounts it connects to. */
  connections: string[];
  /** Where it shows up: manifest contribution kinds that are not empty. */
  surfaces: string[];
  manifestSha256: string;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Reads an event's data defensively; null when it is not a proposal. */
export function readInstallProposal(data: unknown): PackageInstallProposal | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
  if (!text("proposalId") || !text("packageId") || !text("source") || !text("manifestSha256")) return null;
  return {
    proposalId: text("proposalId"),
    packageId: text("packageId"),
    source: text("source"),
    name: text("name") || text("packageId"),
    description: text("description"),
    version: text("version"),
    server: raw.server === true,
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.flatMap((item) => {
        const entry = item as Record<string, unknown> | null;
        return entry && typeof entry.name === "string" ? [{ name: entry.name, required: entry.required !== false }] : [];
      })
      : [],
    connections: strings(raw.connections),
    surfaces: strings(raw.surfaces),
    manifestSha256: text("manifestSha256"),
  };
}
