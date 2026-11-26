// One `polyth-link-client` process, spoken to over JSON lines on stdin/stdout:
// `{id, method, params}` in, `{id, result}` or `{id, error: {code}}` out.
// It holds one person's device keys, so it gets none of the server's secrets.
// A process that ends is started again by the next request; deciding when to
// ask again (backoff) belongs to the caller.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** How long one request may take. A pairing waits for a person on the other server. */
const RPC_TIMEOUT_MS: Readonly<Record<string, number>> = {
  "pairing.confirm": 130_000,
  connect: 25_000,
};
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** Closing stdin ends the client; it closes its sessions within two seconds. */
const EXIT_GRACE_MS = 3_000;
/** No answer comes near this; a line that does is a broken client, not data. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

const failure = (code: string): Error => Object.assign(new Error(code), { code });

export interface ClientBinaryLookup {
  platform?: string;
  env?: Record<string, string | undefined>;
  resourcesDir?: string;
  repoRoot?: string;
  exists?: (path: string) => boolean;
}

/** Resolve the `polyth-link-client` executable: the `POLYTH_LINK_CLIENT`
 *  override, a packaged `<resources>/polyth-link/` copy, then a local build. */
export function resolveClientBinary(opts: ClientBinaryLookup = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const name = platform === "win32" ? "polyth-link-client.exe" : "polyth-link-client";
  const override = env.POLYTH_LINK_CLIENT?.trim();
  if (override && exists(override)) return override;
  const resourcesDir = opts.resourcesDir
    ?? env.POLYTH_RESOURCES_DIR
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const root = opts.repoRoot ?? join(import.meta.dirname, "../../..");
  const candidates = [
    ...(resourcesDir ? [join(resourcesDir, "polyth-link", name)] : []),
    join(root, "target", "release", name),
    join(root, "target", "debug", name),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The variables the client needs to run, resolve names and reach a proxy. It
 *  holds no provider credentials and has no use for the server's settings. */
export function linkClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  const allowed = /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_[A-Z]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|(?:HTTPS?|ALL|NO)_PROXY|RUST_LOG)$/i;
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && allowed.test(name)) kept[name] = value;
  }
  return kept;
}

export interface LinkClientProcess {
  invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Runs when the process ends without `close()`, with how long it lived. */
  onExit(listener: (livedMs: number) => void): void;
  /** Resolves once the process is gone. The object cannot be used again. */
  close(): Promise<void>;
}

export function createLinkClientProcess(options: {
  binary: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): LinkClientProcess {
  const exitListeners = new Set<(livedMs: number) => void>();
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  type Child = ReturnType<typeof spawn> & { stdin: Writable; stdout: Readable; stderr: Readable };
  let child: Child | null = null;
  let closed = false;
  let nextId = 0;

  const rejectPending = (code: string): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure(code));
    }
    pending.clear();
  };

  const handleLine = (line: string): void => {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message?.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(failure(String(message.error.code ?? "link-client-error")));
    else request.resolve(message.result);
  };

  const launch = (): Child => {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    const started = spawn(options.binary, ["stdio", options.dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: linkClientEnv(options.env ?? process.env),
      windowsHide: true,
    }) as Child;
    const ended = (): void => {
      if (child !== started) return;
      child = null;
      rejectPending(closed ? "link-client-closed" : "link-client-exited");
      if (closed) return;
      for (const listener of [...exitListeners]) listener(Date.now() - startedAt);
    };
    child = started;
    started.once("error", ended);
    started.once("exit", ended);
    // A broken pipe surfaces as an exit; it must not become an uncaught error.
    started.stdin.on("error", () => {});
    // Drained, never logged: its lines may name the other server.
    started.stderr.resume();
    let buffer = "";
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
      if (buffer.length > MAX_LINE_CHARS) {
        buffer = "";
        started.kill("SIGKILL");
      }
    });
    return started;
  };

  return {
    async invoke<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) throw failure("link-client-closed");
      const target = child ?? launch();
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure("link-client-timeout"));
        }, RPC_TIMEOUT_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        target.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    onExit(listener) {
      exitListeners.add(listener);
    },
    async close() {
      closed = true;
      const target = child;
      if (!target || target.exitCode !== null || target.signalCode !== null) {
        rejectPending("link-client-closed");
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => target.kill("SIGKILL"), EXIT_GRACE_MS);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        target.once("exit", done);
        target.once("error", done);
        target.stdin.end();
      });
    },
  };
}
