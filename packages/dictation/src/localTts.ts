import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DictationError } from "./providers.ts";
import { SHERPA_LOADER_SOURCE } from "./localNemotron.ts";
import { defaultSpeaker, type LocalVoiceDescriptor } from "./localVoiceCatalog.ts";

// Built-in voices run in their own child process, like local dictation: a
// native crash or a wedged synthesis kills only that process. Requests are
// serialized — synthesis already uses every thread it is given.
const PROCESS_SOURCE = String.raw`
const { createRequire } = require("node:module");
const path = require("node:path");
${SHERPA_LOADER_SOURCE}

const send = (value) => { if (process.connected && process.send) process.send(value); };
let sherpa;
// Loaded voices, most recent last. Kokoro loads one instance per language.
const loaded = new Map();
const MAX_LOADED = 2;

const wav = (samples, sampleRate) => {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    try {
      sherpa = loadSherpa(message.runtimeDir);
      send({ type: "ready" });
    } catch (error) {
      send({ type: "fatal", message: error && error.message ? error.message : String(error) });
      setImmediate(() => process.exit(70));
    }
    return;
  }
  const { id, key, config, text, sid, speed } = message;
  try {
    let tts = loaded.get(key);
    if (tts) loaded.delete(key);
    else tts = await sherpa.OfflineTts.createAsync(config);
    loaded.set(key, tts);
    while (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value);
    const started = Date.now();
    const audio = await tts.generateAsync({ text, sid, speed });
    const seconds = audio.samples.length / audio.sampleRate;
    send({ id, ok: true, wav: wav(audio.samples, audio.sampleRate), seconds, genMs: Date.now() - started });
  } catch (error) {
    send({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
});

process.on("disconnect", () => process.exit(0));
`;

export interface LocalSpeechRequest {
  text: string;
  /** Speaker id for multi-speaker voices; defaults per language. */
  speaker?: number;
  /** Language the text is in (Kokoro picks its phonemizer from it). */
  lang?: string;
  /** 0.5–2, 1 is the voice's natural pace. */
  speed?: number;
}

export interface LocalSpeech {
  wav: Buffer;
  /** Audio length. */
  seconds: number;
  /** Synthesis time; above `seconds` the voice is slower than real time here. */
  genMs: number;
}

export interface LocalTts {
  synthesize(voice: LocalVoiceDescriptor, dir: string, request: LocalSpeechRequest): Promise<LocalSpeech>;
  dispose(): void;
}

/** The sherpa config for one installed voice (and, for Kokoro, one language). */
export function localVoiceConfig(voice: LocalVoiceDescriptor, dir: string, speaker: number, threads: number) {
  const base = { numThreads: threads, provider: "cpu", debug: 0 };
  if (voice.engine === "piper") {
    const name = voice.id.slice("piper-".length);
    return {
      key: voice.id,
      config: {
        model: { vits: { model: join(dir, `${name}.onnx`), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data") }, ...base },
        maxNumSentences: 1,
      },
    };
  }
  const lang = voice.speakers?.find((entry) => entry.id === speaker)?.lang ?? "en-US";
  const primary = lang.split("-")[0]!.toLowerCase();
  // English and Chinese read through Kokoro's lexicons; other languages go
  // through espeak with the language set explicitly.
  const kokoroLang = primary === "en" || primary === "zh" ? "" : lang === "pt-BR" ? "pt-br" : primary;
  const englishLexicon = lang === "en-GB" ? "lexicon-gb-en.txt" : "lexicon-us-en.txt";
  return {
    key: `${voice.id}:${kokoroLang || lang}`,
    config: {
      model: {
        kokoro: {
          model: join(dir, "model.int8.onnx"),
          voices: join(dir, "voices.bin"),
          tokens: join(dir, "tokens.txt"),
          dataDir: join(dir, "espeak-ng-data"),
          lexicon: [join(dir, englishLexicon), join(dir, "lexicon-zh.txt")].join(","),
          ...(kokoroLang ? { lang: kokoroLang } : {}),
        },
        ...base,
      },
      maxNumSentences: 1,
      ...(primary === "zh" ? { ruleFsts: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"].map((file) => join(dir, file)).join(",") } : {}),
    },
  };
}

export function createLocalTts(options: {
  runtimeDir: () => string | null;
  threads?: number;
  /** One synthesis (including loading the voice) must finish within this. */
  timeoutMs?: number;
  idleMs?: number;
  /** Test seam. */
  processFactory?: (source: string) => ChildProcess;
}): LocalTts {
  const threads = Math.max(1, Math.min(8, options.threads ?? 4));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const processFactory = options.processFactory ?? ((source: string) => spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
    windowsHide: true,
  }));
  let child: ChildProcess | null = null;
  let ready: Promise<ChildProcess> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let requestId = 0;
  let disposed = false;
  const pending = new Map<number, { resolve(value: LocalSpeech): void; reject(error: Error): void }>();

  const stop = (error: Error) => {
    const current = child;
    child = null;
    ready = null;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    try { current?.kill(); } catch { /* already exited */ }
  };

  const start = (): Promise<ChildProcess> => {
    if (ready) return ready;
    const runtimeDir = options.runtimeDir();
    if (!runtimeDir) return Promise.reject(new DictationError("local_model_missing", "The speech engine is not downloaded"));
    const next = processFactory(PROCESS_SOURCE);
    child = next;
    ready = new Promise<ChildProcess>((resolve, reject) => {
      const startup = setTimeout(() => {
        if (child === next) stop(new DictationError("worker_crashed", "The voice process did not start"));
        reject(new DictationError("worker_crashed", "The voice process did not start"));
      }, 15_000);
      startup.unref?.();
      next.on("message", (message: unknown) => {
        const data = message as { type?: string; id?: number; ok?: boolean; wav?: Uint8Array; seconds?: number; genMs?: number; error?: string; message?: string };
        if (data.type === "ready") {
          clearTimeout(startup);
          resolve(next);
          return;
        }
        if (data.type === "fatal") {
          clearTimeout(startup);
          const failure = new DictationError("provider_unavailable", `The speech engine failed to load: ${data.message ?? "unknown error"}`);
          reject(failure);
          if (child === next) stop(failure);
          return;
        }
        const entry = typeof data.id === "number" ? pending.get(data.id) : undefined;
        if (!entry) return;
        pending.delete(data.id!);
        if (data.ok && data.wav) entry.resolve({ wav: Buffer.from(data.wav), seconds: data.seconds ?? 0, genMs: data.genMs ?? 0 });
        else entry.reject(new DictationError("provider_unavailable", data.error ?? "Speech synthesis failed"));
      });
      next.once("exit", (code, signal) => {
        clearTimeout(startup);
        const failure = new DictationError("worker_crashed", `The voice process exited${signal ? ` on ${signal}` : ` with code ${code}`}`);
        reject(failure);
        if (child === next) stop(failure);
      });
      next.once("error", (error) => {
        clearTimeout(startup);
        reject(error);
        if (child === next) stop(new DictationError("worker_crashed", error.message));
      });
      next.send({ type: "init", runtimeDir });
    });
    return ready;
  };

  const run = async (voice: LocalVoiceDescriptor, dir: string, request: LocalSpeechRequest): Promise<LocalSpeech> => {
    if (disposed) throw new DictationError("session_expired", "Built-in voices are shut down");
    if (idle) clearTimeout(idle);
    const current = await start();
    const speaker = request.speaker ?? defaultSpeaker(voice, request.lang ?? voice.languages[0] ?? "en-US");
    const { key, config } = localVoiceConfig(voice, dir, speaker, threads);
    const id = ++requestId;
    const result = new Promise<LocalSpeech>((resolve, reject) => pending.set(id, { resolve, reject }));
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // A wedged synthesis cannot be interrupted; replace the process.
      stop(new DictationError("worker_crashed", `Speech synthesis took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref?.();
    current.send({ id, key, config, text: request.text, sid: speaker, speed: Math.max(0.5, Math.min(2, request.speed ?? 1)) });
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      if (!disposed) {
        idle = setTimeout(() => stop(new DictationError("session_expired", "Voice process idle")), idleMs);
        idle.unref?.();
      }
    }
  };

  return {
    synthesize(voice, dir, request) {
      const next = tail.then(() => run(voice, dir, request));
      tail = next.catch(() => {});
      return next;
    },
    dispose() {
      disposed = true;
      if (idle) clearTimeout(idle);
      stop(new DictationError("session_expired", "Built-in voices are shut down"));
    },
  };
}
