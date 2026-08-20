// Voice glue: mic button in the composer.leading slot (Web Speech dictation)
// and optional read-aloud of assistant replies. Logic lives in
// @polyth/dictation; this file owns DOM/store wiring only.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  VOICE_PREFS_KEY,
  mergeTranscript,
  parseVoicePrefs,
  recognitionCtor,
  serializeVoicePrefs,
  speakableText,
  speechSupport,
  type SpeechRecognitionLike,
  type VoicePrefs,
} from "@polyth/dictation";
import { registerSlot } from "./slots.ts";
import { requestComposerInsert } from "./composerInsert.ts";
import { pluginOn, subscribePrefs } from "./prefs.ts";
import { getState, subscribeStore } from "./store.ts";
import { api } from "./api.ts";
import { startStreamingDictation, type StreamingDictation } from "./dictationClient.ts";
import { Icon } from "./icons.tsx";

// ---- voice prefs store ------------------------------------------------------

const read = (): string | null => {
  try { return localStorage.getItem(VOICE_PREFS_KEY); } catch { return null; }
};
let voicePrefs: VoicePrefs = parseVoicePrefs(read());
const listeners = new Set<() => void>();

export function getVoicePrefs(): VoicePrefs {
  return voicePrefs;
}

export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  voicePrefs = { ...voicePrefs, ...patch };
  try { localStorage.setItem(VOICE_PREFS_KEY, serializeVoicePrefs(voicePrefs)); } catch { /* private mode */ }
  for (const l of [...listeners]) l();
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getVoicePrefs,
  );
}

// ---- text-to-speech ----------------------------------------------------------

// F8: one WebAudio pipeline for the server engine — pitch maps to
// playbackRate and volume to a gain node. Only one clip plays at a time.
let audioCtx: AudioContext | null = null;
let serverSource: AudioBufferSourceNode | null = null;

function stopServerAudio(): void {
  try { serverSource?.stop(); } catch { /* already stopped */ }
  serverSource = null;
}

async function speakServer(text: string): Promise<void> {
  const clip = await api.ttsSpeak(text);
  stopServerAudio();
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const buffer = await audioCtx.decodeAudioData(clip);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = voicePrefs.rate * voicePrefs.pitch;
  const gain = audioCtx.createGain();
  gain.gain.value = voicePrefs.volume;
  source.connect(gain);
  gain.connect(audioCtx.destination);
  serverSource = source;
  source.start();
}

function speakBrowser(text: string): void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voicePrefs.lang;
  u.rate = voicePrefs.rate;
  u.pitch = voicePrefs.pitch;
  u.volume = voicePrefs.volume;
  if (voicePrefs.voice) {
    const v = synth.getVoices().find((x) => x.name === voicePrefs.voice);
    if (v) u.voice = v;
  }
  synth.speak(u);
}

export function speak(text: string): void {
  if (!text.trim()) return;
  if (voicePrefs.ttsEngine === "server") {
    // server clip fails soft back to the browser engine so replies still play
    void speakServer(text).catch(() => speakBrowser(text));
  } else {
    speakBrowser(text);
  }
}

/** F8: summarize-speak — long replies go through the Small Model first and
 *  fall back to the raw text whenever the summarize endpoint declines. */
export function speakReply(text: string): void {
  if (!voicePrefs.summarize || text.length < 400) {
    speak(text);
    return;
  }
  void api.ttsSummarize(text)
    .then((r) => speak(r.text || text))
    .catch(() => speak(text));
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  stopServerAudio();
}

/** Speak the newest assistant reply in the active session (palette command). */
export function readLastReply(): void {
  const s = getState();
  const events = s.activeSessionId ? s.events[s.activeSessionId] ?? [] : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/message") {
      speakReply(speakableText(String((e.data as { text?: unknown }).text ?? "")));
      return;
    }
  }
}

// ---- mic button (composer.leading) -------------------------------------------

function MicButton() {
  const prefs = useVoicePrefs();
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<StreamingDictation | null>(null);
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const serverStt = prefs.sttEngine === "server";

  useEffect(() => () => {
    recRef.current?.abort();
    streamRef.current?.cancel();
  }, []);

  if (!pluginOn("dictation") || !prefs.dictation) return null;

  const stop = () => {
    recRef.current?.stop();
    recRef.current = null;
    // server engine: finalize and insert the final transcript
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      void stream.stop()
        .then((text) => { if (text.trim()) requestComposerInsert(text.trim()); })
        .catch(() => { /* onError already surfaced it */ });
    }
    setListening(false);
  };

  const startServer = async () => {
    try {
      streamRef.current = await startStreamingDictation({
        ...(getState().activeSessionId ? { sessionId: getState().activeSessionId! } : {}),
        language: prefs.lang.split("-")[0] ?? prefs.lang,
        onError: () => setListening(false),
      });
      setListening(true);
    } catch {
      // mic denied or server capability lost — fall back to the browser engine
      streamRef.current = null;
      startBrowser();
    }
  };

  const startBrowser = () => {
    const Ctor = recognitionCtor(window);
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = prefs.lang;
    rec.continuous = true;
    rec.interimResults = false;
    let transcript = "";
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) {
          const merged = mergeTranscript(transcript, r[0].transcript);
          const chunk = merged.slice(transcript.length).trim();
          transcript = merged;
          if (chunk) requestComposerInsert(chunk);
        }
      }
    };
    rec.onerror = () => stop();
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const canDictate = serverStt || support.stt;
  return (
    <button
      className={`icon-btn mic-btn ${listening ? "listening" : ""}`}
      title={canDictate
        ? (listening ? "Stop dictation" : `Dictate (${serverStt ? "server transcription" : "speech to text"})`)
        : "Dictation is not supported in this browser"}
      aria-pressed={listening}
      disabled={!canDictate}
      onClick={() => (listening ? stop() : serverStt ? void startServer() : startBrowser())}
    >
      <Icon.mic />
    </button>
  );
}

// ---- install -----------------------------------------------------------------

/** Register the mic slot + auto read-aloud of newly completed replies. */
export function installVoice(): void {
  registerSlot("composer.leading", "voice.mic", () => <MicButton key="voice.mic" />, 5);

  // Auto-TTS: speak assistant/message events as they land in the active
  // session. Sessions are primed on first sight so history is never read.
  const spoken = new Map<string, number>();
  const check = () => {
    const s = getState();
    const id = s.activeSessionId;
    if (!id) return;
    const events = s.events[id] ?? [];
    const last = events.length > 0 ? events[events.length - 1]!.seq : 0;
    if (!spoken.has(id)) {
      spoken.set(id, last);
      return;
    }
    const from = spoken.get(id)!;
    if (last <= from) return;
    spoken.set(id, last);
    if (!voicePrefs.tts || !pluginOn("dictation")) return;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.seq <= from) break;
      if (e.type === "assistant/message") {
        speakReply(speakableText(String((e.data as { text?: unknown }).text ?? "")));
        break;
      }
    }
  };
  subscribeStore(check);
  subscribePrefs(check);
}
