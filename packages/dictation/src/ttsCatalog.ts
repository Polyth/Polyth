// Hosted text-to-speech services the server voice can call. Browser-safe data
// only: the settings page renders it and the server validates against it;
// synthesis itself lives in ttsProviders.ts (server only).

export type TtsProviderId =
  | "openai-compatible"
  | "openai"
  | "elevenlabs"
  | "google"
  | "polly"
  | "gradium";

export interface TtsProviderInfo {
  id: TtsProviderId;
  label: string;
  /** Only a self-chosen OpenAI-compatible server takes a base URL; hosted
   *  services use their fixed endpoint so a key never goes elsewhere. */
  needsBaseUrl: boolean;
  /** Amazon Polly signs requests with an access key id plus a secret key. */
  needsSecret: boolean;
  needsRegion: boolean;
  defaultModel: string;
  defaultVoice: string;
  defaultApiKeyEnv: string;
  defaultSecretKeyEnv: string;
  defaultRegion: string;
  /** Characters per request, under the service's own limit. */
  maxChars: number;
  /** Free allowance as published by the service; capability data, not UI copy. */
  freeTier: string;
}

export const TTS_PROVIDERS: readonly TtsProviderInfo[] = [
  {
    id: "openai-compatible", label: "OpenAI-compatible server", needsBaseUrl: true, needsSecret: false, needsRegion: false,
    defaultModel: "tts-1", defaultVoice: "alloy", defaultApiKeyEnv: "", defaultSecretKeyEnv: "", defaultRegion: "",
    maxChars: 8_000, freeTier: "",
  },
  {
    id: "openai", label: "OpenAI TTS", needsBaseUrl: false, needsSecret: false, needsRegion: false,
    defaultModel: "gpt-4o-mini-tts", defaultVoice: "alloy", defaultApiKeyEnv: "OPENAI_API_KEY", defaultSecretKeyEnv: "", defaultRegion: "",
    maxChars: 4_000, freeTier: "none (pay as you go)",
  },
  {
    id: "elevenlabs", label: "ElevenLabs", needsBaseUrl: false, needsSecret: false, needsRegion: false,
    defaultModel: "eleven_flash_v2_5", defaultVoice: "JBFqnCBsd6RMkjVDRZzb", defaultApiKeyEnv: "ELEVENLABS_API_KEY", defaultSecretKeyEnv: "", defaultRegion: "",
    maxChars: 5_000, freeTier: "10,000 characters / month",
  },
  {
    id: "google", label: "Google Cloud Text-to-Speech", needsBaseUrl: false, needsSecret: false, needsRegion: false,
    defaultModel: "", defaultVoice: "en-US-Neural2-F", defaultApiKeyEnv: "GOOGLE_TTS_API_KEY", defaultSecretKeyEnv: "", defaultRegion: "",
    // The service limit is 5,000 bytes of UTF-8.
    maxChars: 1_200, freeTier: "4M Standard / 1M Neural & Chirp characters / month",
  },
  {
    id: "polly", label: "Amazon Polly", needsBaseUrl: false, needsSecret: true, needsRegion: true,
    defaultModel: "neural", defaultVoice: "Joanna", defaultApiKeyEnv: "AWS_ACCESS_KEY_ID", defaultSecretKeyEnv: "AWS_SECRET_ACCESS_KEY", defaultRegion: "us-east-1",
    maxChars: 3_000, freeTier: "5M Standard / 1M Neural characters / month for 12 months",
  },
  {
    id: "gradium", label: "Gradium", needsBaseUrl: false, needsSecret: false, needsRegion: false,
    defaultModel: "", defaultVoice: "YTpq7expH9539ERJ", defaultApiKeyEnv: "GRADIUM_API_KEY", defaultSecretKeyEnv: "", defaultRegion: "",
    maxChars: 5_000, freeTier: "45,000 credits",
  },
];

const BY_ID = new Map(TTS_PROVIDERS.map((provider) => [provider.id, provider]));

export const isTtsProviderId = (value: unknown): value is TtsProviderId =>
  typeof value === "string" && BY_ID.has(value as TtsProviderId);

export const ttsProviderInfo = (id: TtsProviderId): TtsProviderInfo => BY_ID.get(id) ?? TTS_PROVIDERS[0]!;

/** AWS region names such as `us-east-1` or `ap-southeast-2`. */
export const TTS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
