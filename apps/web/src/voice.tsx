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
import { pluginOn, subscribePrefs, usePrefs } from "./prefs.ts";
import { getState, openSettingsPage, subscribeStore } from "./store.ts";
import { api } from "./api.ts";
import { startStreamingDictation, type StreamingDictation } from "./dictationClient.ts";
import { announce } from "./components/a11y/live.tsx";
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
// UX-COMPOSER-DISC: the slot never disappears while the control can explain
// itself. Availability, lifecycle, and failure are visible named states —
// never a claim inferred from a settings toggle alone. Transcripts stay
// drafts (composer insert); nothing here sends or appends a session event.

type MicPhase = "idle" | "starting" | "listening" | "transcribing";

const boundedReason = (raw: unknown): string => {
  const s = raw instanceof Error ? raw.message : String(raw ?? "microphone error");
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

function MicButton() {
  const prefs = useVoicePrefs();
  const workspace = usePrefs();
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [capability, setCapability] = useState<{ available: boolean; engine?: string; reason?: string } | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<StreamingDictation | null>(null);
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const serverStt = prefs.sttEngine === "server";
  const pluginEnabled = workspace.plugins.includes("dictation");

  useEffect(() => () => {
    recRef.current?.abort();
    streamRef.current?.cancel();
  }, []);

  // Server capability is a live probe, not an assumption from preferences.
  useEffect(() => {
    if (!pluginEnabled || !prefs.dictation || !serverStt) {
      setCapability(null);
      return;
    }
    let cancelled = false;
    void api.dictationCapability().then((c) => { if (!cancelled) setCapability(c); });
    return () => { cancelled = true; };
  }, [pluginEnabled, prefs.dictation, serverStt]);

  // The four truthful availability states (plus checking) for the idle control.
  const availability: { available: boolean; reason?: string; settings?: boolean } =
    !pluginEnabled ? { available: false, reason: "Voice plugin is off", settings: true }
    : !prefs.dictation ? { available: false, reason: "Dictation is off", settings: true }
    : serverStt && capability === null ? { available: false, reason: "Checking microphone…" }
    : serverStt && capability && !capability.available && !support.stt
      ? { available: false, reason: capability.reason ?? "Server transcription unavailable", settings: true }
    : !serverStt && !support.stt
      ? { available: false, reason: "Dictation is not supported in this browser", settings: true }
    : { available: true };

  const status = error !== null ? `Dictation failed: ${error}`
    : phase === "starting" ? "Starting microphone…"
    : phase === "listening" ? "Listening…"
    : phase === "transcribing" ? "Transcribing…"
    : availability.available ? null
    : availability.reason ?? null;

  // Announce each state transition exactly once (never per render).
  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (status && status !== lastAnnounced.current) announce(status);
    lastAnnounced.current = status;
  }, [status]);

  const fail = (raw: unknown) => {
    setPhase("idle");
    setError(boundedReason(raw));
  };

  const stop = () => {
    recRef.current?.stop();
    recRef.current = null;
    // server engine: finalize, show Transcribing…, insert the final transcript
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      setPhase("transcribing");
      void stream.stop()
        .then((text) => {
          setPhase("idle");
          // draft insert only — the IME-safe composer command returns focus
          // to the editor; nothing auto-sends
          if (text.trim()) requestComposerInsert(text.trim());
        })
        .catch(fail);
      return;
    }
    setPhase("idle");
  };

  const startBrowser = () => {
    const Ctor = recognitionCtor(window);
    if (!Ctor) {
      fail("Dictation is not supported in this browser");
      return;
    }
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
    rec.onerror = (e) => fail(e.error ?? "microphone error");
    rec.onend = () => setPhase((p) => (p === "listening" ? "idle" : p));
    recRef.current = rec;
    rec.start();
    setPhase("listening");
  };

  const startServer = async () => {
    setPhase("starting");
    try {
      streamRef.current = await startStreamingDictation({
        ...(getState().activeSessionId ? { sessionId: getState().activeSessionId! } : {}),
        language: prefs.lang.split("-")[0] ?? prefs.lang,
        onError: fail,
      });
      setPhase("listening");
    } catch (err) {
      // mic denied or server capability lost — fall back to the browser engine
      streamRef.current = null;
      if (support.stt) startBrowser();
      else fail(err);
    }
  };

  const start = () => {
    setError(null);
    if (serverStt && capability?.available) void startServer();
    else startBrowser();
  };

  const busy = phase === "starting" || phase === "transcribing";
  const showSettings = error !== null || (!availability.available && availability.settings === true);

  return (
    <span className={`mic-control mic-${error ? "failed" : phase}`}>
      <button
        type="button"
        className={`chip mic-btn${phase === "listening" ? " listening" : ""}`}
        aria-label={phase === "listening" ? "Stop dictation" : "Dictate"}
        {...(phase === "listening" ? { "aria-pressed": true } : {})}
        disabled={!availability.available || busy}
        onClick={() => (phase === "listening" ? stop() : start())}
      >
        <span aria-hidden="true" className="mic-icon"><Icon.mic /></span>
        <span className="mic-label">{phase === "listening" ? "Stop dictation" : "Dictate"}</span>
      </button>
      {status && <span className="mic-status">{status}</span>}
      {error !== null && (
        <button type="button" className="small-btn mic-retry" onClick={start}>
          Try again
        </button>
      )}
      {showSettings && (
        <button type="button" className="small-btn mic-settings" onClick={() => openSettingsPage("voice")}>
          Voice settings
        </button>
      )}
    </span>
  );
}

// ---- install -----------------------------------------------------------------

let voiceInstalled = false;

/** Register the mic slot + auto read-aloud of newly completed replies.
 *  Idempotent: repeated boot (dev HMR, double module eval) can never add a
 *  second slot entry or store subscription (UX-COMPOSER-DISC). */
export function installVoice(): void {
  if (voiceInstalled) return;
  voiceInstalled = true;
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
