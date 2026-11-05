import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

/** How long one request may take. A pairing waits for a person on the other computer. */
const RPC_TIMEOUT_MS: Readonly<Record<string, number>> = {
  "pairing.confirm": 130_000,
  connect: 25_000,
  "connection.recover": 25_000,
};
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** Closing stdin ends the client; it closes its sessions within two seconds. */
const EXIT_GRACE_MS = 3_000;
/** No answer comes near this; a line that does is a broken client, not data. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

const failure = (code: string): Error => Object.assign(new Error(code), { code });

interface OwnedProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface PolythLinkClientOptions {
  binary: string;
  dataDir: string;
  /** The shell the local proxy serves. */
  webDist: string;
  /** Package bundles, laid out as `<id>/dist/web` (a desktop build keeps them apart from the shell). */
  packagesDir: string;
  env?: NodeJS.ProcessEnv;
  log?(message: string, error?: unknown): void;
  /** Tests supply a fake process. */
  start?(binary: string, args: string[], env: NodeJS.ProcessEnv): OwnedProcess;
}

export interface PolythLinkClient {
  invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Runs when the process ends without `close()`. */
  onExit(listener: () => void): () => void;
  close(): Promise<void>;
}

/** The variables the client needs to run, resolve names and reach a proxy. It
 *  holds no provider credentials and has no use for the app's other settings. */
export function linkClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  const allowed = /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_[A-Z]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|(?:HTTPS?|ALL|NO)_PROXY|RUST_LOG)$/i;
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && allowed.test(name)) kept[name] = value;
  }
  return kept;
}

/**
 * The one `polyth-link-client` process this app owns, started on first use and
 * spoken to over JSON lines on stdin/stdout, the same on Windows, macOS and
 * Linux. No socket exists on disk, and when this process dies by any means its
 * stdin closes, which ends the client. A client that exits on its own is started
 * again by the next request; the sessions it held are gone, so callers reconnect.
 */
export function createPolythLinkClient(options: PolythLinkClientOptions): PolythLinkClient {
  const start = options.start ?? ((binary, args, env) =>
    spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true }));
  const exitListeners = new Set<() => void>();
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let child: OwnedProcess | null = null;
  let starting: Promise<OwnedProcess> | null = null;
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
    if (!line.trim()) return;
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      options.log?.("Ignoring a line from polyth-link-client that is not JSON");
      return;
    }
    const request = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!request) return;
    pending.delete(message.id as number);
    clearTimeout(request.timer);
    if (message.error) request.reject(failure(String(message.error.code ?? "link-client-error")));
    else request.resolve(message.result);
  };

  const launch = async (): Promise<OwnedProcess> => {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...linkClientEnv(options.env ?? process.env),
      POLYTH_WEB_DIST: options.webDist,
      POLYTH_WEB_PACKAGES_DIR: options.packagesDir,
    };
    const process_ = start(options.binary, ["stdio", options.dataDir], env);
    const ended = (reason: string): void => {
      if (child !== process_) return;
      child = null;
      rejectPending(closed ? "link-client-closed" : "link-client-exited");
      if (closed) return;
      options.log?.(`polyth-link-client ended (${reason})`);
      for (const listener of [...exitListeners]) listener();
    };
    child = process_;
    process_.once("error", (error) => {
      options.log?.("polyth-link-client failed to run", error);
      ended("spawn error");
    });
    process_.once("exit", (code, signal) => ended(String(code ?? signal ?? "unknown")));
    // A broken pipe surfaces as an exit; it must not become an uncaught error.
    process_.stdin.on("error", (error) => options.log?.("polyth-link-client stdin", error));
    process_.stderr.on("data", (chunk) => options.log?.(`polyth-link-client: ${String(chunk).trimEnd()}`));
    let buffer = "";
    process_.stdout.setEncoding("utf8");
    process_.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
      if (buffer.length > MAX_LINE_CHARS) {
        options.log?.("polyth-link-client sent an oversized line; stopping it");
        buffer = "";
        process_.kill();
      }
    });
    return process_;
  };

  const running = async (): Promise<OwnedProcess> => {
    if (closed) throw failure("link-client-closed");
    if (child) return child;
    starting ??= launch().finally(() => { starting = null; });
    return starting;
  };

  return {
    async invoke<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const target = await running();
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
      return () => { exitListeners.delete(listener); };
    },
    async close() {
      if (closed) return;
      closed = true;
      await starting?.catch(() => undefined);
      const target = child;
      if (!target || target.exitCode !== null) {
        rejectPending("link-client-closed");
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          target.kill("SIGKILL");
          resolve();
        }, EXIT_GRACE_MS);
        timer.unref?.();
        target.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        target.stdin.end();
      });
    },
  };
}
