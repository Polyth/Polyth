// While a person has a joined Space open (a Space of another Polyth server,
// reached through Polyth Link: docs/architecture/polyth-link.md "Joined
// Spaces"), every API request takes one of three ways:
//
// - local: the person's own things and this computer's (sign-in, personal
//   preferences, the Space list, the package bundle, Link, the CLI, health)
//   stay on this server, resolved in the person's own Space;
// - unavailable: what carries this computer's secrets or its connections to
//   other machines (Vault, SSH, custom providers, MCP servers) is refused:
//   a page left open from this server must not send them to the other one;
// - forward: everything else goes to the other server, as the person's
//   device there. That server decides what the device may do (its route
//   table, or the person's own rights for a device with full access).
//
// A request body is never read here, and nothing about the person's session
// on this server travels with a forwarded request (the Link service strips
// it).
import type { OwnedRemotePolicy } from "./remotePolicy.ts";

export type JoinedSpaceRoute = "local" | "forward" | "unavailable";

/** Exact paths and `prefix/` subtrees that never leave this server. */
const LOCAL_PATHS: readonly string[] = [
  "/api/auth",
  "/api/settings/client",
  "/api/spaces",
  "/api/packages",
  // The package bundle this page runs is this server's, never the other
  // server's: its assets would execute as this origin.
  "/api/package-assets",
  "/api/plugins",
  "/api/tunnel",
  "/api/cli",
  "/api/system",
  "/api/health",
  "/api/iconify",
  "/api/push",
];

const isLocalPath = (path: string): boolean => under(LOCAL_PATHS, path);

/** Subtrees that hold this computer's secrets or reach other machines. */
const NEVER_FORWARD: readonly string[] = [
  "/api/secure-safe",
  "/api/credential-vault",
  "/api/ssh",
  "/api/providers/custom",
  "/api/mcp",
];

const under = (paths: readonly string[], path: string): boolean =>
  paths.some((root) => path === root || path.startsWith(`${root}/`));

export function joinedSpaceRoute(
  _method: string,
  path: string,
  // Kept for callers: the other server's own table decides what it allows.
  _policies?: readonly OwnedRemotePolicy[],
): JoinedSpaceRoute {
  if (!path.startsWith("/api/")) return "local";
  if (isLocalPath(path)) return "local";
  if (under(NEVER_FORWARD, path)) return "unavailable";
  return "forward";
}

/** Only a person signed in here may open their joined Spaces: never a paired
 *  device of this server, a token or an internal caller. */
export const mayUseJoinedSpaces = (principal: { kind: string }): boolean =>
  principal.kind === "ui-session" || principal.kind === "local-user";
