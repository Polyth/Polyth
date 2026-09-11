import type { ChildProcess } from "node:child_process";
import {
  createHarnessProcessAuthority,
  type HarnessProcessAuthority,
} from "@polyth/harness-runtime/process-authority";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const BLOCKING_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiRpcState {
  model?: PiRpcModel | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface PiRpcModel {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface PiRpcSessionStats {
  sessionFile?: string;
  sessionId?: string;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  };
  [key: string]: unknown;
}

export type PiRpcEvent = Record<string, unknown> & { type?: string };

type Pending = {
  command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};

export interface PiRpc {
  readonly authorityId: string;
  readonly generation: number;
  readonly receipts: Readonly<Record<string, string>>;
  readonly releasedAuthorities: readonly { authorityId: string; generation: number }[];
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T>;
  receipt(operationId: string, nativeId: string): Promise<void>;
  onEvent(callback: (event: PiRpcEvent) => void): { dispose(): void };
  onClose(callback: () => void): { dispose(): void };
  close(): Promise<void>;
}

const safeMessage = (value: unknown): string => {
  if (typeof value !== "string") return "Pi rejected the request";
  const text = value
    .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 500) : "Pi rejected the request";
};

const waitForSpawn = (child: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});

export async function createPiRpc(options: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  stateFile?: string;
  stableAuthority?: boolean;
}): Promise<PiRpc> {
  const authority: HarnessProcessAuthority = await createHarnessProcessAuthority(
    options.stateFile,
    options.stableAuthority,
  );
  let child: ChildProcess;
  try {
    child = authority.spawn(
      options.command,
      ["--mode", "rpc", ...(options.args ?? [])],
      { cwd: options.cwd, env: options.env ?? process.env },
    );
    await waitForSpawn(child);
  } catch (error) {
    await authority.close().catch(() => undefined);
    throw error;
  }

  const stdin = child.stdin!;
  const stdout = child.stdout!;
  child.stderr?.resume();

  let closed = false;
  let nextId = 0;
  let bytes = Buffer.alloc(0);
  const pending = new Map<string, Pending>();
  const events = new Set<(event: PiRpcEvent) => void>();
  const closes = new Set<() => void>();

  const disconnected = () => {
    if (closed) return;
    closed = true;
    const error = Object.assign(new Error("Pi RPC connection closed before the request outcome was confirmed"), {
      code: "outcome-unknown",
    });
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const callback of closes) callback();
  };

  const protocolFailure = () => {
    disconnected();
    void authority.close().catch(() => undefined);
  };

  const writeRecord = (value: Record<string, unknown>): boolean => {
    if (closed) return false;
    try {
      stdin.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch {
      protocolFailure();
      return false;
    }
  };

  const handleLine = (lineBytes: Buffer) => {
    if (lineBytes.length === 0) return;
    const raw = lineBytes.at(-1) === 13 ? lineBytes.subarray(0, -1) : lineBytes;
    if (raw.length === 0) return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid RPC record");
      message = parsed as Record<string, unknown>;
    } catch {
      protocolFailure();
      return;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.success === false) {
        entry.reject(Object.assign(new Error(safeMessage(message.error)), {
          code: "runtime-rejected",
          rpcCommand: entry.command,
        }));
      } else {
        entry.resolve(message.data);
      }
      return;
    }

    // Pi extensions can request interactive UI from an RPC client. Polyth does
    // not expose those dialogs yet, so blocking requests must be explicitly
    // cancelled; silently ignoring them would leave the native agent waiting
    // forever. Fire-and-forget notifications/status/title requests need no ack.
    if (
      message.type === "extension_ui_request"
      && typeof message.id === "string"
      && typeof message.method === "string"
      && BLOCKING_EXTENSION_UI_METHODS.has(message.method)
    ) {
      writeRecord({ type: "extension_ui_response", id: message.id, cancelled: true });
      return;
    }

    for (const callback of events) {
      try {
        callback(message as PiRpcEvent);
      } catch {
        protocolFailure();
        return;
      }
    }
  };

  stdout.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (true) {
      const end = bytes.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE_BYTES) {
        protocolFailure();
        return;
      }
      const line = bytes.subarray(0, end);
      bytes = bytes.subarray(end + 1);
      handleLine(line);
      if (closed) return;
    }
    if (bytes.length > MAX_LINE_BYTES) protocolFailure();
  });
  child.on("error", disconnected);
  child.on("close", disconnected);
  stdin.on("error", disconnected);
  stdout.on("error", disconnected);

  return {
    authorityId: authority.authorityId,
    generation: authority.generation,
    releasedAuthorities: authority.releasedAuthorities,
    get receipts() { return authority.receipts; },
    receipt: authority.receipt,
    request<T>(command: Record<string, unknown> & { type: string }, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (closed) {
        return Promise.reject(Object.assign(new Error("Pi RPC connection is closed"), { code: "outcome-unknown" }));
      }
      const id = `polyth_${++nextId}`;
      return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error(`Pi did not confirm ${command.type}`), {
            code: "outcome-unknown",
            rpcCommand: command.type,
          }));
        }, timeoutMs) : undefined;
        timer?.unref?.();
        pending.set(id, {
          command: command.type,
          timer,
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (!writeRecord({ ...command, id })) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(Object.assign(new Error("Pi RPC command could not be written"), { code: "outcome-unknown" }));
        }
      });
    },
    onEvent(callback) {
      events.add(callback);
      return { dispose: () => events.delete(callback) };
    },
    onClose(callback) {
      closes.add(callback);
      return { dispose: () => closes.delete(callback) };
    },
    async close() {
      try {
        await authority.close();
      } finally {
        disconnected();
      }
    },
  };
}
