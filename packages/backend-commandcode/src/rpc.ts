import type { ChildProcess } from "node:child_process";
import {
  createHarnessProcessAuthority,
  type HarnessProcessAuthority,
} from "@polyth/harness-runtime/process-authority";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type Pending = {
  command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};

export type CommandCodeWorkerEvent = Record<string, unknown> & { type?: string };

export interface CommandCodeRpc {
  readonly authorityId: string;
  readonly generation: number;
  readonly receipts: Readonly<Record<string, string>>;
  readonly releasedAuthorities: readonly { authorityId: string; generation: number }[];
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T>;
  receipt(operationId: string, nativeId: string): Promise<void>;
  onEvent(callback: (event: CommandCodeWorkerEvent) => void): { dispose(): void };
  onClose(callback: () => void): { dispose(): void };
  close(): Promise<void>;
}

const waitForSpawn = (child: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});

const safeMessage = (value: unknown): string => String(value ?? "Command Code worker rejected the request")
  .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 500);

export async function createCommandCodeRpc(options: {
  workerPath: string;
  command: string;
  bridgePath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stateFile?: string;
  stableAuthority?: boolean;
}): Promise<CommandCodeRpc> {
  const authority: HarnessProcessAuthority = await createHarnessProcessAuthority(options.stateFile, options.stableAuthority);
  let child: ChildProcess;
  try {
    child = authority.spawn(process.execPath, [options.workerPath], {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        POLYTH_COMMANDCODE_BIN: options.command,
        POLYTH_COMMANDCODE_BRIDGE_PATH: options.bridgePath,
      },
    });
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
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();

  const disconnected = () => {
    if (closed) return;
    closed = true;
    const error = Object.assign(new Error("Command Code worker disconnected before the request outcome was confirmed"), { code: "outcome-unknown" });
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
    const raw = lineBytes.at(-1) === 13 ? lineBytes.subarray(0, -1) : lineBytes;
    if (!raw.length) return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid worker record");
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
        const rawCode = typeof message.code === "string" ? message.code : "outcome-unknown";
        const code = rawCode === "busy" || rawCode === "unsupported" || rawCode === "runtime-rejected"
          ? rawCode
          : "outcome-unknown";
        entry.reject(Object.assign(new Error(safeMessage(message.error)), { code, rpcCommand: entry.command }));
      } else entry.resolve(message.data);
      return;
    }
    for (const callback of events) {
      try { callback(message as CommandCodeWorkerEvent); }
      catch { protocolFailure(); return; }
    }
  };

  stdout.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (true) {
      const end = bytes.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE_BYTES) { protocolFailure(); return; }
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

  const rpc: CommandCodeRpc = {
    authorityId: authority.authorityId,
    generation: authority.generation,
    releasedAuthorities: authority.releasedAuthorities,
    get receipts() { return authority.receipts; },
    receipt: authority.receipt,
    request<T>(command: Record<string, unknown> & { type: string }, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (closed) return Promise.reject(Object.assign(new Error("Command Code worker is closed"), { code: "outcome-unknown" }));
      const id = `polyth_${++nextId}`;
      return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error(`Command Code worker did not confirm ${command.type}`), { code: "outcome-unknown", rpcCommand: command.type }));
        }, timeoutMs) : undefined;
        timer?.unref?.();
        pending.set(id, { command: command.type, timer, resolve: (value) => resolve(value as T), reject });
        if (!writeRecord({ ...command, id })) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(Object.assign(new Error("Command Code worker request could not be written"), { code: "outcome-unknown" }));
        }
      });
    },
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() {
      if (!closed) await rpc.request({ type: "shutdown" }, 5_000).catch(() => undefined);
      try { await authority.close(); }
      finally { disconnected(); }
    },
  };
  return rpc;
}
