// Server-side synthesis for the server voice (`/api/tts/speak`). Each service
// returns one complete clip; keys are resolved from env references by the
// caller and only ever travel to the service's own fixed endpoint.
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

const openAiSpeech = async (request: TtsSynthesisRequest, baseUrl: string, label: string): Promise<TtsClip> => {
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
      response_format: "mp3",
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return clip(await upstream(response, label), "audio/mpeg");
};

const elevenLabs = async (request: TtsSynthesisRequest): Promise<TtsClip> => {
  const key = requireKey(request.key, "ElevenLabs");
  const voice = request.settings.voice || ttsProviderInfo("elevenlabs").defaultVoice;
  const response = await request.fetchFn(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": key, accept: "audio/mpeg" },
      body: JSON.stringify({
        text: request.text,
        model_id: request.settings.model || ttsProviderInfo("elevenlabs").defaultModel,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );
  return clip(await upstream(response, "ElevenLabs"), "audio/mpeg");
};

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

const polly = async (request: TtsSynthesisRequest): Promise<TtsClip> => {
  const accessKeyId = requireKey(request.key, "Amazon Polly access key");
  const secretAccessKey = requireKey(request.secret, "Amazon Polly secret");
  const info = ttsProviderInfo("polly");
  const region = request.settings.region || info.defaultRegion;
  const host = `polly.${region}.amazonaws.com`;
  const body = JSON.stringify({
    Engine: request.settings.model || info.defaultModel,
    OutputFormat: "mp3",
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
  return clip(await upstream(response, "Amazon Polly"), "audio/mpeg");
};

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
