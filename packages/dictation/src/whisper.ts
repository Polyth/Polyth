// Server STT through any OpenAI-compatible transcription endpoint
// (POST {baseUrl}/audio/transcriptions, multipart file upload). The adapter
// buffers PCM in memory (the dictation service caps total bytes upstream) and
// uploads once on finalize — no partials, no retention: audio is dropped as
// soon as the request settles. A finished recording takes the same single
// upload through `transcribe`. Works in Node 22 and browsers (fetch/FormData/
// Blob are globals in both).
import type { DictationContext } from "./providers.ts";
import { postRecording, recordingLanguage, wavBlob } from "./recordingHttp.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

export interface WhisperSttOptions {
  /** e.g. "http://127.0.0.1:8000/v1" — "/audio/transcriptions" is appended. */
  baseUrl: string;
  /** Model name forwarded verbatim, e.g. "whisper-1". */
  model?: string;
  /** Default language hint (per-stream language wins). */
  language?: string;
  /** Resolved secret VALUE (the server resolves refs; nothing is stored here). */
  apiKey?: string;
  /** Injection point for tests. */
  fetchFn?: typeof fetch;
}

/** 44-byte RIFF/WAVE header + samples for PCM s16le audio. */
export function pcmToWav(pcm: Uint8Array, format: DictationFormat): Uint8Array {
  const byteRate = format.sampleRate * format.channels * 2;
  const blockAlign = format.channels * 2;
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, format.channels, true);
  dv.setUint32(24, format.sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

const joinUrl = (base: string, path: string): string => {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  return `${base.slice(0, end)}${path}`;
};

const promptFromContext = (context?: DictationContext): string => {
  if (!context) return "";
  const glossary = Object.entries(context.glossary ?? {}).map(([from, to]) => `${from}: ${to}`);
  return [
    context.lexicalContext ?? "",
    ...(context.keywords?.length ? [`Terms: ${context.keywords.join(", ")}`] : []),
    ...(glossary.length ? [`Glossary: ${glossary.join(", ")}`] : []),
  ].filter(Boolean).join("\n").slice(0, 1_500);
};

/** Upload one WAV to `{baseUrl}/audio/transcriptions` and return its text. */
export async function transcribeWavOpenAI(opts: {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  wav: Uint8Array;
  language?: string;
  context?: DictationContext;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Provider name in error messages. */
  provider?: string;
}): Promise<string> {
  const form = new FormData();
  form.append("file", wavBlob(opts.wav), "audio.wav");
  if (opts.model) form.append("model", opts.model);
  const language = recordingLanguage(opts.language);
  if (language) form.append("language", language);
  const prompt = promptFromContext(opts.context);
  if (prompt) form.append("prompt", prompt);
  form.append("response_format", "json");

  const raw = await postRecording(opts.provider ?? "speech-to-text server", opts.fetchFn ?? fetch, joinUrl(opts.baseUrl, "/audio/transcriptions"), {
    ...(opts.apiKey ? { headers: { authorization: `Bearer ${opts.apiKey}` } } : {}),
    body: form,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : raw.trim();
  } catch {
    return raw.trim();
  }
}

export function createWhisperSttAdapter(opts: WhisperSttOptions): SttAdapter {
  const upload = (wav: Uint8Array, language: string | undefined, context: DictationContext | undefined, signal?: AbortSignal) =>
    transcribeWavOpenAI({
      baseUrl: opts.baseUrl,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      wav,
      ...(language ?? opts.language ? { language: language ?? opts.language } : {}),
      ...(context ? { context } : {}),
      ...(signal ? { signal } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
  return {
    engine: "whisper",
    // A recording is already whole: one upload, exactly as finalize does.
    transcribe: ({ audio, format, language, context, signal }) =>
      audio.byteLength === 0 ? Promise.resolve("") : upload(pcmToWav(audio, format), language, context, signal),
    createStream({ format, language, context }): SttStream {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let cancelled = false;
      return {
        push(pcm) {
          if (cancelled) return;
          chunks.push(pcm);
          bytes += pcm.byteLength;
        },
        async finalize() {
          if (cancelled || bytes === 0) return "";
          const pcm = new Uint8Array(bytes);
          let at = 0;
          for (const c of chunks) { pcm.set(c, at); at += c.byteLength; }
          chunks.length = 0;
          return upload(pcmToWav(pcm, format), language, context);
        },
        cancel() {
          cancelled = true;
          chunks.length = 0;
          bytes = 0;
        },
      };
    },
  };
}

/** Downsample Float32 microphone samples to 16 kHz mono s16le for the wire.
 *  Pure so the browser capture path is unit-testable. */
export function downsampleToPcm16(input: Float32Array, fromRate: number, toRate = 16000): Int16Array {
  if (fromRate < toRate) throw new Error(`cannot upsample ${fromRate} -> ${toRate}`);
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const sample = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0));
    out[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return out;
}
