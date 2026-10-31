import { hostname } from "node:os";
import { bool, str, UsageError } from "../args.ts";
import { PolythError, rawRequest } from "../client.ts";
import { createContext, type Command, type Context } from "../context.ts";
import { style, table } from "../output.ts";
import { openExternal, readStdin } from "../system.ts";
import {
  configPath, describeTarget, desktopDataDir, normalizeUrl, readConfig, writeConfig, type CliConfig,
} from "../target.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await rawRequest(url, { method: "POST", headers, body: JSON.stringify(body), timeoutMs: 30_000 });
  let parsed: Record<string, unknown> = {};
  try { parsed = response.text ? JSON.parse(response.text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

const targetNameFor = (url: string): string => new URL(url).hostname.replace(/^www\./, "");

function saveToken(config: CliConfig, name: string, url: string, token: string, makeCurrent: boolean): CliConfig {
  const next: CliConfig = { ...config, targets: { ...config.targets, [name]: { ...config.targets[name], url, token } } };
  if (makeCurrent) next.current = name;
  return next;
}

const SERVER_ERRORS: Record<string, string> = {
  "insecure-transport": "This server only accepts sign-in over HTTPS (or from the same machine). Use its https:// address.",
  "wrong-origin": "This address is not the server's configured public origin. Use the URL you open Polyth with in the browser.",
  "rate-limited": "Too many pending sign-ins; wait a minute and retry.",
  unavailable: "Command-line access is not available on this server version.",
};

export const login: Command = {
  name: "login",
  summary: "Sign this CLI in to a Polyth server (device code confirmed in the web UI)",
  usage: "polyth login [URL] [--profile read|control] [--name NAME] [--no-browser]\n       polyth login [URL] --token-stdin [--name NAME]",
  details: [
    "Opens the server's sign-in page; confirm the shown code while signed in to Polyth.",
    "The CLI receives its own revocable token (Settings → Command line). Approving",
    "agent permission requests stays in the Polyth UI.",
    "",
    "--token-stdin saves an automation token created in Settings → Command line instead.",
  ].join("\n"),
  flags: [
    { name: "profile", value: true, description: "read (look only) or control (create sessions, send, stop). Default: control" },
    { name: "name", value: true, description: "Name for this server in `polyth target ls`" },
    { name: "no-browser", description: "Do not try to open a browser" },
    { name: "token-stdin", description: "Read an existing token from standard input" },
  ],
  async run(ctx, args) {
    const { o } = ctx;
    const config = ctx.config();
    const raw = args.positionals[0]
      ?? (typeof ctx.globals.url === "string" ? ctx.globals.url : undefined)
      ?? process.env.POLYTH_URL
      ?? (config.current ? config.targets[config.current]?.url : undefined);
    if (!raw) throw new UsageError("which server? `polyth login https://polyth.example.com`");
    const url = normalizeUrl(raw);
    const name = str(args, "name") ?? Object.entries(config.targets).find(([, t]) => t.url && normalizeUrl(t.url) === url)?.[0] ?? targetNameFor(url);

    if (bool(args, "token-stdin")) {
      const token = (await readStdin()).trim();
      if (!/^pth_[a-f0-9]{64}$/.test(token)) throw new UsageError("standard input does not contain a Polyth token (pth_…)");
      writeConfig(saveToken(config, name, url, token, true));
      o.err(`${style.green(o.color, "✓")} Saved a token for ${name} (${url}).`);
      return verify(ctx, name);
    }

    const profile = str(args, "profile") ?? "control";
    const start = await postJson(`${url}/api/auth/cli/device`, { label: `polyth CLI on ${hostname()}`, profile });
    if (start.status !== 200) {
      const code = String(start.body.error ?? `http-${start.status}`);
      throw new PolythError(start.status, code, SERVER_ERRORS[code] ?? `The server refused to start a sign-in (${code}).`);
    }
    const deviceCode = String(start.body.deviceCode ?? "");
    const userCode = String(start.body.userCode ?? "");
    const interval = Math.max(1, Number(start.body.interval ?? 3));
    const expiresIn = Number(start.body.expiresIn ?? 600);
    const verification = String(start.body.verificationPath ?? "/?settings=command-line");
    const page = `${url}${verification}${verification.includes("?") ? "&" : "?"}code=${encodeURIComponent(userCode)}`;
    o.err(`Confirm this sign-in in Polyth:\n\n  ${style.bold(o.color, page)}\n\n  code ${style.bold(o.color, style.cyan(o.color, userCode))}  (${profile} access, expires in ${Math.round(expiresIn / 60)} min)\n`);
    if (!bool(args, "no-browser")) await openExternal(page).catch(() => {});
    o.err(style.dim(o.color, "Waiting for confirmation… (Ctrl+C to cancel)"));
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      const poll = await postJson(`${url}/api/auth/cli/device/token`, { deviceCode });
      if (poll.status === 200 && poll.body.status === "issued" && typeof poll.body.token === "string") {
        writeConfig(saveToken(ctx.config(), name, url, poll.body.token, true));
        o.err(`${style.green(o.color, "✓")} Signed in to ${name}. Token saved in ${configPath()}.`);
        return verify(ctx, name);
      }
      if (poll.status === 200) continue;
      if (poll.status === 403) throw new PolythError(403, "denied", "The sign-in was denied in Polyth.");
      if (poll.status === 410) throw new PolythError(410, "expired", "The sign-in expired. Run `polyth login` again.");
      if (poll.status >= 500 || poll.status === 0) continue;
      throw new PolythError(poll.status, String(poll.body.error ?? "error"), "The server rejected the sign-in.");
    }
    throw Object.assign(new Error("The sign-in code expired before it was confirmed."), { code: "timeout" });
  },
};

async function verify(ctx: Context, name: string): Promise<number> {
  const { url: _url, "data-dir": _dataDir, ...rest } = ctx.globals;
  const fresh = createContext(ctx.o, { ...rest, target: name });
  try {
    const me = await fresh.whoami();
    ctx.o.err(style.dim(ctx.o.color, `Acting as ${me.userId ?? "?"} in Space ${me.spaceId} with ${me.grants?.length ?? 0} permissions.`));
    return 0;
  } catch (error) {
    ctx.o.err(style.yellow(ctx.o.color, `Saved, but the first request failed: ${(error as Error).message}`));
    return 1;
  }
}

export const logout: Command = {
  name: "logout",
  summary: "Revoke this CLI's token on the server and forget it locally",
  usage: "polyth logout [--keep-target]",
  flags: [{ name: "keep-target", description: "Keep the server in `polyth target ls` (without a token)" }],
  async run(ctx, args) {
    const target = ctx.target();
    if (target.kind !== "http" || !target.token) {
      ctx.o.err("This target has no saved token.");
      return 0;
    }
    const result = await postJson(`${target.url}/api/auth/cli/logout`, {}, { authorization: `Bearer ${target.token}` }).catch(() => null);
    const config = ctx.config();
    const entry = config.targets[target.name];
    if (entry) {
      const { token: _token, ...rest } = entry;
      if (bool(args, "keep-target")) config.targets[target.name] = rest;
      else {
        delete config.targets[target.name];
        if (config.current === target.name) delete config.current;
      }
      writeConfig(config);
    }
    ctx.o.err(result?.body.ok === true
      ? `${style.green(ctx.o.color, "✓")} Token revoked and removed.`
      : "Token removed locally (the server did not confirm revocation; revoke it in Settings → Command line if it may still be valid).");
    return 0;
  },
};

export const whoami: Command = {
  name: "whoami",
  summary: "Show which server, account, Space and permissions this CLI uses",
  usage: "polyth whoami",
  async run(ctx) {
    const me = await ctx.whoami();
    if (ctx.o.json) { ctx.o.data({ target: describeTarget(ctx.target()), ...me }); return; }
    const o = ctx.o;
    const how = me.kind === "access-token" ? `${me.tokenKind} token`
      : me.trustedCli ? style.yellow(o.color, "no-token CLI mode (owner)")
        : me.kind === "internal-service" ? "control socket (operator)" : me.kind;
    o.out(`${style.bold(o.color, "Target")}      ${describeTarget(ctx.target())}`);
    o.out(`${style.bold(o.color, "Signed in")}   ${how}`);
    o.out(`${style.bold(o.color, "Account")}     ${me.userId ?? "-"}`);
    o.out(`${style.bold(o.color, "Space")}       ${me.spaceId}${me.pinnedSpace ? " (pinned)" : ""}`);
    o.out(`${style.bold(o.color, "Server")}      ${me.version} · ${me.deployment}`);
    if (me.grants) o.out(`${style.bold(o.color, "Permissions")} ${me.grants.join(", ")}`);
  },
};

export const target: Command = {
  name: "target",
  aliases: ["targets"],
  summary: "List, add, select or remove saved Polyth servers",
  usage: [
    "polyth target [ls]",
    "polyth target use NAME|desktop|local",
    "polyth target add NAME URL            # a server (then `polyth login`)",
    "polyth target add NAME --data-dir DIR # a local data directory (control socket)",
    "polyth target rm NAME",
  ].join("\n       "),
  flags: [{ name: "data-dir", value: true }],
  async run(ctx, args) {
    const [action = "ls", name, url] = args.positionals;
    const o = ctx.o;
    const config = readConfig();
    if (action === "ls" || action === "list") {
      const rows = Object.entries(config.targets).map(([n, t]) => [
        n === config.current ? style.green(o.color, `* ${n}`) : `  ${n}`,
        t.url ?? `${t.dataDir} (socket)`,
        t.dataDir ? "-" : t.token ? "token" : style.yellow(o.color, "none"),
      ]);
      rows.push([config.current ? "  desktop" : style.dim(o.color, "  desktop"), `${desktopDataDir()} (socket)`, "-"]);
      if (o.json) { o.data({ current: config.current ?? null, targets: Object.fromEntries(Object.entries(config.targets).map(([n, t]) => [n, { url: t.url ?? null, dataDir: t.dataDir ?? null, token: Boolean(t.token), space: t.space ?? null }])) }); return; }
      table(o, ["NAME", "WHERE", "AUTH"], rows, { flex: 1 });
      if (!config.current) o.out(style.dim(o.color, "\nNo default: the CLI looks for ./data, this checkout, then Polyth Desktop."));
      return;
    }
    if (action === "use") {
      if (!name) throw new UsageError("polyth target use NAME");
      if (name === "auto" || name === "none") delete config.current;
      else if (name === "desktop") {
        config.targets.desktop = { dataDir: desktopDataDir() };
        config.current = "desktop";
      } else if (!config.targets[name]) throw new UsageError(`no saved target "${name}"`);
      else config.current = name;
      writeConfig(config);
      o.err(`Default target: ${config.current ?? "auto-discovery"}`);
      return;
    }
    if (action === "add") {
      if (!name) throw new UsageError("polyth target add NAME URL | --data-dir DIR");
      // --data-dir is also a global option, so it may arrive either way.
      const dataDir = str(args, "data-dir") ?? (typeof ctx.globals["data-dir"] === "string" ? ctx.globals["data-dir"] : undefined);
      if (dataDir) config.targets[name] = { dataDir };
      else if (url) config.targets[name] = { ...config.targets[name], url: normalizeUrl(url) };
      else throw new UsageError("give a URL or --data-dir");
      writeConfig(config);
      o.err(`Saved ${name}.${url ? ` Sign in with: polyth login --name ${name} ${normalizeUrl(url)}` : ""}`);
      return;
    }
    if (action === "rm" || action === "remove") {
      if (!name || !config.targets[name]) throw new UsageError(`no saved target "${name ?? ""}"`);
      if (config.targets[name]!.token) o.err(style.yellow(o.color, "The token stays valid on the server; run `polyth logout` first to revoke it."));
      delete config.targets[name];
      if (config.current === name) delete config.current;
      writeConfig(config);
      return;
    }
    throw new UsageError(`unknown action "${action}"`);
  },
};
