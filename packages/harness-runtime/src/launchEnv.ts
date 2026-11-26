// The environment a local harness process gets for one chat (see
// HarnessContext.launchEnv): Polyth's shell tools on PATH and the file that
// names their grant. A remote launch never gets it: the loopback endpoint the
// grant points at does not exist on another host.
import { delimiter as hostDelimiter } from "node:path";
import type { HarnessContext } from "@polyth/contracts";

/** `env` with the chat's launch additions, or `env` itself when there are none. */
export function withLaunchEnv(
  env: NodeJS.ProcessEnv,
  context: Pick<HarnessContext, "launchEnv" | "remote"> | undefined,
  delimiter: string = hostDelimiter,
): NodeJS.ProcessEnv {
  const launch = context?.launchEnv;
  if (!launch || context?.remote) return env;
  const next: NodeJS.ProcessEnv = { ...env, ...launch.env };
  if (launch.pathPrepend.length) {
    // Windows keeps the variable as `Path`; keep whichever spelling is there.
    const key = Object.keys(next).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const current = (next[key] ?? "").split(delimiter).filter(Boolean);
    const added = launch.pathPrepend.filter((dir) => !current.includes(dir));
    next[key] = [...added, ...current].join(delimiter);
  }
  return next;
}
