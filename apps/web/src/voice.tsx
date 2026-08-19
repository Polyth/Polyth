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

export function speak(text: string): void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || !text.trim()) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voicePrefs.lang;
  u.rate = voicePrefs.rate;
  if (voicePrefs.voice) {
    const v = synth.getVoices().find((x) => x.name === voicePrefs.voice);
    if (v) u.voice = v;
  }
  synth.speak(u);
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/** Speak the newest assistant reply in the active session (palette command). */
export function readLastReply(): void {
  const s = getState();
  const events = s.activeSessionId ? s.events[s.activeSessionId] ?? [] : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/message") {
      speak(speakableText(String((e.data as { text?: unknown }).text ?? "")));
      return;
    }
  }
}

// ---- mic button (composer.leading) -------------------------------------------

function MicButton() {
  const prefs = useVoicePrefs();
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);

  useEffect(() => () => recRef.current?.abort(), []);

  if (!pluginOn("dictation") || !prefs.dictation) return null;

  const stop = () => {
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
  };

  const start = () => {
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

  return (
    <button
      className={`icon-btn mic-btn ${listening ? "listening" : ""}`}
      title={support.stt ? (listening ? "Stop dictation" : "Dictate (speech to text)") : "Dictation is not supported in this browser"}
      aria-pressed={listening}
      disabled={!support.stt}
      onClick={() => (listening ? stop() : start())}
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
        speak(speakableText(String((e.data as { text?: unknown }).text ?? "")));
        break;
      }
    }
  };
  subscribeStore(check);
  subscribePrefs(check);
}
