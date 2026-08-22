// Dev-server preview per project: detect package manager + common scripts,
// observe announced loopback URLs, and reconcile them with newly-listening
// local sockets. Pure host logic — no HTTP routes and no session knowledge.
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

export const PREVIEW_SCRIPT_ORDER = ["dev", "start", "preview", "serve", "develop", "watch"] as const;
const PROBE_INTERVAL_MS = 250;
const STARTUP_TIMEOUT_MS = 60_000;
const LISTENER_FALLBACK_GRACE_MS = 1000;
const MAX_OUTPUT_CHARS = 32_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]"]);

export type PreviewPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface DetectedPreviewCommand {
  command: string;
  packageManager: PreviewPackageManager;
  script: string;
}

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

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

const managerFromPackage = (value: unknown): PreviewPackageManager | null => {
  if (typeof value !== "string") return null;
  const name = value.split("@")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
};

export async function detectPreviewCommand(cwd: string): Promise<DetectedPreviewCommand> {
  let pkg: { scripts?: Record<string, string>; packageManager?: string };
  try {
    pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as typeof pkg;
  } catch {
    throw Object.assign(new Error("no readable package.json; pass a command"), { code: "invalid-input" });
  }
  const script = PREVIEW_SCRIPT_ORDER.find((name) => typeof pkg.scripts?.[name] === "string");
  if (!script) {
    throw Object.assign(
      new Error(`no ${PREVIEW_SCRIPT_ORDER.join("/")} script in package.json; pass a command`),
      { code: "invalid-input" },
    );
  }
  const packageManager = managerFromPackage(pkg.packageManager)
    ?? await (async (): Promise<PreviewPackageManager> => {
      if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
      if (await exists(join(cwd, "yarn.lock"))) return "yarn";
      if (await exists(join(cwd, "bun.lock")) || await exists(join(cwd, "bun.lockb"))) return "bun";
      return "npm";
    })();
  const command = packageManager === "yarn"
    ? `yarn ${script}`
    : `${packageManager} run ${script}`;
  return { command, packageManager, script };
}

const normalizeAnnouncedUrl = (raw: string): string | null => {
  const cleaned = raw.replace(/[),.;]+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(hostname)) return null;
  const local = new URL(`${parsed.protocol}//127.0.0.1${parsed.port ? `:${parsed.port}` : ""}/`);
  local.pathname = parsed.pathname;
  local.search = parsed.search;
  local.hash = parsed.hash;
  return local.toString();
};

/** Extract only local URLs. LAN/network addresses are deliberately ignored:
 * preview discovery must never turn process output into an arbitrary fetch. */
export function parseAnnouncedUrls(output: string): string[] {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const found: string[] = [];
  const add = (raw: string) => {
    const normalized = normalizeAnnouncedUrl(raw);
    if (normalized && !found.includes(normalized)) found.push(normalized);
  };
  for (const match of plain.matchAll(/https?:\/\/(?:\[[^\]]+\](?::\d{2,5})?(?:\/[^\s"'<>]*)?|[^\s"'<>]+)/gi)) add(match[0]);
  for (const match of plain.matchAll(/(?:^|[\s(])((?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}(?:\/[^\s"'<>]*)?)/gim)) {
    add(match[1]!);
  }
  return found;
}

const PROC_LISTEN = "0A";
const PROC_LOCAL_ADDRESSES = new Set([
  "00000000",
  "0100007F",
  "00000000000000000000000000000000",
  "00000000000000000000000001000000",
]);

/** Parse loopback/wildcard LISTEN entries from Linux /proc socket tables. */
export function parseProcNetTcpListeners(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[3] !== PROC_LISTEN) continue;
    const [address, portHex] = (parts[1] ?? "").split(":");
    if (!address || !portHex || !PROC_LOCAL_ADDRESSES.has(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Parse `lsof -iTCP -sTCP:LISTEN -P -n -F n` socket names. */
export function parseLsofListeners(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("n")) continue;
    const value = line.slice(1).trim();
    if (!value || value.includes("->")) continue;
    const separator = value.lastIndexOf(":");
    if (separator < 0) continue;
    const host = value.slice(0, separator).toLowerCase();
    if (!LOCAL_HOSTS.has(host) && host !== "*" && host !== "[::]") continue;
    const port = Number.parseInt(value.slice(separator + 1), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

const lsofListeningPorts = (): Promise<Set<number>> =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "n"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(new Set());
      return;
    }
    let output = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new Set(parseLsofListeners(output)));
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish();
    }, 2500);
    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS);
    });
    child.once("error", finish);
    child.once("close", finish);
  });

async function listeningPorts(): Promise<Set<number>> {
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((path) => readFile(path, "utf8").catch(() => null)),
  );
  if (tables.some((table) => table !== null)) {
    return new Set(tables.flatMap((table) => table ? parseProcNetTcpListeners(table) : []));
  }
  return lsofListeningPorts();
}

export function mergePreviewUrls(input: {
  announced: readonly string[];
  listenerPorts: ReadonlySet<number>;
  baselinePorts: ReadonlySet<number>;
  expectedPort: number;
}): string[] {
  const urls: string[] = [];
  const add = (url: string) => { if (!urls.includes(url)) urls.push(url); };
  for (const announced of input.announced) {
    let port: number;
    try {
      const parsed = new URL(announced);
      port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    } catch {
      continue;
    }
    // Process output is only a hint. It must agree with a listener that
    // appeared after launch, otherwise a project could nominate an unrelated
    // pre-existing loopback service as its preview.
    if (input.listenerPorts.has(port) && !input.baselinePorts.has(port)) add(announced);
  }
  if (
    input.listenerPorts.has(input.expectedPort)
    && !input.baselinePorts.has(input.expectedPort)
  ) {
    add(`http://127.0.0.1:${input.expectedPort}/`);
  }
  const discovered = [...input.listenerPorts]
    .filter((port) => port !== input.expectedPort && !input.baselinePorts.has(port))
    .sort((a, b) => a - b);
  discovered.forEach((port) => add(`http://127.0.0.1:${port}/`));
  return urls;
}

export function createPreviewService(): PreviewService {
  interface PreviewRecord extends PreviewState {
    proc?: ChildProcess;
    probe?: NodeJS.Timeout;
    baselinePorts: Set<number>;
    announced: string[];
    output: string;
    checking: boolean;
  }
  const states = new Map<string, PreviewRecord>();
  const statusCbs = new Set<(projectId: string, state: PreviewState) => void>();

  const killGroup = (proc: ChildProcess, signal: NodeJS.Signals) => {
    if (proc.pid === undefined) return;
    if (process.platform !== "win32") {
      try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
    }
    try { proc.kill(signal); } catch { /* already gone */ }
  };

  const terminate = (proc: ChildProcess) => {
    killGroup(proc, "SIGTERM");
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) killGroup(proc, "SIGKILL");
    }, 1000);
    timer.unref?.();
    proc.once("exit", () => clearTimeout(timer));
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
      const detected = opts.command
        ? null
        : await detectPreviewCommand(opts.cwd);
      const command = opts.command ?? detected!.command;
      const port = opts.port ?? (await freePort());
      const url = `http://127.0.0.1:${port}/`;
      const baselinePorts = await listeningPorts();

      const proc = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        detached: process.platform !== "win32",
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const rec: PreviewRecord = {
        url,
        urls: [url],
        status: "starting",
        port,
        command,
        proc,
        baselinePorts,
        announced: [],
        output: "",
        checking: false,
      };
      states.set(projectId, rec);
      setStatus(projectId, "starting");

      const startedAt = Date.now();
      const reconcile = async () => {
        const current = states.get(projectId);
        if (!current?.proc || current.checking) return;
        current.checking = true;
        try {
          const ports = await listeningPorts();
          const urls = mergePreviewUrls({
            announced: current.announced,
            listenerPorts: ports,
            baselinePorts: current.baselinePorts,
            expectedPort: port,
          });
          for (const candidate of urls) {
            const candidatePort = Number(new URL(candidate).port || (candidate.startsWith("https:") ? 443 : 80));
            const announced = current.announced.includes(candidate);
            if (
              candidatePort !== port
              && !announced
              && Date.now() - startedAt < LISTENER_FALLBACK_GRACE_MS
            ) {
              continue;
            }
            if (!await portOpen(candidatePort)) continue;
            const nextPort = candidatePort;
            setStatus(projectId, "running", { url: candidate, urls, port: nextPort });
            stopProbe(projectId);
            return;
          }
          if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
            terminate(current.proc);
            setStatus(projectId, "off");
            stopProbe(projectId);
          }
        } finally {
          current.checking = false;
        }
      };
      const onOutput = (chunk: Buffer) => {
        const current = states.get(projectId);
        if (!current) return;
        current.output = `${current.output}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS);
        const announced = parseAnnouncedUrls(current.output);
        if (announced.some((candidate) => !current.announced.includes(candidate))) {
          current.announced = announced;
          const urls = mergePreviewUrls({
            announced,
            listenerPorts: new Set([current.port ?? port]),
            baselinePorts: current.baselinePorts,
            expectedPort: port,
          });
          current.urls = urls;
          for (const cb of statusCbs) cb(projectId, service.get(projectId));
          void reconcile();
        }
      };
      proc.stdout?.on("data", onOutput);
      proc.stderr?.on("data", onOutput);
      const probe = setInterval(() => void reconcile(), PROBE_INTERVAL_MS);
      probe.unref?.();
      rec.probe = probe;
      void reconcile();

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
        terminate(proc);
      }
      setStatus(projectId, "off", { proc: undefined });
      states.delete(projectId);
    },

    get(projectId) {
      const s = states.get(projectId);
      if (!s) return { url: null, status: "off" };
      return {
        url: s.url,
        status: s.status,
        ...(s.urls && s.urls.length > 0 ? { urls: [...s.urls] } : {}),
        ...(s.port !== undefined ? { port: s.port } : {}),
        ...(s.command ? { command: s.command } : {}),
      };
    },

    onStatusChange(cb) {
      statusCbs.add(cb);
      return { dispose: () => { statusCbs.delete(cb); } };
    },
  };

  return service;
}
