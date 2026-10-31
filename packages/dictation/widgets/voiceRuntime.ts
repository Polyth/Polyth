// Browser voice runtime for other packages (voice mode). Each package is its
// own bundle, so these are the transports and speech output, not shared
// state: coordination between bundles goes through the window claim events
// (`MICROPHONE_CLAIM_EVENT`, `SPEECH_CLAIM_EVENT`).
export { startPcm16Capture, pcm16Rms, type Pcm16Capture } from "./audioCapture.ts";
export { startStreamingDictation, type StreamingDictation } from "./dictationClient.ts";
export { canStartDirectProvider, startDirectProvider, type DirectProviderOptions } from "./directProviders.ts";
export {
  SPEECH_CLAIM_EVENT,
  createSpeechOutput,
  primeSpeechOutput,
  speechAudioContext,
  type SpeechChunkKind,
  type SpeechEnqueueOptions,
  type SpeechOutput,
  type SpeechOutputEngine,
  type SpeechOutputEvents,
  type SpeechOutputSettings,
} from "./speechOutput.ts";
