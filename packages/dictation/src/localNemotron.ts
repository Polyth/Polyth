import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DictationError, normalizeDictationError } from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const path = require("node:path");

const reply = (id, ok, value) => parentPort.postMessage(ok ? { id, ok, value } : { id, ok, error: value });
const joinText = (a, b) => {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (!a) return b;
  if (!b) return a;
  return a + " " + b;
};

let recognizer;
const streams = new Map();
try {
  let sherpa;
  if (workerData.runtimeDir) {
    const modules = path.join(workerData.runtimeDir, "node_modules");
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
    const runtimeRequire = createRequire(path.join(workerData.runtimeDir, "bootstrap.cjs"));
    sherpa = runtimeRequire("sherpa-onnx-node");
  } else {
    // Test/developer compatibility only. Production package wiring supplies an
    // explicit verified runtimeDir, so the main server never imports the addon.
    sherpa = require("sherpa-onnx-node");
  }
  const modelDir = workerData.modelDir;
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder.int8.onnx"),
        decoder: path.join(modelDir, "decoder.int8.onnx"),
        joiner: path.join(modelDir, "joiner.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      numThreads: workerData.threads,
      provider: "cpu",
      debug: 0,
    },
  });
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "fatal", message: error && error.message ? error.message : String(error) });
}

const pcmToFloat = (buffer) => {
  const pcm = new Int16Array(buffer);
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

parentPort.on("message", (message) => {
  const { id, op, streamId } = message;
  Promise.resolve().then(() => {
    if (!recognizer) throw new Error("local ASR recognizer is unavailable");
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
      state.stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) });
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
    throw new Error("unknown local ASR worker operation");
  }).then((value) => reply(id, true, value), (error) => reply(id, false, error && error.message ? error.message : String(error)));
});
`;

interface PendingRpc {
  resolve(value: string): void;
  reject(error: Error): void;
}

export interface LocalNemotronOptions {
  modelDir: string;
  /** Verified package-owned sherpa runtime root. Production always supplies it. */
  runtimeDir?: string;
  threads?: number;
  idleMs?: number;
  workerFactory?: (source: string, options: ConstructorParameters<typeof Worker>[1]) => Worker;
}

const languageOption = (language?: string): string | undefined => {
  const value = language?.trim();
  if (!value || value.toLowerCase() === "auto") return undefined;
  return value.toLowerCase().split(/[-_]/, 1)[0];
};

export function createLocalNemotronSttAdapter(options: LocalNemotronOptions): SttAdapter {
  const threads = Math.max(1, Math.min(8, options.threads ?? 2));
  const idleMs = Math.max(5_000, options.idleMs ?? 60_000);
  const workerFactory = options.workerFactory ?? ((source, workerOptions) => new Worker(source, workerOptions));
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let requestId = 0;
  let activeStreams = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, PendingRpc>();

  const rejectAll = (error: Error): void => {
    for (const rpc of pending.values()) rpc.reject(error);
    pending.clear();
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  };

  const resetWorker = (error?: Error): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (error) rejectAll(error);
    worker = null;
    ready = null;
    readyResolve = null;
    readyReject = null;
  };

  const scheduleIdleShutdown = (): void => {
    if (activeStreams !== 0 || !worker) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const current = worker;
      resetWorker();
      void current?.terminate();
    }, idleMs);
    idleTimer.unref?.();
  };

  const ensureWorker = (): Promise<void> => {
    if (ready) return ready;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const next = workerFactory(WORKER_SOURCE, {
      eval: true,
      workerData: {
        modelDir: options.modelDir,
        ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}),
        threads,
      },
    });
    worker = next;
    next.on("message", (message: unknown) => {
      const data = message as { type?: string; id?: number; ok?: boolean; value?: string; error?: string; message?: string };
      if (data.type === "ready") {
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        return;
      }
      if (data.type === "fatal") {
        const failure = new DictationError(
          "provider_unavailable",
          `Local Nemotron runtime failed to initialize: ${data.message ?? "unknown worker error"}`,
        );
        rejectAll(failure);
        void next.terminate();
        resetWorker();
        return;
      }
      if (typeof data.id !== "number") return;
      const rpc = pending.get(data.id);
      if (!rpc) return;
      pending.delete(data.id);
      if (data.ok) rpc.resolve(data.value ?? "");
      else rpc.reject(new DictationError("worker_crashed", data.error ?? "Local ASR worker request failed"));
    });
    next.once("error", (error) => {
      const failure = new DictationError("worker_crashed", `Local ASR worker crashed: ${error.message}`, { cause: error });
      rejectAll(failure);
      resetWorker();
    });
    next.once("exit", (code) => {
      if (worker !== next) return;
      const failure = code === 0 ? undefined : new DictationError("worker_crashed", `Local ASR worker exited with code ${code}`);
      if (failure) rejectAll(failure);
      resetWorker();
    });
    return ready;
  };

  const rpc = async (op: string, streamId: string, extra: Record<string, unknown> = {}, transfer?: ArrayBuffer): Promise<string> => {
    await ensureWorker();
    if (!worker) throw new DictationError("worker_crashed", "Local ASR worker is unavailable");
    const id = ++requestId;
    const result = new Promise<string>((resolve, reject) => pending.set(id, { resolve, reject }));
    try {
      worker.postMessage({ id, op, streamId, ...extra }, transfer ? [transfer] : []);
    } catch (error) {
      pending.delete(id);
      throw normalizeDictationError(error, "worker_crashed");
    }
    return result;
  };

  return {
    engine: "local-nemotron",
    createStream({ format, language }: { format: DictationFormat; language?: string }): SttStream {
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
          const buffer = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
            ? pcm.buffer as ArrayBuffer
            : pcm.slice().buffer as ArrayBuffer;
          latest = await rpc("push", streamId, { pcm: buffer }, buffer);
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
            // Cancellation is best effort; worker crash is already surfaced to the active request.
          } finally {
            close();
          }
        },
      };
    },
  };
}
