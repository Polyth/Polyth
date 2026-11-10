// Turning a manifest into the MCP installation the host already owns.
//
// The package never writes configuration itself: it produces the input for
// `mcp.project` (create/createPersonal/remove), which stores secrets where the
// host already keeps them and keeps them out of every response. Two rules are
// this module's whole value:
//
//   1. A token goes to the person's own store — the Credential Vault partition
//      behind their MCP servers — because only that store is write-only by
//      contract. A Space installation keeps its secrets in the Space's MCP
//      secret file, which is fine for a service account and wrong for a
//      personal API key.
//   2. A local package must arrive from the manifest already pinned to an exact
//      version. There is no "install latest and hope": the reviewed bytes are
//      the installed bytes.
import { localPinningErrors, type IntegrationManifest } from "./manifest.ts";

/** `project` is a Space-owned server scoped to one project; `space` covers the
 *  whole Space; `person` is owned by one person and reaches their own chats. */
export type InstallScope = "project" | "space" | "person";

/** Structural mirror of the host's `McpCreateInput` (packages/server/src/mcp.ts)
 *  and of the transport it accepts. Kept local so this package never imports
 *  server internals — the host validates everything again on its side. */
export type InstallTransport =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headersSecretRefs: string[] };

export interface McpInstallInput {
  name: string;
  transport: InstallTransport;
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export type InstallFailure =
  | "unknown-entry"
  | "token-required"
  | "token-header-missing"
  | "local-unpinned"
  | "scope-not-allowed";

export type InstallPlan =
  | {
    ok: true;
    scope: InstallScope;
    input: McpInstallInput;
    /** What the person should know before it takes effect. */
    notes: string[];
  }
  | { ok: false; failure: InstallFailure; message: string };

/** One catalog entry as one MCP server: the entry id is the server name, so an
 *  installation is recognizable without an extra marker in the native config. */
export const serverNameFor = (entry: IntegrationManifest): string => entry.id;

/** The header a token travels in, or undefined when the entry does not say. */
function tokenHeaderOf(entry: IntegrationManifest): { name: string; prefix: string } | undefined {
  const header = entry.mcp.remote?.tokenHeader;
  if (!header) return undefined;
  return { name: header.name, prefix: header.valuePrefix ?? "" };
}

/**
 * Decide the scope, the transport and the secrets for one entry.
 *
 * `requestedScope` is a preference, not an override: a token entry is always
 * person-owned, and asking for a Space copy of a personal key is refused
 * instead of silently downgraded.
 */
export function planInstall(
  entry: IntegrationManifest | undefined,
  options: { token?: string; scope?: InstallScope } = {},
): InstallPlan {
  if (!entry) {
    return { ok: false, failure: "unknown-entry", message: "No integration by that name." };
  }
  const remote = entry.mcp.remote;
  const local = entry.mcp.local;

  if (entry.mcp.auth === "token") {
    if (options.scope && options.scope !== "person") {
      return {
        ok: false,
        failure: "scope-not-allowed",
        message: "An API token installs into your own credentials, not a shared Space server.",
      };
    }
    const header = tokenHeaderOf(entry);
    if (!header) {
      return {
        ok: false,
        failure: "token-header-missing",
        message: `${entry.name} does not say how its token travels, so the catalog will not guess. This entry needs a tokenHeader before it can connect.`,
      };
    }
    const token = options.token?.trim() ?? "";
    if (!token && remote?.tokenOptional !== true) {
      return { ok: false, failure: "token-required", message: `${entry.name} needs an API token.` };
    }
    if (!remote) {
      return { ok: false, failure: "scope-not-allowed", message: "A token entry needs a remote endpoint." };
    }
    return {
      ok: true,
      scope: "person",
      input: {
        name: serverNameFor(entry),
        transport: { kind: "http", url: remote.url, headersSecretRefs: token ? [header.name] : [] },
        ...(token ? { secrets: { [header.name]: `${header.prefix}${token}` } } : {}),
        enabled: true,
      },
      notes: token
        ? ["The token is stored write-only in your Credential Vault and never shown again."]
        : ["Installed without a key; some tools may refuse until you add one."],
    };
  }

  if (local) {
    // The manifest validator already refuses a floating version; this is the
    // second gate, because an unpinned command must never reach an install.
    const unpinned = localPinningErrors(local.command)[0];
    if (unpinned) return { ok: false, failure: "local-unpinned", message: unpinned };
    return {
      ok: true,
      scope: options.scope === "space" ? "space" : "project",
      input: {
        name: serverNameFor(entry),
        transport: { kind: "stdio", command: local.command[0]!, args: local.command.slice(1), envKeys: [] },
        enabled: true,
      },
      notes: ["Runs on the machine Polyth runs on; the first start downloads the package."],
    };
  }

  if (!remote) {
    return { ok: false, failure: "scope-not-allowed", message: "This entry has nothing to install." };
  }
  return {
    ok: true,
    scope: options.scope === "space" ? "space" : "project",
    input: { name: serverNameFor(entry), transport: { kind: "http", url: remote.url, headersSecretRefs: [] }, enabled: true },
    notes: entry.mcp.auth === "oauth"
      ? ["The first tool call opens the service's sign-in page."]
      : [],
  };
}

/** What a live MCP installation means for the catalog. */
export interface InstalledIntegration {
  entryId: string;
  /** The MCP installation id, needed to remove exactly this server. */
  serverId: string;
  name: string;
  scope: InstallScope;
  projectId?: string;
  revision: number;
  enabled: boolean;
  /** True when this ledger recorded the install, so the catalog owns removal. */
  catalogManaged: boolean;
}

/** The subset of a host installation this module reads. */
export interface LiveInstallation {
  id: string;
  name: string;
  revision?: number;
  enabled?: boolean;
  projectId?: string;
  scope?: string;
}

/**
 * Match live servers to catalog entries by name. A server the person created by
 * hand keeps working; it is reported as not catalog-managed, so the catalog
 * never removes something it did not add.
 */
export function installedFrom(
  entries: readonly IntegrationManifest[],
  spaceServers: readonly LiveInstallation[],
  personalServers: readonly LiveInstallation[],
  managed: readonly { serverId: string }[] = [],
): InstalledIntegration[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const owned = new Set(managed.map((record) => record.serverId));
  const out: InstalledIntegration[] = [];
  for (const server of spaceServers) {
    const entry = byId.get(server.name);
    if (!entry) continue;
    out.push({
      entryId: entry.id,
      serverId: server.id,
      name: server.name,
      scope: server.projectId ? "project" : "space",
      ...(server.projectId ? { projectId: server.projectId } : {}),
      revision: server.revision ?? 0,
      enabled: server.enabled !== false,
      catalogManaged: owned.has(server.id),
    });
  }
  for (const server of personalServers) {
    const entry = byId.get(server.name);
    if (!entry) continue;
    out.push({
      entryId: entry.id,
      serverId: server.id,
      name: server.name,
      scope: "person",
      revision: server.revision ?? 0,
      enabled: server.enabled !== false,
      catalogManaged: owned.has(server.id),
    });
  }
  return out;
}
