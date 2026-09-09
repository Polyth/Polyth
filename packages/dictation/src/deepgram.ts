import WebSocket from "ws";
import { DictationError, type DictationContext } from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";
const MAX_PROVIDER_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 10_000;

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

export interface DeepgramSttOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  endpointingMs?: number;
  finalTimeoutMs?: number;
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
  description?: string;
  message?: string;
}

const merge = (current: string, next: string): string => {
  const part = next.trim();
  if (!part) return current;
  return current ? `${current.replace(/\s+$/, "")} ${part}` : part;
};

const socketFailure = (error: Error): DictationError => {
  if (/\b(?:401|403)\b|auth|credential|token/i.test(error.message)) {
    return new DictationError("invalid_credentials", "Deepgram credentials are invalid", { cause: error });
  }
  if (/\b429\b|rate.?limit/i.test(error.message)) {
    return new DictationError("rate_limited", "Deepgram rate limit reached", { cause: error });
  }
  return new DictationError("network_error", error.message || "Deepgram connection failed", { cause: error });
};

const keyterms = (context?: DictationContext): string[] => {
  if (!context) return [];
  const source = [
    ...(context.keywords ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of source) {
    const term = value.trim().replace(/\s+/g, " ").slice(0, 80);
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    result.push(term);
    if (result.length >= 100) break;
  }
  return result;
};

const deepgramLanguage = (language?: string): string => {
  const value = language?.trim();
  if (!value || value.toLowerCase() === "auto") {
    // Deepgram streaming currently has no detect_language. `multi` is its
    // explicit multilingual mode, not generic language auto-detection.
    return "multi";
  }
  // Nova-3 documents Ukrainian as `uk`; Polyth's UI stores BCP-47 `uk-UA`.
  if (/^uk(?:[-_]ua)?$/i.test(value)) return "uk";
  return value;
};

export function createDeepgramSttAdapter(options: DeepgramSttOptions): SttAdapter {
  if (!options.apiKey.trim()) throw new DictationError("invalid_credentials", "Deepgram API key is missing");
  return {
    engine: "deepgram",
    createStream({ format, language, context }) {
      if (format.encoding !== "pcm_s16le" || format.channels !== 1) {
        throw new DictationError("audio_format_error", "Deepgram realtime adapter expects mono pcm_s16le");
      }
      return openDeepgramStream(options, format, language, context);
    },
  };
}

function openDeepgramStream(
  options: DeepgramSttOptions,
  format: DictationFormat,
  language?: string,
  context?: DictationContext,
): SttStream {
  const url = new URL(options.baseUrl ?? DEFAULT_URL);
  url.searchParams.set("model", options.model?.trim() || DEFAULT_MODEL);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(format.sampleRate));
  url.searchParams.set("channels", String(format.channels));
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("endpointing", String(options.endpointingMs ?? 300));
  url.searchParams.set("language", deepgramLanguage(language));
  for (const term of keyterms(context)) url.searchParams.append("keyterm", term);

  const connect = options.connect ?? ((socketUrl, headers) => new WebSocket(socketUrl, { headers }) as unknown as SocketLike);
  const socket = connect(url.toString(), { Authorization: `Token ${options.apiKey}` });
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

  const reject = (error: DictationError): void => {
    failure = failure ?? error;
    readyReject(failure);
    finalReject?.(failure);
    finalReject = null;
    finalResolve = null;
  };

  const finishIfRequested = (): void => {
    if (!finalRequested || !finalResolve) return;
    const resolve = finalResolve;
    finalResolve = null;
    finalReject = null;
    resolve(merge(committed, interim));
  };

  socket.on("open", readyResolve);
  socket.on("message", (raw) => {
    let message: DeepgramMessage;
    try { message = JSON.parse(String(raw)) as DeepgramMessage; } catch { return; }
    if (message.type === "Results") {
      const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (message.is_final) {
        committed = merge(committed, text);
        interim = "";
        if (finalRequested) finishIfRequested();
      } else {
        interim = text;
      }
      return;
    }
    if (message.type === "Error") {
      reject(new DictationError("provider_unavailable", message.description ?? message.message ?? "Deepgram transcription failed"));
    }
  });
  socket.on("error", (error) => reject(socketFailure(error)));
  socket.on("close", (code, reason) => {
    closed = true;
    if (finalRequested && !failure) {
      finishIfRequested();
      return;
    }
    if (!failure) {
      reject(new DictationError(
        code === 1008 ? "invalid_credentials" : "network_error",
        reason?.toString() || `Deepgram realtime connection closed (${code})`,
      ));
    }
  });

  const send = async (data: string | Uint8Array): Promise<void> => {
    await ready;
    if (failure) throw failure;
    if (closed || socket.readyState !== WebSocket.OPEN) throw new DictationError("network_error", "Deepgram realtime connection is not open");
    if (socket.bufferedAmount > MAX_PROVIDER_BUFFER) throw new DictationError("backpressure_overflow", "Deepgram provider socket buffer overflowed");
    await new Promise<void>((resolve, rejectSend) => {
      socket.send(data, (error) => error ? rejectSend(socketFailure(error)) : resolve());
    });
  };

  return {
    push: (pcm) => send(pcm),
    partial: () => merge(committed, interim),
    async finalize() {
      if (failure) throw failure;
      if (finalRequested) {
        if (!finalResolve) return merge(committed, interim);
        throw new DictationError("protocol_error", "Deepgram finalization is already pending");
      }
      finalRequested = true;
      const final = new Promise<string>((resolve, rejectFinal) => {
        finalResolve = resolve;
        finalReject = rejectFinal;
      });
      await send(JSON.stringify({ type: "Finalize" }));
      const timeoutMs = options.finalTimeoutMs ?? FINAL_TIMEOUT_MS;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timeoutId = setTimeout(() => rejectTimeout(new DictationError("network_error", "Timed out waiting for Deepgram final transcript")), timeoutMs);
        timeoutId.unref?.();
      });
      try {
        const text = await Promise.race([final, timeout]);
        if (!closed && socket.readyState === WebSocket.OPEN) {
          await send(JSON.stringify({ type: "CloseStream" })).catch(() => {});
        }
        return text;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (!closed && socket.readyState === WebSocket.OPEN) socket.close(1000, "dictation finalized");
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
