import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { resolveHostBinary, type HostBinaryResolution } from "./hostBinary.ts";

export { findHostBinary, resolveHostBinary, hostExecutableName } from "./hostBinary.ts";
export type { HostBinaryResolution, HostBinaryLookup } from "./hostBinary.ts";

const RPC_TIMEOUT_MS = 15_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const MAX_MALFORMED_FRAMES = 32;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

export interface LinkHostClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  available: boolean;
  binaryFound: boolean;
  processReady: boolean;
  platformSupported: boolean;
  lastErrorCode?: string;
  onEvent(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
}

function unavailableHost(resolution: HostBinaryResolution): LinkHostClient {
  const lastErrorCode = resolution.ok ? "host-binary-missing" : resolution.reason === "unsupported-platform"
    ? "unsupported-platform"
    : "host-binary-missing";
  const message = lastErrorCode === "unsupported-platform"
    ? "Polyth Link is not supported on this platform"
    : "Polyth Link host binary is not installed";
  return {
    available: false,
    binaryFound: false,
    processReady: false,
    platformSupported: lastErrorCode !== "unsupported-platform",
    lastErrorCode,
    onEvent() { return () => {}; },
    async request() {
      throw Object.assign(new Error(message), { code: lastErrorCode });
    },
    async close() {},
  };
}

function unlinkSocket(path: string): void {
  try { unlinkSync(path); } catch { /* stale or missing */ }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startLinkHost(opts: { dataDir: string; socketPath: string }): Promise<LinkHostClient> {
  const resolved = resolveHostBinary();
  if (!resolved.ok) return unavailableHost(resolved);
  const binary = resolved.path;
  unlinkSocket(opts.socketPath);
  const child: ChildProcess = spawn(binary, ["serve", opts.dataDir, opts.socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.stdout?.resume();
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (/secret|invite|hmac|private|token/i.test(text)) return;
    console.error("[polyth-link-host]", text.trim());
  });
  const failedStart = async (code: string, error: unknown): Promise<LinkHostClient> => {
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
    unlinkSocket(opts.socketPath);
    return {
      available: false,
      binaryFound: true,
      processReady: false,
      platformSupported: true,
      lastErrorCode: code,
      onEvent() { return () => {}; },
      async request() {
        throw Object.assign(
          new Error(error instanceof Error ? error.message : "Polyth Link host failed to start"),
          { code },
        );
      },
      async close() {},
    };
  };
  try {
    await connectWhenReady(opts.socketPath, child, 12_000, () => spawnError);
  } catch (error) {
    return failedStart("host-start-failed", error);
  }
  let socket: Socket;
  try {
    socket = await connectSocket(opts.socketPath);
  } catch (error) {
    return failedStart("host-start-failed", error);
  }
  let nextId = 1;
  let closed = false;
  let runtimeAvailable = true;
  let runtimeReady = true;
  let runtimeError: string | undefined;
  let malformed = 0;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  let buf = "";
  const decoder = new StringDecoder("utf8");
  socket.on("data", (chunk) => {
    buf += decoder.write(chunk);
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_CONTROL_FRAME_BYTES) {
        socket.destroy(Object.assign(new Error("control frame too large"), { code: "unavailable" }));
        return;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: Record<string, unknown>;
          error?: { code?: string };
        };
        malformed = 0;
        if (parsed.method === "event" && parsed.params && typeof parsed.params.type === "string") {
          for (const listener of listeners) listener(parsed.params as { type: string } & Record<string, unknown>);
          continue;
        }
        if (typeof parsed.id === "number") {
          const waiter = pending.get(parsed.id);
          if (!waiter) continue;
          pending.delete(parsed.id);
          clearTimeout(waiter.timer);
          if (parsed.error) {
            waiter.reject(Object.assign(new Error(parsed.error.code ?? "unavailable"), { code: parsed.error.code ?? "unavailable" }));
          } else {
            waiter.resolve(parsed.result ?? {});
          }
        }
      } catch {
        malformed += 1;
        if (malformed >= MAX_MALFORMED_FRAMES) {
          socket.destroy(Object.assign(new Error("malformed control frame"), { code: "unavailable" }));
        }
      }
    }
    if (Buffer.byteLength(buf) > MAX_CONTROL_FRAME_BYTES) {
      socket.destroy(Object.assign(new Error("control frame too large"), { code: "unavailable" }));
    }
  });
  const onDead = (error: Error) => {
    if (!closed) {
      runtimeAvailable = false;
      runtimeReady = false;
      runtimeError = "host-process-unavailable";
      if (child.exitCode == null && !child.signalCode) child.kill("SIGTERM");
    }
    rejectPending(error);
  };
  socket.on("error", (error) => onDead(error));
  socket.on("end", () => onDead(Object.assign(new Error("host control socket ended"), { code: "unavailable" })));
  socket.on("close", () => onDead(Object.assign(new Error("host control socket closed"), { code: "unavailable" })));
  child.on("error", onDead);
  child.on("exit", () => onDead(Object.assign(new Error("polyth-link-host exited"), { code: "unavailable" })));
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (closed || !runtimeAvailable || socket.destroyed) {
        reject(Object.assign(new Error("host control is closed"), { code: "unavailable" }));
        return;
      }
      const frame = `${JSON.stringify({ id: nextId, method, params })}\n`;
      if (Buffer.byteLength(frame) > MAX_CONTROL_FRAME_BYTES) {
        reject(Object.assign(new Error("host RPC frame too large"), { code: "invalid-input" }));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`host RPC timed out: ${method}`), { code: "unavailable" }));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.write(frame);
    });
  try {
    await request("identity.status");
  } catch (error) {
    socket.destroy();
    return failedStart("host-start-failed", error);
  }
  return {
    get available() { return runtimeAvailable; },
    binaryFound: true,
    get processReady() { return runtimeReady; },
    platformSupported: true,
    get lastErrorCode() { return runtimeError; },
    request,
    onEvent(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      if (closed) return;
      closed = true;
      runtimeAvailable = false;
      runtimeReady = false;
      rejectPending(Object.assign(new Error("host control is closed"), { code: "unavailable" }));
      socket.end();
      socket.destroy();
      child.kill("SIGTERM");
      await waitForExit(child, CHILD_EXIT_TIMEOUT_MS);
      if (child.exitCode == null && !child.signalCode) child.kill("SIGKILL");
      await waitForExit(child, 1_000);
      unlinkSocket(opts.socketPath);
    },
  };
}

export function randomIngressSecret(): string {
  return randomBytes(32).toString("hex");
}

async function connectWhenReady(
  path: string,
  child: ChildProcess,
  timeoutMs: number,
  childError: () => Error | undefined,
): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    const error = childError();
    if (error) throw error;
    if (child.exitCode != null || child.signalCode) {
      throw new Error("polyth-link-host exited before the control socket was ready");
    }
    if (Date.now() - started > timeoutMs) throw new Error("polyth-link-host did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
