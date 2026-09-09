import { DictationError, type DictationContext, type DictationProviderId } from "@polyth/dictation";
import type { StreamingDictation } from "./dictationClient.ts";
import { startDirectDeepgramDictation } from "./directDeepgram.ts";
import { startDirectElevenLabsDictation } from "./directElevenLabs.ts";
import { startDirectWisprDictation } from "./directWispr.ts";

export interface DirectProviderOptions {
  provider: DictationProviderId;
  model?: string;
  language?: string;
  context?: DictationContext;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}

type DirectStarter = (options: DirectProviderOptions) => Promise<StreamingDictation>;

const starters: Partial<Record<DictationProviderId, DirectStarter>> = {
  elevenlabs: (options) => startDirectElevenLabsDictation({
    model: options.model || "scribe_v2_realtime",
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onError: options.onError,
  }),
  wispr: (options) => startDirectWisprDictation({
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onError: options.onError,
  }),
  deepgram: (options) => startDirectDeepgramDictation({
    model: options.model || "nova-3",
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onError: options.onError,
  }),
};

export const canStartDirectProvider = (provider: DictationProviderId): boolean =>
  typeof starters[provider] === "function";

export const startDirectProvider = async (options: DirectProviderOptions): Promise<StreamingDictation> => {
  const start = starters[options.provider];
  if (!start) {
    throw new DictationError("provider_unavailable", `${options.provider} has no direct client transport`);
  }
  return start(options);
};
