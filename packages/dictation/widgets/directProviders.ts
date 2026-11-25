import { DictationError, type DictationContext, type DictationProviderId } from "@polyth/dictation";
import type { Pcm16Capture, Pcm16CaptureOptions } from "./audioCapture.ts";
import type { StreamingDictation } from "./dictationClient.ts";
import { startDirectDeepgramDictation } from "./directDeepgram.ts";
import { startDirectElevenLabsDictation } from "./directElevenLabs.ts";
import { startDirectWisprDictation } from "./directWispr.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export interface DirectProviderOptions {
  provider: DictationProviderId;
  model?: string;
  language?: string;
  context?: DictationContext;
  onPartial?: (text: string) => void;
  onLevel?: (rms: number) => void;
  onError?: (message: string) => void;
  /** Where the audio comes from; absent: the provider opens the microphone. */
  captureFactory?: (options: Pcm16CaptureOptions) => Promise<Pcm16Capture>;
}

type DirectStarter = (options: DirectProviderOptions) => Promise<StreamingDictation>;

const starters: Partial<Record<DictationProviderId, DirectStarter>> = {
  elevenlabs: (options) => startDirectElevenLabsDictation({
    model: options.model || "scribe_v2_realtime",
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onLevel: options.onLevel,
    onError: options.onError,
    ...(options.captureFactory ? { captureFactory: options.captureFactory } : {}),
  }),
  wispr: (options) => startDirectWisprDictation({
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onLevel: options.onLevel,
    onError: options.onError,
    ...(options.captureFactory ? { captureFactory: options.captureFactory } : {}),
  }),
  deepgram: (options) => startDirectDeepgramDictation({
    model: options.model || "nova-3",
    language: options.language,
    context: options.context,
    onPartial: options.onPartial,
    onLevel: options.onLevel,
    onError: options.onError,
    ...(options.captureFactory ? { captureFactory: options.captureFactory } : {}),
  }),
};

export const canStartDirectProvider = (provider: DictationProviderId): boolean =>
  typeof starters[provider] === "function";

export const startDirectProvider = async (options: DirectProviderOptions): Promise<StreamingDictation> => {
  const start = starters[options.provider];
  if (!start) {
    throw new DictationError("provider_unavailable", tr("dictation.error.noTransport", { provider: options.provider }));
  }
  return start(options);
};
