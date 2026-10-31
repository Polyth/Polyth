import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { bool, int, str, UsageError } from "../args.ts";
import { listProjects, resolveProject, session, summaries, type WhoAmI } from "../api.ts";
import { PolythError } from "../client.ts";
import type { Command, Context } from "../context.ts";
import { oneLine, style, table } from "../output.ts";
import { openExternal, readStdin } from "../system.ts";
import { describeTarget, desktopDataDir, repoRoot, type Target } from "../target.ts";

export const status: Command = {
  name: "status",
  summary: "Which Polyth this CLI uses, and what is running",
  usage: "polyth status",
  async run(ctx) {
    const o = ctx.o;
    const client = ctx.client();
    const health = await client.get<{ version: string; capabilities?: string[] }>("/api/health");
    let me: WhoAmI | null = null;
    let meError = "";
    try { me = await ctx.whoami(); } catch (error) { meError = (error as Error).message; }
    let working = 0, waiting = 0, total = 0;
    if (me) {
      const page = await summaries(client, { limit: 200 }).catch(() => null);
      for (const s of page?.sessions ?? []) {
        total += 1;
        if (s.status === "working" || s.status === "reconciling") working += 1;
        if ((s.attention?.permissions ?? 0) + (s.attention?.questions ?? 0) > 0 || s.status === "waiting") waiting += 1;
      }
    }
    if (o.json) { o.data({ target: describeTarget(ctx.target()), version: health.version, whoami: me, sessions: { recent: total, working, waiting } }); return; }
    o.out(`${style.green(o.color, "●")} ${style.bold(o.color, "Polyth")} ${health.version} — ${describeTarget(ctx.target())}`);
    if (me) {
      const how = me.kind === "access-token" ? `${me.tokenKind} token (${me.grants?.length ?? 0} permissions)`
        : me.trustedCli ? "no-token CLI mode" : me.kind === "internal-service" ? "control socket" : me.kind;
      o.out(`  as ${me.userId ?? "operator"} · Space ${me.spaceId} · ${how} · ${me.deployment}`);
      o.out(`  ${working} working, ${waiting} waiting for you (of ${total} recent sessions)`);
    } else {
      o.out(style.yellow(o.color, `  not signed in: ${meError}`));
    }
  },
};

export const projects: Command = {
  name: "projects",
  aliases: ["project"],
  summary: "List, add or remove projects",
  usage: "polyth projects [ls]\n       polyth projects add PATH [--name NAME]\n       polyth projects create PATH [--name NAME]\n       polyth projects rm PROJECT",
  flags: [{ name: "name", value: true }],
  async run(ctx, args) {
    const client = ctx.client();
    const [action = "ls", value] = args.positionals;
    const o = ctx.o;
    if (action === "ls" || action === "list") {
      const list = await listProjects(client);
      if (o.json) { o.data(list); return; }
      if (!list.length) { o.err("No projects yet: polyth projects add <path>"); return; }
      const here = await resolveProject(client, undefined).catch(() => undefined);
      table(o, ["", "ID", "NAME", "PATH"], list.map((p) => [
        p.id === here?.id ? style.green(o.color, "*") : " ", style.dim(o.color, p.id.slice(0, 8)), p.name, p.path,
      ]), { flex: 3 });
      return;
    }
    if (action === "add" || action === "create") {
      if (!value) throw new UsageError(`polyth projects ${action} PATH`);
      const path = ctx.target().kind === "socket" ? resolve(value) : value;
      const created = await client.post<{ id: string; name: string }>(action === "add" ? "/api/projects" : "/api/projects/create", {
        path, ...(str(args, "name") ? { name: str(args, "name") } : {}),
      });
      if (o.json) o.data(created);
      else o.err(`${style.green(o.color, "✓")} ${created.name} (${created.id})`);
      return;
    }
    if (action === "rm" || action === "remove") {
      const project = await resolveProject(client, value);
      await client.request("DELETE", `/api/projects/${encodeURIComponent(project.id)}`);
      o.err(`${style.green(o.color, "✓")} removed ${project.name} from Polyth (files are untouched)`);
      return;
    }
    throw new UsageError(`unknown action "${action}"`);
  },
};

export const models: Command = {
  name: "models",
  summary: "List enabled models (provider/model ids for --model)",
  usage: "polyth models [-q TEXT]",
  flags: [{ name: "query", short: "q", value: true }],
  async run(ctx, args) {
    const raw = await ctx.client().get<unknown>("/api/models");
    const list = (Array.isArray(raw) ? raw : (raw as { models?: unknown[] }).models ?? []) as Array<Record<string, unknown>>;
    const q = str(args, "query")?.toLowerCase();
    const rows = list
      .map((m) => ({ id: `${m.providerID ?? m.provider}/${m.modelID ?? m.id}`, name: String(m.name ?? m.modelID ?? m.id ?? ""), harness: String(m.harnessId ?? m.harness ?? "") }))
      .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (ctx.o.json) { ctx.o.data(rows); return; }
    table(ctx.o, ["MODEL", "NAME", "HARNESS"], rows.map((m) => [m.id, m.name, m.harness]), { flex: 1 });
  },
};

export const api: Command = {
  name: "api",
  summary: "Call any Polyth /api route (prints JSON)",
  usage: "polyth api [METHOD] PATH [-d JSON | -d @file | -d -]",
  details: "Examples:\n  polyth api /api/sessions/summaries?limit=5\n  polyth api POST /api/sessions/ID/abort -d '{\"source\":\"cli\"}'",
  flags: [{ name: "data", short: "d", value: true, description: "JSON body, @file, or - for stdin" }],
  async run(ctx, args) {
    let [method = "GET", path] = args.positionals;
    if (!path) { path = method; method = "GET"; }
    method = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new UsageError("METHOD must be GET, POST, PUT, PATCH or DELETE");
    if (!path?.startsWith("/api/")) throw new UsageError("PATH must start with /api/");
    const data = str(args, "data");
    let body: unknown;
    if (data !== undefined) {
      const text = data === "-" ? await readStdin() : data.startsWith("@") ? readFileSync(data.slice(1), "utf8") : data;
      try { body = JSON.parse(text); } catch { throw new UsageError("--data is not valid JSON"); }
    }
    const result = await ctx.client().request(method as "GET", path, body === undefined ? {} : { body });
    ctx.o.data(result);
  },
};

function webOrigin(target: Target): string | undefined {
  if (target.kind === "http") return target.url;
  if (process.env.POLYTH_PUBLIC_ORIGIN) return process.env.POLYTH_PUBLIC_ORIGIN.replace(/\/$/, "");
  return undefined;
}

const isDesktop = (target: Target): boolean => target.kind === "socket" && resolve(target.dataDir || ".") === resolve(desktopDataDir());

/** Show a session in Polyth: the desktop window, or the web UI in a browser. */
export async function openSessionUi(ctx: Context, sessionId?: string): Promise<void> {
  const target = ctx.target();
  let path = "/";
  if (sessionId) {
    const s = await session(ctx.client(), sessionId);
    path = `/p/${encodeURIComponent(s.projectId)}/s/${encodeURIComponent(s.id)}`;
  }
  if (isDesktop(target) && process.env.POLYTH_DESKTOP_EXECUTABLE) {
    // The running desktop instance receives this through its single-instance
    // handoff and navigates its own window; no browser credential involved.
    const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
    const child = spawn(process.env.POLYTH_DESKTOP_EXECUTABLE, [`--polyth-open=${path}`], { detached: true, stdio: "ignore", env });
    child.unref();
    ctx.o.err(`Opening in Polyth Desktop: ${path}`);
    return;
  }
  const origin = webOrigin(target);
  if (!origin) {
    ctx.o.out(path);
    ctx.o.err(style.dim(ctx.o.color, "Set POLYTH_PUBLIC_ORIGIN (or use a URL target) so the CLI knows this server's web address."));
    return;
  }
  const url = `${origin}${path}`;
  if (!(await openExternal(url))) ctx.o.out(url);
}

export const open: Command = {
  name: "open",
  summary: "Open a session (or Polyth) in the desktop app or browser",
  usage: "polyth open [SESSION]",
  async run(ctx, args) {
    const { resolveSessionId } = await import("../api.ts");
    const id = args.positionals[0] ? await resolveSessionId(ctx.client(), args.positionals[0]) : undefined;
    await openSessionUi(ctx, id);
  },
};

// ---- local server administration (control-socket targets only) -----------

function localServer(ctx: Context): { dataDir: string; root: string | undefined } {
  const target = ctx.target();
  if (target.kind !== "socket") throw new UsageError("`polyth server` manages a Polyth on this machine; it does not work with a URL target");
  if (isDesktop(target)) throw new UsageError("Polyth Desktop manages its own server; use the app (tray → Restart) instead");
  return { dataDir: target.dataDir, root: repoRoot() };
}

const runIn = (cwd: string, command: string, args: string[]) => new Promise<number>((resolveExit) => {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); resolveExit(127); });
  child.on("exit", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
});

async function tailFile(path: string, lines: number, follow: boolean, signal: AbortSignal): Promise<void> {
  const size = statSync(path).size;
  const start = Math.max(0, size - Math.max(4096, lines * 400));
  const text = await new Promise<string>((res, rej) => {
    const chunks: Buffer[] = [];
    createReadStream(path, { start }).on("data", (c) => chunks.push(c as Buffer)).on("end", () => res(Buffer.concat(chunks).toString("utf8"))).on("error", rej);
  });
  process.stdout.write(`${text.split("\n").slice(-lines - 1).join("\n")}`);
  if (!follow) return;
  let offset = size;
  await new Promise<void>((done) => {
    const watcher = watch(path, () => {
      const next = statSync(path).size;
      if (next < offset) offset = 0;
      if (next === offset) return;
      createReadStream(path, { start: offset, end: next - 1 }).pipe(process.stdout, { end: false });
      offset = next;
    });
    signal.addEventListener("abort", () => { watcher.close(); done(); }, { once: true });
  });
}

export const server: Command = {
  name: "server",
  summary: "Manage the Polyth server on this machine (status, logs, restart, setup)",
  usage: [
    "polyth server status",
    "polyth server logs [-f] [-n LINES]",
    "polyth server start                 # foreground, from a server checkout",
    "polyth server restart               # drain-aware: waits for running turns",
    "polyth server setup-claim           # one-time claim for first-run setup",
    "polyth server break-glass           # reset an owner password (interactive)",
  ].join("\n       "),
  flags: [
    { name: "follow", short: "f" },
    { name: "lines", short: "n", value: true },
  ],
  async run(ctx, args) {
    const [action = "status"] = args.positionals;
    const { dataDir, root } = localServer(ctx);
    const o = ctx.o;
    const needRoot = () => {
      if (!root) throw new UsageError("run this from a Polyth server checkout (the CLI inside packages/cli)");
      return root;
    };
    switch (action) {
      case "status": {
        const target = ctx.target();
        let health = "not running";
        try {
          const h = await ctx.client().get<{ version: string }>("/api/health");
          health = `running ${h.version}`;
        } catch (error) {
          if (!(error instanceof PolythError) || error.code !== "unreachable") throw error;
        }
        if (o.json) { o.data({ dataDir, socket: target.kind === "socket" ? target.socketPath : null, health, checkout: root ?? null }); return 0; }
        o.out(`${style.bold(o.color, "Server")}    ${health}`);
        o.out(`${style.bold(o.color, "Data")}      ${dataDir}`);
        if (target.kind === "socket") o.out(`${style.bold(o.color, "Socket")}    ${target.socketPath}`);
        if (root) o.out(`${style.bold(o.color, "Checkout")}  ${root}`);
        return 0;
      }
      case "logs": {
        const file = join(dataDir, "server.log");
        if (!existsSync(file)) throw new UsageError(`no log file at ${file} (the server may log to its terminal or journal)`);
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        await tailFile(file, int(args, "lines", 100, 1, 100_000), bool(args, "follow"), controller.signal);
        return 0;
      }
      case "start": return runIn(needRoot(), "npm", ["start"]);
      case "restart": return runIn(needRoot(), "npm", ["run", "polyth:restart"]);
      case "setup-claim": return runIn(needRoot(), "npm", ["run", "setup:claim"]);
      case "break-glass": return runIn(needRoot(), "npm", ["run", "auth:break-glass"]);
      default: throw new UsageError(`unknown action "${action}"`);
    }
  },
};

export function oneLineError(error: unknown): string {
  return oneLine((error as Error)?.message ?? String(error));
}
