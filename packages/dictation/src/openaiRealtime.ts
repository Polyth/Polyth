import WebSocket from "ws";
import {
  DictationError,
  type DictationContext,
  type DictationLatencyPreference,
} from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_URL = "wss://api.openai.com/v1/realtime";
const OPENAI_SAMPLE_RATE = 24_000;
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

export interface OpenAIRealtimeSttOptions {
  apiKey: string;
  model: "gpt-live-transcribe" | "gpt-transcribe" | string;
  baseUrl?: string;
  latencyPreference?: DictationLatencyPreference;
  finalTimeoutMs?: number;
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
}

interface OpenAIRealtimeEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: {
    type?: string;
    code?: string;
    message?: string;
  };
}

/** Stateful linear PCM16 resampler. The provider-neutral Polyth wire stays at
 * 16 kHz while OpenAI Realtime currently requires 24 kHz PCM. Keeping phase
 * across chunks avoids boundary drift and avoids buffering whole utterances. */
export interface Pcm16Resampler {
  push(pcm: Uint8Array): Uint8Array;
}

export function createPcm16Resampler(fromRate: number, toRate: number): Pcm16Resampler {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error("sample rates must be positive");
  }
  if (fromRate === toRate) return { push: (pcm) => pcm.slice() };

  const sourceStep = fromRate / toRate;
  let sourceCount = 0;
  let nextSourcePosition = 0;
  let previousSample: number | undefined;

  return {
    push(pcm) {
      if ((pcm.byteLength & 1) !== 0) {
        throw new DictationError("audio_format_error", "PCM16 chunks must contain whole 16-bit samples");
      }
      const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
      if (input.length === 0) return new Uint8Array(0);
      const start = sourceCount;
      const end = start + input.length - 1;
      const output: number[] = [];

      const sampleAt = (index: number): number | undefined => {
        if (index === start - 1) return previousSample;
        if (index < start || index > end) return undefined;
        return input[index - start];
      };

      while (Math.ceil(nextSourcePosition) <= end) {
        const low = Math.floor(nextSourcePosition);
        const high = Math.ceil(nextSourcePosition);
        const a = sampleAt(low);
        const b = sampleAt(high);
        if (a === undefined || b === undefined) break;
        const fraction = nextSourcePosition - low;
        output.push(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))));
        nextSourcePosition += sourceStep;
      }

      sourceCount += input.length;
      previousSample = input[input.length - 1];
      const out = new Int16Array(output.length);
      for (let i = 0; i < output.length; i++) out[i] = output[i]!;
      return new Uint8Array(out.buffer);
    },
  };
}

const normalizeLanguage = (value: string): string | undefined => {
  const raw = value.trim().toLowerCase().replace(/_/g, "-");
  if (!raw || raw === "auto") return undefined;
  if (/^zh-(?:cn|tw|hk)$/.test(raw)) return raw;
  const base = raw.split("-", 1)[0];
  return base && /^[a-z]{2,3}$/.test(base) ? base : undefined;
};

const contextLanguages = (context?: DictationContext, language?: string): string[] | undefined => {
  const values = [language ?? "", context?.language ?? "", ...(context?.localeHints ?? [])];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeLanguage(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
};

const contextKeywords = (context?: DictationContext): string[] | undefined => {
  if (!context) return undefined;
  const values = [
    ...(context.keywords ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const keyword = value.replace(/[<>\r\n]/g, " ").trim().replace(/\s+/g, " ").slice(0, 96);
    const key = keyword.toLocaleLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= 64) break;
  }
  return out.length ? out : undefined;
};

const contextPrompt = (context?: DictationContext): string | undefined => {
  if (!context) return undefined;
  const glossary = Object.entries(context.glossary ?? {})
    .map(([from, to]) => `${from}: ${to}`)
    .join(", ");
  const prompt = [context.lexicalContext ?? "", glossary ? `Glossary: ${glossary}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000)
    .trim();
  return prompt || undefined;
};

const delayFor = (preference: DictationLatencyPreference | undefined): "minimal" | "medium" | "high" => {
  switch (preference) {
    case "quality": return "high";
    case "balanced": return "medium";
    default: return "minimal";
  }
};

const providerError = (event: OpenAIRealtimeEvent): DictationError => {
  const code = event.error?.code ?? event.error?.type ?? "";
  const message = event.error?.message ?? "OpenAI realtime transcription failed";
  if (/auth|credential|api.?key|permission|unauthorized/i.test(`${code} ${message}`)) {
    return new DictationError("invalid_credentials", message);
  }
  if (/rate.?limit|429/i.test(`${code} ${message}`)) {
    return new DictationError("rate_limited", message);
  }
  if (/language/i.test(`${code} ${message}`)) {
    return new DictationError("unsupported_language", message);
  }
  return new DictationError("provider_unavailable", message);
};

export function createOpenAIRealtimeSttAdapter(options: OpenAIRealtimeSttOptions): SttAdapter {
  if (!options.apiKey.trim()) throw new DictationError("invalid_credentials", "OpenAI API key is missing");
  const model = options.model.trim();
  if (!model) throw new DictationError("provider_unavailable", "OpenAI transcription model is missing");

  return {
    engine: model === "gpt-live-transcribe" ? "openai-live" : "openai-transcribe",
    createStream({ format, language, context }) {
      if (format.encoding !== "pcm_s16le" || format.channels !== 1 || format.sampleRate !== 16_000) {
        throw new DictationError("audio_format_error", "OpenAI Realtime adapter expects Polyth mono PCM16 at 16 kHz");
      }
      return openStream(options, format, language, context);
    },
  };
}

function openStream(
  options: OpenAIRealtimeSttOptions,
  format: DictationFormat,
  language?: string,
  context?: DictationContext,
): SttStream {
  const model = options.model.trim();
  const url = new URL(options.baseUrl ?? DEFAULT_URL);
  url.searchParams.set("model", model);
  const connect = options.connect ?? ((socketUrl, headers) => new WebSocket(socketUrl, { headers }) as unknown as SocketLike);
  const socket = connect(url.toString(), { Authorization: `Bearer ${options.apiKey}` });
  const resampler = createPcm16Resampler(format.sampleRate, OPENAI_SAMPLE_RATE);
  let partial = "";
  let finalTranscript = "";
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

  const rejectAll = (error: DictationError): void => {
    failure = failure ?? error;
    readyReject(failure);
    finalReject?.(failure);
    finalReject = null;
    finalResolve = null;
  };

  const sendRaw = (payload: object): Promise<void> => new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new DictationError("network_error", "OpenAI realtime connection is not open"));
      return;
    }
    if (socket.bufferedAmount > MAX_PROVIDER_BUFFER) {
      reject(new DictationError("backpressure_overflow", "OpenAI provider socket buffer overflowed"));
      return;
    }
    socket.send(JSON.stringify(payload), (error) => {
      if (error) reject(new DictationError("network_error", error.message, { cause: error }));
      else resolve();
    });
  });

  socket.on("open", () => {
    const prompt = contextPrompt(context);
    const keywords = contextKeywords(context);
    const languages = contextLanguages(context, language);
    const transcription = {
      model,
      ...(prompt ? { prompt } : {}),
      ...(keywords ? { keywords } : {}),
      ...(languages ? { languages } : {}),
      ...(model === "gpt-live-transcribe" ? { delay: delayFor(options.latencyPreference) } : {}),
    };
    void sendRaw({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
            transcription,
            turn_detection: null,
          },
        },
      },
    }).then(readyResolve, (error) => rejectAll(error as DictationError));
  });

  socket.on("message", (raw) => {
    let event: OpenAIRealtimeEvent;
    try { event = JSON.parse(String(raw)) as OpenAIRealtimeEvent; } catch { return; }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      if (typeof event.delta === "string") partial += event.delta;
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      finalTranscript = typeof event.transcript === "string" ? event.transcript.trim() : partial.trim();
      partial = finalTranscript;
      if (finalRequested && finalResolve) {
        const resolve = finalResolve;
        finalResolve = null;
        finalReject = null;
        resolve(finalTranscript);
      }
      return;
    }
    if (event.type === "error") rejectAll(providerError(event));
  });
  socket.on("error", (error) => {
    rejectAll(new DictationError("network_error", error.message || "OpenAI realtime connection failed", { cause: error }));
  });
  socket.on("close", (code, reason) => {
    closed = true;
    if (!failure && !(finalRequested && finalResolve === null)) {
      rejectAll(new DictationError(
        code === 1008 ? "invalid_credentials" : "network_error",
        reason?.toString() || `OpenAI realtime connection closed (${code})`,
      ));
    }
  });

  return {
    async push(pcm) {
      await ready;
      if (failure) throw failure;
      const converted = resampler.push(pcm);
      if (!converted.byteLength) return;
      await sendRaw({
        type: "input_audio_buffer.append",
        audio: Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength).toString("base64"),
      });
    },
    partial: () => partial,
    async finalize() {
      await ready;
      if (failure) throw failure;
      if (finalRequested) {
        if (!finalResolve) return finalTranscript || partial.trim();
        throw new DictationError("protocol_error", "OpenAI finalization is already pending");
      }
      finalRequested = true;
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await sendRaw({ type: "input_audio_buffer.commit" });
      const timeoutMs = options.finalTimeoutMs ?? FINAL_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DictationError("network_error", "Timed out waiting for OpenAI final transcript")), timeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
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
