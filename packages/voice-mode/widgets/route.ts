// Which recognizer a spoken turn uses. It follows the dictation configuration
// (Settings → Voice) exactly like the composer mic does, and lists fallbacks
// in order so a route that fails to start does not end the conversation:
// direct cloud → server proxy → the browser's own recognizer. A local-only
// privacy policy never falls back to the browser's (possibly cloud) service.
import {
  VOICE_PREFS_KEY,
  onDeviceSpeechAvailability,
  parseVoicePrefs,
  providerCapabilities,
  speechSupport,
  type DictationProcessingPolicy,
  type DictationProviderId,
  type DictationTransport,
  type VoicePrefs,
} from "@polyth/dictation";
import { canStartDirectProvider } from "@polyth/dictation/voice-runtime";
import { api } from "@polyth/session/web-api";
import type { VoiceRecognitionChoice } from "../src/prefs.ts";
import type { RecognitionRoute } from "./listener.ts";

/** Dictation and read-aloud preferences live in the dictation package's own
 *  bundle; read the persisted copy fresh whenever a conversation starts. */
export function readVoicePrefs(): VoicePrefs {
  try {
    return parseVoicePrefs(localStorage.getItem(VOICE_PREFS_KEY));
  } catch {
    return parseVoicePrefs(null);
  }
}

interface ServerDictation {
  provider?: DictationProviderId;
  transport?: DictationTransport;
  model?: string;
  language?: string;
  processingPolicy?: DictationProcessingPolicy;
}

export interface RouteResolution {
  routes: RecognitionRoute[];
  reason?: string;
}

const browserLang = (language: string): string =>
  !language || language === "auto" ? (typeof navigator !== "undefined" ? navigator.language : "en-US") : language;

export async function resolveRecognitionRoutes(
  choice: VoiceRecognitionChoice,
  sessionId: string | null,
): Promise<RouteResolution> {
  const prefs = readVoicePrefs();
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  // A paired phone cannot read the settings; the capability names the
  // server's choice instead of letting this device's defaults guess it.
  const server = await api.voiceSettings()
    .then((settings) => (settings as { dictation?: ServerDictation }).dictation ?? null)
    .catch(() => api.dictationCapability()
      .then((capability) => (capability as { selection?: ServerDictation }).selection ?? null))
    .catch(() => null);
  const provider = server?.provider ?? prefs.dictationProvider;
  const transport = server?.transport ?? prefs.dictationTransport;
  const model = server?.model || prefs.dictationModel;
  const language = server?.language || prefs.lang || "auto";
  const policy = server?.processingPolicy ?? prefs.processingPolicy;

  const routes: RecognitionRoute[] = [];
  const browserAllowed = support.stt && (choice === "browser" || policy !== "local-only");
  const browserRoute = async (): Promise<RecognitionRoute> => {
    const lang = browserLang(language);
    const onDevice = prefs.onDeviceSpeech && (await onDeviceSpeechAvailability(window, lang)) === "available";
    return { kind: "browser", lang, onDevice, punctuation: prefs.spokenPunctuation };
  };

  if (choice === "browser" || provider === "web-speech") {
    if (browserAllowed) routes.push(await browserRoute());
    return routes.length ? { routes } : { routes, reason: "browser speech recognition is not available" };
  }

  const capability = providerCapabilities(provider);
  const cloudPrimary = policy === "prefer-cloud" || policy === "browser-fallback";
  const direct = cloudPrimary
    && capability?.ephemeralClientAuth === true
    && capability.transports.includes("direct-browser")
    && canStartDirectProvider(provider)
    && (transport === "auto" || transport === "direct-browser");
  let reason: string | undefined;
  if (direct) {
    const listed = await fetch("/api/voice/providers")
      .then(async (response) => response.ok
        ? await response.json() as { providers?: Array<{ id?: string; available?: boolean; reason?: string }> }
        : {})
      .catch(() => ({} as { providers?: Array<{ id?: string; available?: boolean; reason?: string }> }));
    const entry = listed.providers?.find((item) => item.id === provider);
    if (entry?.available) {
      routes.push({ kind: "direct", provider, ...(model ? { model } : {}), language });
      if (transport === "auto") routes.push({ kind: "server", language, ...(sessionId ? { sessionId } : {}) });
    } else {
      reason = entry?.reason;
    }
  } else {
    const available = await api.dictationCapability().catch(() => ({ available: false, reason: undefined }));
    if (available.available) routes.push({ kind: "server", language, ...(sessionId ? { sessionId } : {}) });
    else reason = available.reason;
  }
  if (browserAllowed) routes.push(await browserRoute());
  return routes.length ? { routes } : { routes, ...(reason ? { reason } : {}) };
}
