// Full Node/server dictation API. Browser consumers resolve browser.ts through
// the package export condition and never traverse these native transports.
export * from "./browser.ts";

export {
  createElevenLabsSttAdapter,
  type ElevenLabsSttOptions,
} from "./elevenlabs.ts";
export {
  createWisprSttAdapter,
  type WisprSttOptions,
} from "./wispr.ts";
export {
  createDeepgramSttAdapter,
  type DeepgramSttOptions,
} from "./deepgram.ts";
export {
  createOpenAIRealtimeSttAdapter,
  createPcm16Resampler,
  type OpenAIRealtimeSttOptions,
  type Pcm16Resampler,
} from "./openaiRealtime.ts";
export {
  createSpeechmaticsSttAdapter,
  type SpeechmaticsSttOptions,
} from "./speechmatics.ts";
export {
  createLocalModelManager,
  type LocalModelManager,
} from "./localModels.ts";
