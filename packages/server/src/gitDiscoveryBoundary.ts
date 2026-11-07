// The data directory is a Git discovery boundary. By default it is `./data`, so
// a checkout that runs its own server holds every project made in the Polyth
// folder inside that checkout. Git walks up from such a project and answers for
// the enclosing repository: the project shows someone else's branches and
// isolation and agent commands act on the wrong repository.
//
// Set once at boot in the server's environment, so every child that inherits it
// gets the boundary. A repository inside the data directory, such as a project's
// own `git init` or clone, is still found.
import { delimiter } from "node:path";

export function bindGitDiscoveryToDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const existing = env.GIT_CEILING_DIRECTORIES;
  if (!existing) {
    env.GIT_CEILING_DIRECTORIES = dataDir;
    return;
  }
  if (existing.split(delimiter).includes(dataDir)) return;
  env.GIT_CEILING_DIRECTORIES = `${existing}${delimiter}${dataDir}`;
}
