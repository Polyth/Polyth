import WebSocket from "ws";
import { DictationError } from "./providers.ts";
import type { DictationContext } from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_URL = "wss://global.rt.speechmatics.com/v2";
const MAX_PROVIDER_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 12_000;

interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface SpeechmaticsSttOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  latencyPreference?: "lowest" | "balanced" | "quality";
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
  finalTimeoutMs?: number;
}

interface SpeechmaticsMessage {
  message?: string;
  type?: string;
  reason?: string;
  metadata?: { transcript?: unknown };
}

const merge = (current: string, next: string): string => {
  const part = next.trim();
  if (!part) return current;
  return current ? `${current.replace(/\s+$/, "")} ${part}` : part;
};

const providerError = (message: SpeechmaticsMessage): DictationError => {
  const type = String(message.type ?? "").toLowerCase();
  const reason = message.reason || `Speechmatics realtime error${type ? ` (${type})` : ""}`;
  if (type.includes("not_authorised") || type.includes("not_authorized") || type.includes("auth")) {
    return new DictationError("invalid_credentials", reason);
  }
  if (type.includes("insufficient_funds") || type.includes("quota") || type.includes("rate") || type.includes("limit")) {
    return new DictationError("rate_limited", reason, { retryAfterMs: 5_000 });
  }
  if (type.includes("language") || type.includes("model")) {
    return new DictationError("unsupported_language", reason);
  }
  return new DictationError("provider_unavailable", reason);
};

const languageCode = (language?: string): string => {
  const value = language?.trim();
  if (!value || value.toLowerCase() === "auto") return "en";
  return value.toLowerCase().split(/[-_]/, 1)[0] || "en";
};

const maxDelay = (preference: SpeechmaticsSttOptions["latencyPreference"]): number =>
  preference === "quality" ? 2 : preference === "balanced" ? 1 : 0.7;

const additionalVocab = (context: DictationContext): string[] => {
  const values = [
    ...(context.keywords ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ").slice(0, 96);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 64) break;
  }
  return out;
};

export function createSpeechmaticsSttAdapter(options: SpeechmaticsSttOptions): SttAdapter {
  if (!options.apiKey.trim()) throw new DictationError("invalid_credentials", "Speechmatics API key is missing");
  return {
    engine: "speechmatics",
    createStream({ format, language, context }): SttStream {
      if (format.encoding !== "pcm_s16le" || format.channels !== 1) {
        throw new DictationError("audio_format_error", "Speechmatics realtime adapter expects mono pcm_s16le");
      }
      return createStream(options, format, language, context ?? { language: language ?? "auto" });
    },
  };
}

function createStream(
  options: SpeechmaticsSttOptions,
  format: DictationFormat,
  language: string | undefined,
  context: DictationContext,
): SttStream {
  const connect = options.connect ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike);
  const socket = connect(options.baseUrl ?? DEFAULT_URL, { Authorization: `Bearer ${options.apiKey}` });
  let committed = "";
  let interim = "";
  let started = false;
  let closed = false;
  let audioSeq = 0;
  let failure: DictationError | null = null;
  let finalRequested = false;
  let finalResolve: ((text: string) => void) | null = null;
  let finalReject: ((error: Error) => void) | null = null;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const reject = (error: DictationError) => {
    failure = failure ?? error;
    readyReject(failure);
    finalReject?.(failure);
    finalReject = null;
    finalResolve = null;
  };

  const send = async (data: string | Uint8Array): Promise<void> => {
    if (failure) throw failure;
    if (closed || socket.readyState !== WebSocket.OPEN) throw new DictationError("network_error", "Speechmatics realtime connection is not open");
    if (socket.bufferedAmount > MAX_PROVIDER_BUFFER) {
      throw new DictationError("backpressure_overflow", "Speechmatics provider socket buffer overflowed");
    }
    await new Promise<void>((resolve, rejectSend) => {
      socket.send(data, (error) => error
        ? rejectSend(new DictationError("network_error", error.message, { cause: error }))
        : resolve());
    });
  };

  socket.on("open", () => {
    const vocab = additionalVocab(context);
    const start = {
      message: "StartRecognition",
      audio_format: {
        type: "raw",
        encoding: "pcm_s16le",
        sample_rate: format.sampleRate,
      },
      transcription_config: {
        language: languageCode(language ?? context.language),
        model: options.model?.trim() || "enhanced",
        max_delay: maxDelay(options.latencyPreference),
        enable_partials: true,
        ...(vocab.length ? { additional_vocab: vocab } : {}),
      },
    };
    void send(JSON.stringify(start)).catch((error) => reject(error instanceof DictationError
      ? error
      : new DictationError("network_error", String(error))));
  });

  socket.on("message", (raw) => {
    let message: SpeechmaticsMessage;
    try { message = JSON.parse(String(raw)) as SpeechmaticsMessage; } catch { return; }
    if (message.message === "RecognitionStarted") {
      started = true;
      readyResolve();
      return;
    }
    if (message.message === "AddPartialTranscript") {
      const text = typeof message.metadata?.transcript === "string" ? message.metadata.transcript.trim() : "";
      interim = text;
      return;
    }
    if (message.message === "AddTranscript") {
      const text = typeof message.metadata?.transcript === "string" ? message.metadata.transcript : "";
      committed = merge(committed, text);
      interim = "";
      return;
    }
    if (message.message === "EndOfTranscript") {
      if (finalRequested && finalResolve) {
        const resolve = finalResolve;
        finalResolve = null;
        finalReject = null;
        resolve(committed);
      }
      return;
    }
    if (message.message === "Error") reject(providerError(message));
  });
  socket.on("error", (error) => reject(new DictationError("network_error", error.message || "Speechmatics connection failed", { cause: error })));
  socket.on("close", (code, reason) => {
    closed = true;
    if (!failure && finalResolve) {
      reject(new DictationError(
        code === 1008 ? "invalid_credentials" : "network_error",
        reason?.toString() || `Speechmatics realtime connection closed (${code})`,
      ));
    }
  });

  return {
    async push(pcm) {
      await ready;
      if (!started) throw new DictationError("protocol_error", "Speechmatics recognition did not start");
      await send(pcm);
      audioSeq += 1;
    },
    partial() {
      return merge(committed, interim);
    },
    async finalize() {
      await ready;
      if (failure) throw failure;
      if (finalRequested) throw new DictationError("protocol_error", "Speechmatics finalization is already pending");
      finalRequested = true;
      const final = new Promise<string>((resolve, rejectFinal) => {
        finalResolve = resolve;
        finalReject = rejectFinal;
      });
      await send(JSON.stringify({ message: "EndOfStream", last_seq_no: audioSeq }));
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const timer = setTimeout(
          () => rejectTimeout(new DictationError("network_error", "Timed out waiting for Speechmatics final transcript")),
          options.finalTimeoutMs ?? FINAL_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        if (!closed) socket.close(1000, "dictation finalized");
      }
    },
    cancel() {
      closed = true;
      failure ??= new DictationError("session_expired", "Dictation was cancelled");
      finalReject?.(failure);
      finalReject = null;
      finalResolve = null;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "dictation cancelled");
    },
  };
}
