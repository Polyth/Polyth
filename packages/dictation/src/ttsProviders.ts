// Server-side synthesis for the server voice (`/api/tts/speak`). Each service
// returns one complete clip; the ones that can also return raw PCM while it
// is being generated (`streamsPcm`) let playback start before synthesis ends.
// Keys are resolved from env references by the caller and only ever travel to
// the service's own fixed endpoint.
import { createHash, createHmac } from "node:crypto";
import { ttsProviderInfo, type TtsProviderId } from "./ttsCatalog.ts";

export interface TtsSynthesisSettings {
  provider: TtsProviderId;
  baseUrl: string;
  model: string;
  voice: string;
  region: string;
}

export interface TtsSynthesisRequest {
  settings: TtsSynthesisSettings;
  text: string;
  /** BCP-47 tag of the text; Google needs one when the voice does not name it. */
  lang?: string;
  key?: string;
  secret?: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface TtsClip {
  audio: Buffer;
  contentType: string;
}

/** Audio as the service generates it: signed 16-bit little-endian mono PCM. */
export interface TtsPcmStream {
  body: ReadableStream<Uint8Array>;
  sampleRate: number;
}

/** Services whose HTTP API streams headerless PCM16 (checked against their
 *  API references, 2026-11): OpenAI `response_format: "pcm"` (24 kHz),
 *  ElevenLabs `/stream?output_format=pcm_24000`, Amazon Polly
 *  `OutputFormat: "pcm"` (16 kHz, its highest PCM rate). Google's REST call
 *  returns one base64 document, Gradium is used for whole clips, and an
 *  OpenAI-compatible server is not known to support `pcm`. */
export const streamsPcm = (provider: TtsProviderId): boolean =>
  provider === "openai" || provider === "elevenlabs" || provider === "polly";

/** A failed upstream call; `status` is the service's HTTP status when it answered. */
export class TtsUpstreamError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const upstream = async (response: Response, label: string): Promise<Response> => {
  if (response.ok) return response;
  throw new TtsUpstreamError(`${label} error: HTTP ${response.status}`, response.status);
};

const clip = async (response: Response, fallbackType: string): Promise<TtsClip> => ({
  audio: Buffer.from(await response.arrayBuffer()),
  contentType: response.headers.get("content-type") || fallbackType,
});

const requireKey = (key: string | undefined, label: string): string => {
  if (!key) throw new TtsUpstreamError(`${label} API key is not set in the server environment`);
  return key;
};

const openAiResponse = async (request: TtsSynthesisRequest, baseUrl: string, label: string, format: "mp3" | "pcm"): Promise<Response> => {
  const { settings, key } = request;
  const response = await request.fetchFn(`${baseUrl.replace(/\/+$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model || ttsProviderInfo(settings.provider).defaultModel || "tts-1",
      input: request.text,
      voice: settings.voice || "alloy",
      response_format: format,
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return upstream(response, label);
};

const openAiSpeech = async (request: TtsSynthesisRequest, baseUrl: string, label: string): Promise<TtsClip> =>
  clip(await openAiResponse(request, baseUrl, label, "mp3"), "audio/mpeg");

const elevenLabsResponse = async (request: TtsSynthesisRequest, stream: boolean): Promise<Response> => {
  const key = requireKey(request.key, "ElevenLabs");
  const voice = request.settings.voice || ttsProviderInfo("elevenlabs").defaultVoice;
  const response = await request.fetchFn(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}${stream ? "/stream?output_format=pcm_24000" : "?output_format=mp3_44100_128"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": key, ...(stream ? {} : { accept: "audio/mpeg" }) },
      body: JSON.stringify({
        text: request.text,
        model_id: request.settings.model || ttsProviderInfo("elevenlabs").defaultModel,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );
  return upstream(response, "ElevenLabs");
};

const elevenLabs = async (request: TtsSynthesisRequest): Promise<TtsClip> =>
  clip(await elevenLabsResponse(request, false), "audio/mpeg");

/** Google voice names start with their language ("en-US-Neural2-F"). */
export const googleLanguageCode = (voice: string, lang?: string): string => {
  const fromVoice = /^([a-z]{2,3}-[A-Z]{2}|cmn-[A-Z]{2}|yue-[A-Z]{2})-/.exec(voice)?.[1];
  if (fromVoice) return fromVoice;
  const tag = (lang ?? "").replace(/_/g, "-");
  return /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(tag) && tag !== "auto" ? tag : "en-US";
};

const google = async (request: TtsSynthesisRequest): Promise<TtsClip> => {
  const key = requireKey(request.key, "Google Cloud Text-to-Speech");
  const voice = request.settings.voice;
  const response = await request.fetchFn("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    // The header keeps the key out of URLs and access logs.
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      input: { text: request.text },
      voice: {
        languageCode: googleLanguageCode(voice, request.lang),
        ...(voice ? { name: voice } : {}),
      },
      audioConfig: { audioEncoding: "MP3" },
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const payload = await (await upstream(response, "Google Cloud Text-to-Speech")).json() as { audioContent?: unknown };
  if (typeof payload.audioContent !== "string" || !payload.audioContent) {
    throw new TtsUpstreamError("Google Cloud Text-to-Speech returned no audio");
  }
  return { audio: Buffer.from(payload.audioContent, "base64"), contentType: "audio/mpeg" };
};

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();

export interface SigV4Input {
  method: string;
  host: string;
  path: string;
  /** Already-canonical query string (sorted, encoded); empty for none. */
  query?: string;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/** AWS Signature Version 4 headers (`x-amz-date`, `authorization`) for one request. */
export function signAwsV4(input: SigV4Input): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.host, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = names.map((name) => `${name}:${String(lower[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method, input.path, input.query ?? "", canonicalHeaders, signedHeaders, sha256(input.body),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Polly's PCM tops out at 16 kHz. */
const POLLY_PCM_RATE = 16_000;

const pollyResponse = async (request: TtsSynthesisRequest, stream: boolean): Promise<Response> => {
  const accessKeyId = requireKey(request.key, "Amazon Polly access key");
  const secretAccessKey = requireKey(request.secret, "Amazon Polly secret");
  const info = ttsProviderInfo("polly");
  const region = request.settings.region || info.defaultRegion;
  const host = `polly.${region}.amazonaws.com`;
  const body = JSON.stringify({
    Engine: request.settings.model || info.defaultModel,
    OutputFormat: stream ? "pcm" : "mp3",
    ...(stream ? { SampleRate: String(POLLY_PCM_RATE) } : {}),
    Text: request.text,
    VoiceId: request.settings.voice || info.defaultVoice,
  });
  const headers = { "content-type": "application/json" };
  const signed = signAwsV4({
    method: "POST", host, path: "/v1/speech", headers, body, service: "polly", region,
    accessKeyId, secretAccessKey, date: (request.now ?? (() => new Date()))(),
  });
  const response = await request.fetchFn(`https://${host}/v1/speech`, {
    method: "POST",
    headers: { ...headers, ...signed },
    body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return upstream(response, "Amazon Polly");
};

const polly = async (request: TtsSynthesisRequest): Promise<TtsClip> =>
  clip(await pollyResponse(request, false), "audio/mpeg");

const gradium = async (request: TtsSynthesisRequest): Promise<TtsClip> => {
  const key = requireKey(request.key, "Gradium");
  const response = await request.fetchFn("https://api.gradium.ai/api/post/speech/tts", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      text: request.text,
      voice_id: request.settings.voice || ttsProviderInfo("gradium").defaultVoice,
      output_format: "wav",
      only_audio: true,
      ...(request.settings.model ? { model_name: request.settings.model } : {}),
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return clip(await upstream(response, "Gradium"), "audio/wav");
};

/** Synthesize one clip with the configured service. */
export async function synthesizeSpeech(request: TtsSynthesisRequest): Promise<TtsClip> {
  const text = request.text.slice(0, ttsProviderInfo(request.settings.provider).maxChars);
  const bounded = { ...request, text };
  switch (request.settings.provider) {
    case "openai": return openAiSpeech({ ...bounded, key: requireKey(request.key, "OpenAI TTS") }, "https://api.openai.com/v1", "OpenAI TTS");
    case "elevenlabs": return elevenLabs(bounded);
    case "google": return google(bounded);
    case "polly": return polly(bounded);
    case "gradium": return gradium(bounded);
    case "openai-compatible": return openAiSpeech(bounded, request.settings.baseUrl, "TTS server");
  }
}

/** Start synthesis and hand back the audio as it is generated. Resolves once
 *  the service has accepted the request (a refusal throws before any audio);
 *  only for `streamsPcm` services. */
export async function synthesizeSpeechStream(request: TtsSynthesisRequest): Promise<TtsPcmStream> {
  const text = request.text.slice(0, ttsProviderInfo(request.settings.provider).maxChars);
  const bounded = { ...request, text };
  let response: Response;
  let sampleRate = 24_000;
  switch (request.settings.provider) {
    case "openai":
      response = await openAiResponse({ ...bounded, key: requireKey(request.key, "OpenAI TTS") }, "https://api.openai.com/v1", "OpenAI TTS", "pcm");
      break;
    case "elevenlabs":
      response = await elevenLabsResponse(bounded, true);
      break;
    case "polly":
      response = await pollyResponse(bounded, true);
      sampleRate = POLLY_PCM_RATE;
      break;
    default:
      throw new TtsUpstreamError(`${ttsProviderInfo(request.settings.provider).label} does not stream audio`);
  }
  if (!response.body) throw new TtsUpstreamError(`${ttsProviderInfo(request.settings.provider).label} returned no audio`);
  return { body: response.body, sampleRate };
}
