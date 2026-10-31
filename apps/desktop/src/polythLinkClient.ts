import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

const CONNECT_RETRY_MS = 50;
const CONNECT_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 30_000;

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface PolythLinkPairingPreview {
  hostLabel: string;
  hostFingerprint: string;
  expiresAt: string;
}

export interface PolythLinkPairingAttempt {
  attemptId: string;
  safetyPhrase?: string[];
  state: string;
}

export interface PolythLinkConnection {
  connectionId: string;
  origin: string;
  bootstrapUrl: string;
}

export interface PolythLinkClientManager {
  invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  parsePairingTicket(ticket: string): Promise<PolythLinkPairingPreview>;
  beginPairing(ticket: string, label: string): Promise<PolythLinkPairingAttempt>;
  confirmPairing(attemptId: string): Promise<PolythLinkConnection>;
  cancelPairing(attemptId: string): Promise<void>;
  connections(): Promise<unknown[]>;
  connect(connectionId: string): Promise<PolythLinkConnection>;
  recover(connectionId: string): Promise<unknown>;
  status(connectionId: string): Promise<unknown>;
  disconnect(connectionId: string): Promise<void>;
  forget(connectionId: string): Promise<void>;
  onEvent(cb: (event: unknown) => void): { dispose(): void };
  close(): Promise<void>;
}

export async function startPolythLinkClientManager(input: {
  binary: string;
  dataDir: string;
  socketPath: string;
  webDist?: string;
  log?(message: string, error?: unknown): void;
}): Promise<PolythLinkClientManager> {
  if (process.platform === "win32") throw err("unsupported", "Desktop Polyth Link client IPC requires Unix sockets");
  await mkdir(dirname(input.socketPath), { recursive: true });
  await rm(input.socketPath, { force: true }).catch(() => {});

  const child = spawn(input.binary, ["serve", input.dataDir, input.socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(input.webDist ? { POLYTH_WEB_DIST: input.webDist } : {}),
    },
  });
  child.stdout.on("data", (chunk) => input.log?.(`polyth-link-client: ${String(chunk).trimEnd()}`));
  child.stderr.on("data", (chunk) => input.log?.(`polyth-link-client: ${String(chunk).trimEnd()}`));

  let socket: Socket | null = null;
  let closed = false;
  let nextId = 0;
  let buffer = "";
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const eventListeners = new Set<(event: unknown) => void>();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      input.log?.("Ignoring invalid polyth-link-client JSON line");
      return;
    }
    if (message.method === "event") {
      for (const cb of [...eventListeners]) cb(message.params);
      return;
    }
    const id = Number(message.id);
    if (!Number.isSafeInteger(id)) return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    const response = message as unknown as RpcResponse;
    if (response.error) {
      request.reject(err(String(response.error.code ?? "link-client-error"), response.error.message ?? String(response.error.code ?? "Polyth Link client error")));
    } else {
      request.resolve(response.result);
    }
  };

  const bindSocket = (next: Socket): void => {
    socket = next;
    next.setEncoding("utf8");
    next.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    next.on("close", () => {
      if (socket === next) socket = null;
      rejectPending(err("link-client-disconnected", "Polyth Link client IPC disconnected"));
    });
    next.on("error", (error) => input.log?.("Polyth Link client IPC error", error));
  };

  const waitForSocket = async (): Promise<void> => {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (!closed && Date.now() < deadline) {
      const candidate = createConnection(input.socketPath);
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("connect", resolve);
          candidate.once("error", reject);
        });
        bindSocket(candidate);
        return;
      } catch (error) {
        lastError = error;
        candidate.destroy();
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    }
    throw err("link-client-start-failed", `Could not connect to Polyth Link client IPC${lastError ? `: ${String(lastError)}` : ""}`);
  };

  child.once("exit", (code, signal) => {
    if (closed) return;
    const error = err("link-client-exited", `Polyth Link client exited (${code ?? signal ?? "unknown"})`);
    rejectPending(error);
    socket?.destroy();
    socket = null;
  });

  try {
    await waitForSocket();
  } catch (error) {
    closed = true;
    child.kill("SIGTERM");
    throw error;
  }

  const invoke = async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (closed || !socket || socket.destroyed) throw err("link-client-disconnected", "Polyth Link client is not connected");
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(err("link-client-timeout", `Polyth Link client RPC timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket!.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimeout(request.timer);
        request.reject(error);
      });
    });
  };

  const connectionFrom = (result: Record<string, unknown>, fallbackId = ""): PolythLinkConnection => {
    const origin = String(result.origin ?? "");
    const bootstrapUrl = String(result.bootstrapUrl ?? result.bootstrap ?? "");
    const connectionId = String(result.connectionId ?? fallbackId);
    if (!origin || !bootstrapUrl || !connectionId) {
      throw err("link-client-invalid-response", "Polyth Link connection response is incomplete");
    }
    return { connectionId, origin, bootstrapUrl };
  };

  return {
    invoke,
    parsePairingTicket(ticket) {
      return invoke<PolythLinkPairingPreview>("pairing.parse", { ticket });
    },
    beginPairing(ticket, label) {
      return invoke<PolythLinkPairingAttempt>("pairing.begin", { ticket, label });
    },
    async confirmPairing(attemptId) {
      return connectionFrom(await invoke<Record<string, unknown>>("pairing.confirm", { attemptId }));
    },
    async cancelPairing(attemptId) {
      await invoke("pairing.cancel", { attemptId });
    },
    async connections() {
      const result = await invoke<unknown>("connections.list");
      return Array.isArray(result) ? result : [];
    },
    async connect(connectionId) {
      return connectionFrom(await invoke<Record<string, unknown>>("connect", { connectionId }), connectionId);
    },
    recover(connectionId) {
      return invoke("connection.recover", { connectionId });
    },
    status(connectionId) {
      return invoke("status", { connectionId });
    },
    async disconnect(connectionId) {
      await invoke("disconnect", { connectionId });
    },
    async forget(connectionId) {
      await invoke("forget", { connectionId });
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return { dispose: () => { eventListeners.delete(cb); } };
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending(err("link-client-closed", "Polyth Link client closed"));
      socket?.end();
      socket?.destroy();
      socket = null;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(input.socketPath, { force: true }).catch(() => {});
    },
  };
}
