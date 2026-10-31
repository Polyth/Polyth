/** Development-only agent UI beta mode.
 *
 * The mode keeps host harness discovery/authentication intact while making
 * workspace execution read-only. UI/settings mutations still target the
 * disposable Polyth data directory created by the beta launcher.
 */
export const AGENT_BETA_ENV = "POLYTH_AGENT_BETA";

export function agentBetaEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[AGENT_BETA_ENV] === "1";
}

const FILESYSTEM_MUTATION_PERMISSIONS = new Set([
  "applypatch",
  "bash",
  "command",
  "commandexecution",
  "delete",
  "edit",
  "editfile",
  "execute",
  "executecommand",
  "filechange",
  "filesystemwrite",
  "fswrite",
  "mkdir",
  "move",
  "movefile",
  "movepath",
  "notebookedit",
  "patch",
  "powershell",
  "remove",
  "removefile",
  "removepath",
  "rename",
  "renamefile",
  "renamepath",
  "runcommand",
  "sedfile",
  "shell",
  "touch",
  "write",
  "writefile",
  "writetofile",
]);

const permissionKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

export function isFilesystemMutationPermission(permission: string): boolean {
  return FILESYSTEM_MUTATION_PERMISSIONS.has(permissionKey(permission));
}

export function agentBetaBlocksPermission(permission: string): boolean {
  return agentBetaEnabled() && isFilesystemMutationPermission(permission);
}

export const AGENT_BETA_READ_ONLY_MESSAGE =
  "Agent beta mode is read-only for the workspace; filesystem and shell mutations are disabled.";
