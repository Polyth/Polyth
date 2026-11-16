// Environment hygiene for subprocesses Polyth itself spawns to inspect or
// mutate a repository (git, repository search). A server started from inside a
// git hook, or from a shell exporting shell-startup variables, would otherwise
// hand those to every child: GIT_DIR & co. redirect git to another repository,
// GIT_CONFIG_* inject configuration, BASH_ENV & co. run code at shell start.
//
// Dependency-free (Node built-ins only). Apply it to the inherited environment
// first, then layer variables Polyth sets on purpose (askpass, identity, LC_ALL)
// on top so they survive.

const EXACT = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4",
]);
const PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

const dropped = (name: string): boolean => {
  // Windows environment names are case-insensitive.
  const key = name.toUpperCase();
  return EXACT.has(key) || PREFIXES.some((prefix) => key.startsWith(prefix));
};

/** Returns a copy of `env` without variables that redirect git to another
 *  repository, inject git configuration or run shell startup code. Everything
 *  else (PATH, HOME, SSH_AUTH_SOCK, GIT_SSH_COMMAND, GIT_ASKPASS,
 *  GIT_CONFIG_GLOBAL, locale…) is kept. Never mutates its input. */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!dropped(name)) out[name] = value;
  return out;
}
