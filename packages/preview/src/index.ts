// Dev-server preview per project: detect a script (dev > start > serve) from
// package.json, spawn it on a free port (passed via PORT env), report
// off/starting/running. Pure host logic — no HTTP, no session knowledge.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import type { Disposable, PreviewState, PreviewStatus } from "@polyth/contracts";

export interface PreviewStartOptions {
  cwd: string;
  /** shell command; omitted = detect from package.json scripts (dev > start > serve) */
  command?: string;
  /** explicit port; omitted = OS-assigned free port */
  port?: number;
}

export interface PreviewService {
  start(projectId: string, opts: PreviewStartOptions): Promise<{ url: string; port: number }>;
  stop(projectId: string): Promise<void>;
  get(projectId: string): PreviewState;
  onStatusChange(cb: (projectId: string, state: PreviewState) => void): Disposable;
}

const SCRIPT_ORDER = ["dev", "start", "serve"] as const;
const PROBE_INTERVAL_MS = 250;
const STARTUP_TIMEOUT_MS = 60_000;

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });

const portOpen = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    probe.once("connect", () => { probe.destroy(); res(true); });
    probe.once("error", () => { probe.destroy(); res(false); });
    probe.setTimeout(2000, () => { probe.destroy(); res(false); });
  });

/** package.json "dev" -> `npm run dev`; custom commands run as-is */
async function detectScript(cwd: string, command?: string): Promise<string> {
  if (command) return command;
  let scripts: Record<string, string> | undefined;
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts;
  } catch { /* not a node project */ }
  if (scripts) {
    for (const name of SCRIPT_ORDER) if (scripts[name]) return `npm run ${name}`;
  }
  throw Object.assign(new Error("no dev/start/serve script in package.json; pass a command"), { code: "invalid-input" });
}

export function createPreviewService(): PreviewService {
  const states = new Map<string, PreviewState & { proc?: ChildProcess; probe?: NodeJS.Timeout }>();
  const statusCbs = new Set<(projectId: string, state: PreviewState) => void>();

  const killGroup = (proc: ChildProcess, signal: NodeJS.Signals) => {
    if (proc.pid === undefined) return;
    try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
    try { proc.kill(signal); } catch { /* already gone */ }
  };

  const stopProbe = (projectId: string) => {
    const cur = states.get(projectId);
    if (cur?.probe) { clearInterval(cur.probe); cur.probe = undefined; }
  };

  const setStatus = (projectId: string, status: PreviewStatus, extra: Partial<PreviewState> | { proc?: undefined } = {}) => {
    const cur = states.get(projectId);
    if (!cur) return;
    cur.status = status;
    Object.assign(cur, extra);
    for (const cb of statusCbs) cb(projectId, service.get(projectId));
  };

  const service: PreviewService = {
    async start(projectId, opts) {
      const existing = states.get(projectId);
      if (existing && (existing.status === "starting" || existing.status === "running")) {
        return { url: existing.url!, port: existing.port! };
      }
      const command = await detectScript(opts.cwd, opts.command);
      const port = opts.port ?? (await freePort());
      const url = `http://127.0.0.1:${port}`;

      // ponytail: status flips to "running" via a TCP probe loop. If a server
      // binds a different port than PORT (misbehaving framework), it stays
      // "starting" until the process exits. Upgrade: parse the child's output
      // for a bound port, or shell out to `ss` once.
      const proc = spawn(command, { cwd: opts.cwd, shell: true, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
      const rec: PreviewState & { proc?: ChildProcess; probe?: NodeJS.Timeout } = { url, status: "starting", port, command, proc };
      states.set(projectId, rec);
      setStatus(projectId, "starting");

      const startedAt = Date.now();
      const probe = setInterval(async () => {
        if (!states.get(projectId)?.proc) return; // stopped
        if (await portOpen(port)) {
          setStatus(projectId, "running");
          stopProbe(projectId);
          return;
        }
        if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
          setStatus(projectId, "off");
          stopProbe(projectId);
        }
      }, PROBE_INTERVAL_MS);
      rec.probe = probe;

      proc.on("exit", () => {
        // keep a dead "running" preview visible as off
        setStatus(projectId, "off");
        stopProbe(projectId);
      });
      proc.on("error", () => { setStatus(projectId, "off"); stopProbe(projectId); });
      return { url, port };
    },

    async stop(projectId) {
      const s = states.get(projectId);
      if (!s) return;
      const proc = s.proc;
      stopProbe(projectId);
      if (proc && proc.pid !== undefined) {
        killGroup(proc, "SIGTERM");
        setTimeout(() => killGroup(proc, "SIGKILL"), 1000);
      }
      setStatus(projectId, "off", { proc: undefined });
      states.delete(projectId);
    },

    get(projectId) {
      const s = states.get(projectId);
      if (!s) return { url: null, status: "off" };
      return { url: s.url, status: s.status, ...(s.port !== undefined ? { port: s.port } : {}), ...(s.command ? { command: s.command } : {}) };
    },

    onStatusChange(cb) {
      statusCbs.add(cb);
      return { dispose: () => { statusCbs.delete(cb); } };
    },
  };

  return service;
}
