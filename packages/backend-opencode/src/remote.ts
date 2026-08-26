// Remote OpenCode runtime: run `opencode serve` ON the remote host over a
// generic RemoteHost transport (implemented by @polyth/ssh), then attach the
// normal adapter through ONE forwarded local port.
//
// Why serve-on-remote instead of a local agent over a remote filesystem: the
// agent's hot loop is file reads/edits/greps/shell — running it next to the
// working tree costs zero extra hops, while Polyth only pays one multiplexed
// control channel for the REST/SSE traffic it already speaks locally.
//
// This module owns everything OpenCode-specific about the remote leg (binary
// name, serve invocation, listen-line protocol, pidfile reaping); the
// transport knows nothing about OpenCode, keeping the adapter boundary intact.
import type { AgentRuntime, JsonObject, RemoteHost } from "@polyth/contracts";
import { createOpenCodeClient } from "./client.ts";
import { createOpenCodeRuntimeWithClient, LISTEN_RE, waitReady } from "./index.ts";

export interface RemoteOpenCodeOptions {
  host: RemoteHost;
  /** Workspace path on the remote machine (becomes the serve cwd). */
  remotePath: string;
  /** Remote opencode binary (default "opencode" on the remote PATH). */
  bin?: string;
  sessionIdMap?: Map<string, string>;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject) => void;
  listenTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Remote port candidate picker — injectable for tests. */
  pickPort?: () => number;
}

export interface RemoteOpenCodeProbe {
  ok: boolean;
  version?: string;
  message?: string;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

/** POSIX single-quote escaping (tiny local copy: no dependency on the
 *  transport package — the dependency direction is ssh → contracts ← here). */
const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const checkBin = (bin: string): string => {
  if (!/^[A-Za-z0-9_.~/-]+$/.test(bin)) throw invalid(`invalid remote binary name: ${bin}`);
  return bin;
};

const checkRemotePath = (path: string): string => {
  const p = path.trim();
  if (!p) throw invalid("remote path is required");
  if (/\p{Cc}/u.test(p)) throw invalid("remote path must not contain control characters");
  return p;
};

const shortHash = (value: string): string => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const PID_LINE_RE = /POLYTH_REMOTE_PID=(\d+)/;
const IN_USE_RE = /EADDRINUSE|address already in use/i;

/** Non-interactive SSH shells never source the rc files where the opencode
 *  installer appends its PATH entry, so a healthy install at ~/.opencode/bin
 *  (or ~/.local/bin) probes as "not installed" and every remote session start
 *  fails. Prefix each remote invocation with the standard install locations
 *  instead of trusting the login PATH. */
const REMOTE_PATH = 'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"';

/** Cheap capability probe: is the agent binary installed on the remote? */
export const probeRemoteOpenCode = async (
  host: RemoteHost,
  bin = "opencode",
): Promise<RemoteOpenCodeProbe> => {
  const safeBin = checkBin(bin);
  const result = await host.exec(
    `${REMOTE_PATH}; command -v ${safeBin} >/dev/null 2>&1 && ${safeBin} --version 2>/dev/null || echo POLYTH_OC_MISSING`,
    { timeoutMs: 20_000 },
  );
  const out = result.stdout.trim();
  if (result.code !== 0) {
    return { ok: false, message: `probe failed on ${host.label}: ${result.stderr.trim().slice(-300) || `exit ${result.code}`}` };
  }
  if (out.includes("POLYTH_OC_MISSING")) {
    return {
      ok: false,
      message: `opencode is not installed on ${host.label} — install it there first (curl -fsSL https://opencode.ai/install | bash)`,
    };
  }
  const version = out.split("\n").pop()?.trim();
  return { ok: true, ...(version ? { version } : {}) };
};

interface StartedServe {
  handle: Awaited<ReturnType<RemoteHost["start"]>>;
  port: number;
  remotePid: number | null;
  pidFileExpr: string;
}

const startServe = async (
  opts: Required<Pick<RemoteOpenCodeOptions, "host" | "remotePath">> & {
    bin: string; listenTimeoutMs: number; port: number;
  },
): Promise<StartedServe> => {
  const hash = shortHash(opts.remotePath);
  // Remote pidfile mirrors the local orphan-reaping pattern: a Polyth crash
  // leaves the remote serve running, so the NEXT start for the same workspace
  // kills its predecessor instead of leaking one process per restart.
  const pidFileExpr = `"\${XDG_CACHE_HOME:-$HOME/.cache}/polyth/serve-${hash}.pid"`;
  const command = [
    REMOTE_PATH,
    `PF=${pidFileExpr}`,
    'mkdir -p "$(dirname "$PF")"',
    '[ -f "$PF" ] && kill "$(cat "$PF")" 2>/dev/null',
    'echo "POLYTH_REMOTE_PID=$$"',
    'echo "$$" > "$PF"',
    `cd ${shq(opts.remotePath)} && exec ${opts.bin} serve --hostname 127.0.0.1 --port ${opts.port}`,
  ].join("; ");

  const handle = await opts.host.start(command);
  return new Promise<StartedServe>((resolve, reject) => {
    let buf = "";
    let settled = false;
    let remotePid: number | null = null;
    const finish = (err?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outputSub.dispose();
      exitSub.dispose();
      if (err) {
        void handle.kill().catch(() => {});
        reject(err);
      } else {
        resolve({ handle, port: port!, remotePid, pidFileExpr });
      }
    };
    const timer = setTimeout(
      () => finish(unavailable(`remote opencode serve did not report a listen address within ${opts.listenTimeoutMs}ms`)),
      opts.listenTimeoutMs,
    );
    const outputSub = handle.onOutput((chunk) => {
      buf += chunk;
      const pid = buf.match(PID_LINE_RE);
      if (pid) remotePid = Number(pid[1]);
      const listen = buf.match(LISTEN_RE);
      if (listen) finish(undefined, Number(listen[1]));
    });
    const exitSub = handle.onExit((code) => {
      const err = IN_USE_RE.test(buf)
        ? Object.assign(new Error(`remote port ${opts.port} is in use`), { code: "port-in-use" })
        : unavailable(`remote opencode serve exited (${code ?? "killed"}): ${buf.trim().slice(-400)}`);
      finish(err);
    });
  });
};

/** Spawn `opencode serve` on the remote host and return the standard adapter
 *  attached through a forwarded local port. Failure modes are explicit:
 *  missing binary and missing workspace path are reported before any process
 *  is started; port collisions retry with a fresh candidate. */
export const createRemoteOpenCodeRuntime = async (
  options: RemoteOpenCodeOptions,
): Promise<AgentRuntime> => {
  const { host } = options;
  const remotePath = checkRemotePath(options.remotePath);
  const bin = checkBin(options.bin ?? "opencode");
  const listenTimeoutMs = options.listenTimeoutMs ?? 30_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const pickPort = options.pickPort ?? (() => 20_000 + Math.floor(Math.random() * 45_000));

  const probe = await probeRemoteOpenCode(host, bin);
  if (!probe.ok) throw unavailable(probe.message ?? `opencode is unavailable on ${host.label}`);

  const dirCheck = await host.exec(`test -d ${shq(remotePath)}`, { timeoutMs: 20_000 });
  if (dirCheck.code !== 0) {
    throw Object.assign(
      new Error(`remote path does not exist on ${host.label}: ${remotePath}`),
      { code: "not-found" },
    );
  }

  let started: StartedServe | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    const port = pickPort();
    try {
      started = await startServe({ host, remotePath, bin, listenTimeoutMs, port });
    } catch (err) {
      lastError = err;
      if ((err as { code?: string }).code !== "port-in-use") throw err;
    }
  }
  if (!started) throw lastError ?? unavailable(`could not start opencode serve on ${host.label}`);
  const serve = started;

  const cleanupRemote = async (): Promise<void> => {
    const killPid = serve.remotePid ? `kill ${serve.remotePid} 2>/dev/null; ` : "";
    await host.exec(`PF=${serve.pidFileExpr}; ${killPid}rm -f "$PF"`, { timeoutMs: 10_000 }).catch(() => {});
    await serve.handle.kill().catch(() => {});
  };

  let forward: Awaited<ReturnType<RemoteHost["forward"]>>;
  try {
    forward = await host.forward(serve.port);
  } catch (err) {
    await cleanupRemote();
    throw err;
  }

  const client = createOpenCodeClient(`http://127.0.0.1:${forward.localPort}`, { directory: remotePath });
  try {
    await waitReady(client, readyTimeoutMs);
  } catch (err) {
    await cleanupRemote();
    await forward.dispose();
    throw unavailable(`remote opencode serve on ${host.label} did not become ready: ${err instanceof Error ? err.message : String(err)}`);
  }

  const runtime = createOpenCodeRuntimeWithClient(client, {
    cwd: remotePath,
    ...(options.sessionIdMap ? { sessionIdMap: options.sessionIdMap } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const innerDispose = runtime.dispose.bind(runtime);
  runtime.dispose = async () => {
    await innerDispose(); // stops the SSE stream (no local child to kill)
    await cleanupRemote();
    await forward.dispose();
  };
  return runtime;
};
