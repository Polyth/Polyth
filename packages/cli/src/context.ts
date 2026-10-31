import type { FlagSpec, Parsed } from "./args.ts";
import { createClient, type Client } from "./client.ts";
import type { Output } from "./output.ts";
import { readConfig, resolveTarget, type CliConfig, type Target } from "./target.ts";
import type { WhoAmI } from "./api.ts";

export interface Context {
  o: Output;
  /** Global flags (--url, --target, --data-dir, --space, --json…). */
  globals: Parsed["flags"];
  config(): CliConfig;
  target(): Target;
  client(): Client;
  whoami(): Promise<WhoAmI>;
}

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  /** Longer help shown by `polyth help <command>`. */
  details?: string;
  flags?: FlagSpec[];
  /** Hidden from the command list (still runnable). */
  hidden?: boolean;
  run(ctx: Context, args: Parsed): Promise<number | void>;
}

export function createContext(o: Output, globals: Parsed["flags"]): Context {
  let config: CliConfig | undefined;
  let target: Target | undefined;
  let client: Client | undefined;
  let who: Promise<WhoAmI> | undefined;
  const ctx: Context = {
    o,
    globals,
    config: () => (config ??= readConfig()),
    target: () => {
      if (!target) {
        const resolved = resolveTarget({
          ...(typeof globals.url === "string" ? { url: globals.url } : {}),
          ...(typeof globals.target === "string" ? { target: globals.target } : {}),
          ...(typeof globals["data-dir"] === "string" ? { dataDir: globals["data-dir"] } : {}),
          config: ctx.config(),
        });
        target = typeof globals.space === "string" && resolved.kind === "http" ? { ...resolved, space: globals.space } : resolved;
      }
      return target;
    },
    client: () => {
      if (!client) {
        const base = createClient(ctx.target());
        const space = typeof globals.space === "string" ? globals.space : undefined;
        client = space && ctx.target().kind === "socket"
          ? { ...base, request: (m, p, opts = {}) => base.request(m, p, { space, ...opts }), get: (p, opts = {}) => base.request("GET", p, { space, ...opts }), post: (p, b, opts = {}) => base.request("POST", p, { space, ...opts, body: b ?? {} }) }
          : base;
      }
      return client;
    },
    whoami: () => (who ??= ctx.client().get<WhoAmI>("/api/cli/whoami")),
  };
  return ctx;
}
