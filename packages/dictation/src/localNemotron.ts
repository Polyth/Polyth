import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { DictationError, normalizeDictationError } from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

// The sherpa native addon lives in a CHILD PROCESS, not worker_threads. A native
// segfault/abort therefore kills only the recognizer process and cannot take the
// Polyth server with it. IPC is intentionally tiny: bounded PCM chunks and text.
const PROCESS_SOURCE = String.raw`
const { createRequire } = require("node:module");
const path = require("node:path");

const send = (value) => { if (process.connected && process.send) process.send(value); };
const reply = (id, ok, value) => send(ok ? { id, ok, value } : { id, ok, error: value });
const joinText = (a, b) => {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (!a) return b;
  if (!b) return a;
  return a + " " + b;
};

let recognizer;
let initialized = false;
const streams = new Map();

const loadRecognizer = (config) => {
  if (initialized) return;
  initialized = true;
  try {
    let sherpa;
    if (config.runtimeDir) {
      const modules = path.join(config.runtimeDir, "node_modules");
      const coreLib = path.join(modules, "sherpa-onnx-node", "lib");
      const platformPackage = process.platform === "darwin"
        ? "sherpa-onnx-darwin-" + process.arch
        : process.platform === "linux"
          ? "sherpa-onnx-linux-" + process.arch
          : process.platform === "win32"
            ? "sherpa-onnx-win-" + process.arch
            : "";
      const platformLib = platformPackage ? path.join(modules, platformPackage, "lib") : "";
      const nativePaths = [coreLib, platformLib].filter(Boolean).join(path.delimiter);
      if (process.platform === "linux") process.env.LD_LIBRARY_PATH = nativePaths + (process.env.LD_LIBRARY_PATH ? path.delimiter + process.env.LD_LIBRARY_PATH : "");
      if (process.platform === "darwin") process.env.DYLD_LIBRARY_PATH = nativePaths + (process.env.DYLD_LIBRARY_PATH ? path.delimiter + process.env.DYLD_LIBRARY_PATH : "");
      if (process.platform === "win32") process.env.PATH = nativePaths + (process.env.PATH ? path.delimiter + process.env.PATH : "");
      const runtimeRequire = createRequire(path.join(config.runtimeDir, "bootstrap.cjs"));
      sherpa = runtimeRequire("sherpa-onnx-node");
    } else {
      // Test/developer compatibility only. Production wiring supplies the
      // verified package-owned runtimeDir so the main server never imports it.
      sherpa = require("sherpa-onnx-node");
    }
    const modelDir = config.modelDir;
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 128 },
      modelConfig: {
        transducer: {
          encoder: path.join(modelDir, "encoder.int8.onnx"),
          decoder: path.join(modelDir, "decoder.int8.onnx"),
          joiner: path.join(modelDir, "joiner.int8.onnx"),
        },
        tokens: path.join(modelDir, "tokens.txt"),
        numThreads: config.threads,
        provider: "cpu",
        debug: 0,
      },
    });
    send({ type: "ready" });
  } catch (error) {
    send({ type: "fatal", message: error && error.message ? error.message : String(error) });
    setImmediate(() => process.exit(70));
  }
};

const pcmToFloat = (value) => {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value && value.type === "Buffer" && Array.isArray(value.data)
      ? Buffer.from(value.data)
      : Buffer.from(value || []);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return samples;
};

const decodeReady = (stream) => {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
};

const currentText = (state) => {
  const result = recognizer.getResult(state.stream);
  return joinText(state.committed, result && result.text);
};

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    loadRecognizer(message.config || {});
    return;
  }
  const { id, op, streamId } = message;
  Promise.resolve().then(() => {
    if (!recognizer) throw new Error("local ASR recognizer is unavailable");
    if (op === "ping") return "ok";
    if (op === "open") {
      const stream = recognizer.createStream();
      if (message.language) stream.setOption("language", message.language);
      streams.set(streamId, { stream, committed: "" });
      return "";
    }
    const state = streams.get(streamId);
    if (!state) throw new Error("local ASR stream is not open");
    if (op === "push") {
      state.stream.acceptWaveform({ sampleRate: 16000, samples: pcmToFloat(message.pcm) });
      decodeReady(state.stream);
      if (recognizer.isEndpoint(state.stream)) {
        const segment = String(recognizer.getResult(state.stream)?.text || "").trim();
        state.committed = joinText(state.committed, segment);
        recognizer.reset(state.stream);
      }
      return currentText(state);
    }
    if (op === "final") {
      // Small zero tail flushes the streaming encoder without adding seconds of
      // artificial buffering. inputFinished then lets sherpa drain deterministically.
      state.stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(3200) });
      state.stream.inputFinished();
      decodeReady(state.stream);
      const text = currentText(state);
      streams.delete(streamId);
      return text;
    }
    if (op === "cancel") {
      streams.delete(streamId);
      return "";
    }
    throw new Error("unknown local ASR process operation");
  }).then(
    (value) => reply(id, true, value),
    (error) => reply(id, false, error && error.message ? error.message : String(error)),
  );
});

process.on("disconnect", () => process.exit(0));
`;

interface PendingRpc {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalNemotronOptions {
  modelDir: string;
  /** Verified package-owned sherpa runtime root. Production always supplies it. */
  runtimeDir?: string;
  threads?: number;
  idleMs?: number;
  /** Native addon/model initialization deadline. */
  startupTimeoutMs?: number;
  /** Per-operation deadline. A wedged native decoder is killed and restarted. */
  rpcTimeoutMs?: number;
  /** Fail fast after this many unexpected process failures inside crashWindowMs. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** Test seam for crash-window accounting. */
  now?: () => number;
  /** Test seam. Production always spawns a separate Node process with IPC. */
  processFactory?: (source: string) => ChildProcess;
}

export interface LocalNemotronAdapter extends SttAdapter {
  /** Liveness probe against the isolated recognizer process. */
  health(): Promise<boolean>;
  /** Immediately terminate native process state; used on package disable/reload. */
  dispose(): void;
}

const languageOption = (language?: string): string | undefined => {
  const value = language?.trim();
  if (!value || value.toLowerCase() === "auto") return undefined;
  return value.toLowerCase().split(/[-_]/, 1)[0];
};

export function createLocalNemotronSttAdapter(options: LocalNemotronOptions): LocalNemotronAdapter {
  const threads = Math.max(1, Math.min(8, options.threads ?? 2));
  const idleMs = Math.max(5_000, options.idleMs ?? 60_000);
  const startupTimeoutMs = Math.max(10, options.startupTimeoutMs ?? 10_000);
  const rpcTimeoutMs = Math.max(100, options.rpcTimeoutMs ?? 15_000);
  const maxCrashes = Math.max(1, options.maxCrashes ?? 3);
  const crashWindowMs = Math.max(1_000, options.crashWindowMs ?? 60_000);
  const now = options.now ?? Date.now;
  const processFactory = options.processFactory ?? ((source: string) => spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  }));
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let requestId = 0;
  let activeStreams = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const pending = new Map<number, PendingRpc>();
  const crashTimes: number[] = [];
  const countedFailures = new WeakSet<object>();

  const pruneCrashes = (): void => {
    const floor = now() - crashWindowMs;
    while (crashTimes.length && crashTimes[0]! <= floor) crashTimes.shift();
  };

  const recordCrash = (target: ChildProcess): void => {
    if (countedFailures.has(target as unknown as object)) return;
    countedFailures.add(target as unknown as object);
    pruneCrashes();
    crashTimes.push(now());
  };

  const crashBudgetError = (): DictationError | null => {
    pruneCrashes();
    return crashTimes.length >= maxCrashes
      ? new DictationError(
          "worker_crashed",
          `Local ASR process entered a crash loop (${crashTimes.length} failures within ${Math.round(crashWindowMs / 1000)}s); retry after the crash window or reinstall the runtime/model`,
        )
      : null;
  };

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (startupTimer) clearTimeout(startupTimer);
    idleTimer = null;
    startupTimer = null;
  };

  const rejectAll = (error: Error): void => {
    for (const rpc of pending.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(error);
    }
    pending.clear();
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  };

  const resetProcess = (error?: Error): void => {
    clearTimers();
    if (error) rejectAll(error);
    child = null;
    ready = null;
    readyResolve = null;
    readyReject = null;
  };

  const failProcess = (target: ChildProcess, error: Error): void => {
    if (child !== target) return;
    recordCrash(target);
    activeStreams = 0;
    resetProcess(error);
  };

  const terminateProcess = (reason: Error): void => {
    clearTimers();
    const current = child;
    rejectAll(reason);
    resetProcess();
    activeStreams = 0;
    try { current?.disconnect?.(); } catch { /* already disconnected */ }
    try { current?.kill(); } catch { /* already exited */ }
  };

  const scheduleIdleShutdown = (): void => {
    if (disposed || activeStreams !== 0 || !child) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const current = child;
      // Reset first so the clean process exit never consumes crash-loop budget.
      resetProcess();
      try { current?.disconnect?.(); } catch { /* already disconnected */ }
      try { current?.kill(); } catch { /* already exited */ }
    }, idleMs);
    idleTimer.unref?.();
  };

  const ensureProcess = (): Promise<void> => {
    if (disposed) return Promise.reject(new DictationError("session_expired", "Local ASR adapter was disposed"));
    if (ready) return ready;
    const budgetFailure = crashBudgetError();
    if (budgetFailure) return Promise.reject(budgetFailure);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const next = processFactory(PROCESS_SOURCE);
    child = next;
    startupTimer = setTimeout(() => {
      if (child !== next || !readyReject) return;
      const failure = new DictationError(
        "worker_crashed",
        `Local Nemotron process did not become ready within ${startupTimeoutMs} ms`,
      );
      failProcess(next, failure);
      try { next.kill(); } catch { /* already exited */ }
    }, startupTimeoutMs);
    startupTimer.unref?.();

    next.on("message", (message: unknown) => {
      const data = message as { type?: string; id?: number; ok?: boolean; value?: string; error?: string; message?: string };
      if (data.type === "ready") {
        if (child !== next) return;
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = null;
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        return;
      }
      if (data.type === "fatal") {
        const failure = new DictationError(
          "provider_unavailable",
          `Local Nemotron runtime failed to initialize: ${data.message ?? "unknown process error"}`,
        );
        failProcess(next, failure);
        try { next.kill(); } catch { /* already exited */ }
        return;
      }
      if (typeof data.id !== "number") return;
      const rpc = pending.get(data.id);
      if (!rpc) return;
      pending.delete(data.id);
      clearTimeout(rpc.timer);
      if (data.ok) rpc.resolve(data.value ?? "");
      else rpc.reject(new DictationError("worker_crashed", data.error ?? "Local ASR process request failed"));
    });
    next.once("error", (error) => {
      failProcess(next, new DictationError("worker_crashed", `Local ASR process failed: ${error.message}`, { cause: error }));
    });
    next.once("exit", (code, signal) => {
      if (child !== next) return;
      failProcess(next, new DictationError(
        "worker_crashed",
        `Local ASR process exited unexpectedly${signal ? ` on ${signal}` : ` with code ${code}`}`,
      ));
    });
    try {
      next.send?.({
        type: "init",
        config: {
          modelDir: options.modelDir,
          ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}),
          threads,
        },
      });
    } catch (error) {
      const failure = normalizeDictationError(error, "worker_crashed");
      failProcess(next, failure);
      try { next.kill(); } catch { /* already exited */ }
    }
    return ready;
  };

  const rpc = async (op: string, streamId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    await ensureProcess();
    const current = child;
    if (!current?.connected) throw new DictationError("worker_crashed", "Local ASR process is unavailable");
    const id = ++requestId;
    let timer!: ReturnType<typeof setTimeout>;
    const result = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry || child !== current) return;
        pending.delete(id);
        const failure = new DictationError("worker_crashed", `Local ASR ${op} timed out after ${rpcTimeoutMs} ms`);
        entry.reject(failure);
        failProcess(current, failure);
        try { current.kill(); } catch { /* already exited */ }
      }, rpcTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
    });
    try {
      const message = op === "push" && extra.pcm instanceof Uint8Array
        ? { id, op, streamId, ...extra, pcm: Buffer.from(extra.pcm.buffer, extra.pcm.byteOffset, extra.pcm.byteLength) }
        : { id, op, streamId, ...extra };
      current.send(message, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        const failure = new DictationError("worker_crashed", `Local ASR IPC failed: ${error.message}`, { cause: error });
        entry.reject(failure);
        failProcess(current, failure);
        try { current.kill(); } catch { /* already exited */ }
      });
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
      }
      const failure = normalizeDictationError(error, "worker_crashed");
      failProcess(current, failure);
      try { current.kill(); } catch { /* already exited */ }
      throw failure;
    }
    return result;
  };

  return {
    engine: "local-nemotron",
    async health() {
      try {
        return await rpc("ping", "__health__") === "ok";
      } catch {
        return false;
      }
    },
    createStream({ format, language }: { format: DictationFormat; language?: string }): SttStream {
      if (disposed) throw new DictationError("session_expired", "Local ASR adapter was disposed");
      if (format.encoding !== "pcm_s16le" || format.sampleRate !== 16_000 || format.channels !== 1) {
        throw new DictationError("audio_format_error", "Local Nemotron requires mono PCM16 at 16 kHz");
      }
      const streamId = randomUUID();
      let latest = "";
      let closed = false;
      activeStreams += 1;
      const open = rpc("open", streamId, { language: languageOption(language) }).catch((error) => {
        if (!closed) {
          closed = true;
          activeStreams = Math.max(0, activeStreams - 1);
          scheduleIdleShutdown();
        }
        throw error;
      });
      const close = (): void => {
        if (closed) return;
        closed = true;
        activeStreams = Math.max(0, activeStreams - 1);
        scheduleIdleShutdown();
      };
      return {
        async push(pcm) {
          await open;
          if (closed) throw new DictationError("session_expired", "Local dictation stream is closed");
          latest = await rpc("push", streamId, { pcm });
        },
        partial: () => latest,
        async finalize() {
          await open;
          if (closed) return latest;
          try {
            latest = await rpc("final", streamId);
            return latest;
          } finally {
            close();
          }
        },
        async cancel() {
          try {
            await open;
            if (!closed) await rpc("cancel", streamId);
          } catch {
            // Cancellation is best effort; process crash/disposal is already surfaced to the active request.
          } finally {
            close();
          }
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terminateProcess(new DictationError("session_expired", "Local ASR adapter was disposed"));
    },
  };
}
