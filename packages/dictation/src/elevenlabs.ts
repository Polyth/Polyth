import WebSocket from "ws";
import { DictationError } from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_BASE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL = "scribe_v2_realtime";
const MAX_PROVIDER_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 12_000;

interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface ElevenLabsSttOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Test seam; production uses `ws` directly. */
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
  finalTimeoutMs?: number;
}

interface ElevenLabsMessage {
  message_type?: string;
  text?: string;
  error?: string;
}

const merge = (current: string, next: string): string => {
  const part = next.trim();
  if (!part) return current;
  return current ? `${current.replace(/\s+$/, "")} ${part}` : part;
};

const providerError = (message: ElevenLabsMessage): DictationError => {
  switch (message.message_type) {
    case "rate_limited": return new DictationError("rate_limited", message.error ?? "ElevenLabs rate limit reached");
    case "auth_error":
    case "invalid_api_key": return new DictationError("invalid_credentials", message.error ?? "ElevenLabs credentials are invalid");
    default: return new DictationError("provider_unavailable", message.error ?? "ElevenLabs realtime transcription failed");
  }
};

export function createElevenLabsSttAdapter(options: ElevenLabsSttOptions): SttAdapter {
  if (!options.apiKey.trim()) throw new DictationError("invalid_credentials", "ElevenLabs API key is missing");

  return {
    engine: "elevenlabs",
    createStream({ format, language }): SttStream {
      if (format.encoding !== "pcm_s16le" || format.channels !== 1) {
        throw new DictationError("audio_format_error", "ElevenLabs realtime adapter expects mono pcm_s16le");
      }
      return createStream(options, format, language);
    },
  };
}

function createStream(options: ElevenLabsSttOptions, format: DictationFormat, language?: string): SttStream {
  const url = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
  url.searchParams.set("model_id", options.model?.trim() || DEFAULT_MODEL);
  url.searchParams.set("audio_format", `pcm_${format.sampleRate}`);
  url.searchParams.set("commit_strategy", "manual");
  if (language && language !== "auto") {
    // ElevenLabs expects language codes rather than BCP-47 regions.
    url.searchParams.set("language_code", language.split("-")[0]!.toLowerCase());
  }

  const connect = options.connect ?? ((socketUrl, headers) => new WebSocket(socketUrl, { headers }) as unknown as SocketLike);
  const socket = connect(url.toString(), { "xi-api-key": options.apiKey });
  let committed = "";
  let interim = "";
  let closed = false;
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

  const rejectFinal = (error: DictationError) => {
    failure = failure ?? error;
    readyReject(error);
    finalReject?.(failure);
    finalReject = null;
    finalResolve = null;
  };

  socket.on("open", () => readyResolve());
  socket.on("message", (raw) => {
    let message: ElevenLabsMessage;
    try { message = JSON.parse(String(raw)) as ElevenLabsMessage; } catch { return; }
    if (message.message_type === "partial_transcript") {
      interim = message.text?.trim() ?? "";
      return;
    }
    if (message.message_type === "committed_transcript") {
      committed = merge(committed, message.text ?? "");
      interim = "";
      if (finalRequested && finalResolve) {
        const resolve = finalResolve;
        finalResolve = null;
        finalReject = null;
        resolve(committed);
      }
      return;
    }
    if (message.error || message.message_type === "rate_limited" || message.message_type === "auth_error" || message.message_type === "invalid_api_key") {
      rejectFinal(providerError(message));
    }
  });
  socket.on("error", (error) => rejectFinal(new DictationError("network_error", error.message || "ElevenLabs connection failed", { cause: error })));
  socket.on("close", (code, reason) => {
    closed = true;
    if (!failure && !(finalRequested && finalResolve === null)) {
      rejectFinal(new DictationError(
        code === 1008 ? "invalid_credentials" : "network_error",
        reason?.toString() || `ElevenLabs realtime connection closed (${code})`,
      ));
    }
  });

  const send = async (audio: Uint8Array, commit = false): Promise<void> => {
    await ready;
    if (failure) throw failure;
    if (closed || socket.readyState !== WebSocket.OPEN) throw new DictationError("network_error", "ElevenLabs realtime connection is not open");
    if (socket.bufferedAmount > MAX_PROVIDER_BUFFER) {
      throw new DictationError("backpressure_overflow", "ElevenLabs provider socket buffer overflowed");
    }
    const payload = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString("base64"),
      ...(commit ? { commit: true } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => error ? reject(new DictationError("network_error", error.message, { cause: error })) : resolve());
    });
  };

  return {
    async push(pcm) {
      await send(pcm);
    },
    partial() {
      return merge(committed, interim);
    },
    async finalize() {
      if (failure) throw failure;
      if (finalRequested) {
        if (!finalResolve) return committed;
        throw new DictationError("protocol_error", "ElevenLabs finalization is already pending");
      }
      finalRequested = true;
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await send(new Uint8Array(0), true);
      const timeoutMs = options.finalTimeoutMs ?? FINAL_TIMEOUT_MS;
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new DictationError("network_error", "Timed out waiting for ElevenLabs final transcript")), timeoutMs);
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
      if (!failure) failure = new DictationError("session_expired", "Dictation was cancelled");
      finalReject?.(failure);
      finalReject = null;
      finalResolve = null;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "dictation cancelled");
    },
  };
}
