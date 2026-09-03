import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LinkHostClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  available: boolean;
  onEvent(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
}

const repoRoot = join(import.meta.dirname, "../../..");

export function findHostBinary(): string | null {
  const env = process.env.POLYTH_LINK_HOST;
  if (env && existsSync(env)) return env;
  for (const candidate of [
    join(repoRoot, "target/release/polyth-link-host"),
    join(repoRoot, "target/debug/polyth-link-host"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function startLinkHost(opts: { dataDir: string; socketPath: string }): Promise<LinkHostClient> {
  const binary = findHostBinary();
  if (!binary) {
    return {
      available: false,
      onEvent() { return () => {}; },
      async request() {
        throw Object.assign(new Error("Polyth Link host binary is not installed"), { code: "unavailable" });
      },
      async close() {},
    };
  }
  const child: ChildProcess = spawn(binary, ["serve", opts.dataDir, opts.socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (/secret|invite|hmac|private|token/i.test(text)) return;
    console.error("[polyth-link-host]", text.trim());
  });
  await waitForSocket(opts.socketPath, 12_000);
  const socket: Socket = await connectSocket(opts.socketPath);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: Record<string, unknown>;
          error?: { code?: string };
        };
        if (parsed.method === "event" && parsed.params && typeof parsed.params.type === "string") {
          for (const listener of listeners) listener(parsed.params as { type: string } & Record<string, unknown>);
          continue;
        }
        if (typeof parsed.id === "number") {
          const waiter = pending.get(parsed.id);
          if (!waiter) continue;
          pending.delete(parsed.id);
          if (parsed.error) {
            waiter.reject(Object.assign(new Error(parsed.error.code ?? "unavailable"), { code: parsed.error.code ?? "unavailable" }));
          } else {
            waiter.resolve(parsed.result ?? {});
          }
        }
      } catch {
        // ignore malformed control lines
      }
    }
  });
  socket.on("error", (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return {
    available: true,
    request,
    onEvent(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      socket.end();
      child.kill("SIGTERM");
    },
  };
}

export function randomIngressSecret(): string {
  return randomBytes(32).toString("hex");
}

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("polyth-link-host did not start"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
