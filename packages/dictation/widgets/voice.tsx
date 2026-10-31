// Voice glue: a placeable mic mini-widget and optional read-aloud of assistant
// replies. Provider transport lives behind @polyth/dictation; this file owns
// DOM/store wiring and deliberately bounded lexical context only.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  MICROPHONE_CLAIM_EVENT,
  VOICE_PREFS_KEY,
  applySpokenPunctuation,
  assistantReplyTextAt,
  claimMicrophone,
  createSpeakableStream,
  mergeTranscript,
  onDeviceSpeechAvailability,
  parseVoicePrefs,
  providerCapabilities,
  recognitionCtor,
  serializeVoicePrefs,
  speakableText,
  speechSupport,
  type DictationContext,
  type DictationProcessingPolicy,
  type DictationProviderId,
  type DictationTransport,
  type OnDeviceSpeechAvailability,
  type SpeechRecognitionLike,
  type VoicePrefs,
} from "@polyth/dictation";
import { defineWidgetPlugin } from "../../../apps/web/src/widgets/catalog.ts";
import type { MessageActionSlotMeta, WebPackageHost } from "@polyth/web-sdk";
import { requestComposerDictation } from "../../../apps/web/src/composerInsert.ts";
import { getState, subscribeStore } from "../../../apps/web/src/store.ts";
import { api } from "@polyth/session/web-api";
import { startStreamingDictation, type StreamingDictation } from "./dictationClient.ts";
import { createSpeechOutput, primeSpeechOutput, type SpeechOutput, type SpeechOutputSettings } from "./speechOutput.ts";
import { canStartDirectProvider, startDirectProvider } from "./directProviders.ts";
import { announce } from "../../../apps/web/src/components/a11y/live.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import { IconButton, MicIcon, PlayIcon, StopIcon } from "@polyth/web/ui";

const read = (): string | null => {
  try { return localStorage.getItem(VOICE_PREFS_KEY); } catch { return null; }
};
let voicePrefs: VoicePrefs = parseVoicePrefs(read());
const listeners = new Set<() => void>();

export function getVoicePrefs(): VoicePrefs {
  return voicePrefs;
}

export function replaceVoicePrefs(value: unknown): void {
  voicePrefs = parseVoicePrefs(JSON.stringify(value));
  try { localStorage.setItem(VOICE_PREFS_KEY, serializeVoicePrefs(voicePrefs)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeVoicePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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

export interface SpeechPlayback {
  key: string | null;
  phase: "idle" | "loading" | "playing" | "error";
  error?: string;
}

let speechPlayback: SpeechPlayback = { key: null, phase: "idle" };
const speechListeners = new Set<() => void>();

function setSpeechPlayback(next: SpeechPlayback): void {
  speechPlayback = next;
  for (const listener of [...speechListeners]) listener();
}

export function getSpeechPlayback(): SpeechPlayback {
  return speechPlayback;
}

export function useSpeechPlayback(): SpeechPlayback {
  return useSyncExternalStore(
    (listener) => {
      speechListeners.add(listener);
      return () => { speechListeners.delete(listener); };
    },
    getSpeechPlayback,
  );
}

const speechError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error ?? tr("dictation.error.speechPlaybackFailed"));
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
};

/** Settings the output reads at each chunk, so a slider moved mid-reply
 *  applies from the next sentence. */
export const voiceOutputSettings = (): SpeechOutputSettings => ({
  engine: voicePrefs.ttsEngine,
  ...(voicePrefs.localVoice ? { localVoice: voicePrefs.localVoice } : {}),
  ...(voicePrefs.localSpeaker !== undefined ? { localSpeaker: voicePrefs.localSpeaker } : {}),
  lang: voicePrefs.lang,
  ...(voicePrefs.voice ? { voice: voicePrefs.voice } : {}),
  rate: voicePrefs.rate,
  pitch: voicePrefs.pitch,
  volume: voicePrefs.volume,
  fallback: !previewing,
});

let speechGeneration = 0;
let playingKey: string | null = null;
let playbackFailure: Error | null = null;
let readAloud: SpeechOutput | null = null;
/** The settings sample plays only the chosen engine, so a broken server voice
 *  shows its error instead of sounding like the browser voice. */
let previewing = false;

// Read-aloud is one output: a new reply replaces the old one, and voice mode
// (another package bundle) claims the speaker through the shared window event.
function readAloudOutput(): SpeechOutput {
  readAloud ??= createSpeechOutput(voiceOutputSettings, {
    onSpeaking: (speaking) => {
      if (speaking && playingKey) setSpeechPlayback({ key: playingKey, phase: "playing" });
      else if (!speaking && speechPlayback.phase === "playing") setSpeechPlayback({ key: null, phase: "idle" });
    },
    onError: (error) => { playbackFailure = error; },
    onDone: () => {
      const key = playingKey;
      playingKey = null;
      if (speechPlayback.phase === "loading" && playbackFailure && key) {
        setSpeechPlayback({ key, phase: "error", error: speechError(playbackFailure) });
      } else {
        setSpeechPlayback({ key: null, phase: "idle" });
      }
    },
  });
  return readAloud;
}

function beginSpeech(key: string, preview = false): number {
  const generation = ++speechGeneration;
  const output = readAloudOutput();
  output.cancel();
  previewing = preview;
  playingKey = key;
  playbackFailure = null;
  setSpeechPlayback({ key, phase: "loading" });
  return generation;
}

function playSpeech(text: string, generation: number): void {
  if (speechGeneration !== generation) return;
  const output = readAloudOutput();
  const stream = createSpeakableStream({ minChars: 140 });
  for (const chunk of [...stream.push(text), ...stream.flush()]) output.enqueue(chunk);
  output.end();
}

export function speak(text: string, key = "voice.sample"): void {
  const value = text.trim();
  if (!value) return;
  primeSpeechOutput();
  playSpeech(value, beginSpeech(key, true));
}

export function speakReply(text: string, key = "voice.reply"): void {
  const value = text.trim();
  if (!value) return;
  primeSpeechOutput();
  const generation = beginSpeech(key);
  void (async () => {
    let prepared = value;
    if (voicePrefs.summarize && value.length >= 400) {
      try {
        const result = await api.ttsSummarize(value);
        prepared = result.text.trim() || value;
      } catch {
        prepared = value;
      }
    }
    playSpeech(prepared, generation);
  })();
}

export function stopSpeaking(): void {
  speechGeneration++;
  playingKey = null;
  readAloud?.cancel();
  setSpeechPlayback({ key: null, phase: "idle" });
}

export function readLastReply(): void {
  const s = getState();
  const events = s.activeSessionId ? s.events[s.activeSessionId] ?? [] : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/message") {
      speakReply(
        speakableText(String((e.data as { text?: unknown }).text ?? "")),
        `${s.activeSessionId}:${e.seq}`,
      );
      return;
    }
  }
}

export function replyTextAt(sessionId: string, eventSeq: number): string {
  return assistantReplyTextAt(getState().events[sessionId] ?? [], eventSeq);
}

function ReadReplyAction({ context }: { context: Record<string, unknown> }) {
  const playback = useSpeechPlayback();
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const eventSeq = typeof context.eventSeq === "number" ? context.eventSeq : -1;
  const assistant = context.kind === "assistant" && sessionId !== "" && eventSeq >= 0;
  const key = `${sessionId}:${eventSeq}`;
  const active = assistant && playback.key === key
    && (playback.phase === "loading" || playback.phase === "playing");
  const inMenu = context.messageActionPlacement === "menu";
  const request = typeof context.messageActionRequest === "number" ? context.messageActionRequest : 0;
  const handledRequest = useRef(request);

  useEffect(() => {
    if (assistant && playback.key === key && playback.phase === "error" && playback.error) {
      announce(playback.error);
    }
  }, [assistant, key, playback]);

  const toggle = () => {
    if (active) {
      stopSpeaking();
      return;
    }
    const text = replyTextAt(sessionId, eventSeq);
    if (!text) {
      announce(tr("settings.voicepage.readRepliesAloud"));
      return;
    }
    speakReply(text, key);
  };

  // From the message's "More" menu the host signals each selection.
  useEffect(() => {
    if (request <= handledRequest.current) return;
    handledRequest.current = request;
    if (assistant) toggle();
  // toggle reads the current playback; only a new request acts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!assistant || inMenu) return null;
  const label = active ? tr("common.stop") : tr("settings.voicepage.readRepliesAloud");
  return <ChatActionButton
    className="voice-read-reply"
    icon={active ? StopIcon : PlayIcon}
    label={label}
    pressed={active || undefined}
    aria-busy={playback.key === key && playback.phase === "loading" ? true : undefined}
    onClick={toggle}
  />;
}

const basename = (path: string | null | undefined): string =>
  path?.split(/[\\/]/).filter(Boolean).pop() ?? "";

function currentDictationContext(language: string): DictationContext {
  const state = getState();
  const session = state.activeSessionId
    ? state.sessions.find((item) => item.id === state.activeSessionId)
    : undefined;
  const events = state.activeSessionId ? state.events[state.activeSessionId] ?? [] : [];
  const commands = state.activeSessionId
    ? state.runtimeFeatures[state.activeSessionId]?.commands ?? []
    : [];

  const technicalVocabulary = commands.slice(0, 24).map((command) => command.name).filter(Boolean);
  const keywords = [
    session?.title ?? "",
    state.gitBranch,
    basename(session?.worktreePath),
    basename(state.editorFile),
    ...technicalVocabulary,
  ].filter(Boolean);
  const recentMessages = events.slice(-12).flatMap((event) => {
    if (event.type !== "user/message" && event.type !== "assistant/message") return [];
    const content = String((event.data as { text?: unknown }).text ?? "").trim();
    if (!content) return [];
    return [{
      role: event.type === "user/message" ? "user" as const : "assistant" as const,
      content: content.slice(0, 600),
    }];
  });
  const repository = basename(session?.worktreePath);
  const openFile = basename(state.editorFile);
  const lexicalContext = [
    session?.title ? `Session: ${session.title}` : "",
    repository ? `Repository/worktree: ${repository}` : "",
    state.gitBranch ? `Branch: ${state.gitBranch}` : "",
    openFile ? `Open file: ${openFile}` : "",
  ].filter(Boolean).join("\n");

  return {
    language: language || "auto",
    app: { name: "Polyth", type: "ai" },
    ...(keywords.length ? { keywords } : {}),
    ...(technicalVocabulary.length ? { technicalVocabulary } : {}),
    ...(state.activeSessionId || recentMessages.length
      ? { conversation: {
          ...(state.activeSessionId ? { id: state.activeSessionId } : {}),
          ...(recentMessages.length ? { messages: recentMessages } : {}),
        } }
      : {}),
    ...(repository || state.gitBranch || openFile
      ? { project: {
          ...(repository ? { repository } : {}),
          ...(state.gitBranch ? { branch: state.gitBranch } : {}),
          ...(openFile ? { files: [openFile] } : {}),
        } }
      : {}),
    ...(lexicalContext ? { lexicalContext } : {}),
  };
}

type MicPhase = "idle" | "starting" | "listening" | "transcribing";

type RuntimeDictationSettings = {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  language: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
};

const boundedReason = (raw: unknown): string => {
  const s = raw instanceof Error ? raw.message : String(raw ?? tr("voice.microphoneError"));
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** Dictation results belong to the composer that started them. A project is
 * part of the identity because the no-session composer exists in every
 * project and must not receive another project's late final transcript. */
const composerScopeKey = (state = getState()): string => JSON.stringify([
  state.activeProjectId,
  state.activeSessionId,
]);

let dictationRuns = 0;

// Speech loudness, mapped for the eye rather than the meter. Below the floor
// is room tone; the ceiling is ordinary conversational speech, so normal
// talking reaches full brightness instead of asking for a shout.
const SILENCE_RMS = 0.012;
const SPEECH_RMS = 0.16;
/** Per-chunk decay (~25 chunks/s), so the glow falls off over ~250ms. */
const LEVEL_DECAY = 0.82;

const speechLevel = (rms: number): number =>
  Math.max(0, Math.min(1, (rms - SILENCE_RMS) / (SPEECH_RMS - SILENCE_RMS)));

/** A mouse/pen press held at least this long is push-to-talk: releasing it
 *  ends the dictation. A shorter press is a tap that keeps listening. */
const HOLD_TO_TALK_MS = 450;

interface MicController {
  toggle(): boolean;
  element(): HTMLElement | null;
}

// Mounted microphones, so the palette command and shortcut reach one even
// though the button is a placeable widget that may sit in several areas.
const micControllers = new Set<MicController>();

export function dictationControlsMounted(): boolean {
  return micControllers.size > 0;
}

/** Start or stop dictation from a command. The composer's own mic wins over a
 *  header placement because that is where the words land. */
export function toggleDictation(): boolean {
  const controllers = [...micControllers];
  const target = controllers.find((controller) =>
    controller.element()?.closest(".composer-rail, .mobile-composer-rail")) ?? controllers[0];
  return target?.toggle() ?? false;
}

let micOwners = 0;

function MicButton() {
  const prefs = useVoicePrefs();
  const composerScope = useSyncExternalStore(subscribeStore, composerScopeKey, composerScopeKey);
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [capability, setCapability] = useState<{ available: boolean; engine?: string; reason?: string } | null>(null);
  // undefined means server routing is still loading; null means an older or
  // unreachable settings endpoint, where local prefs remain a compatibility fallback.
  const [serverSelection, setServerSelection] = useState<RuntimeDictationSettings | null | undefined>(undefined);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<StreamingDictation | null>(null);
  const browserTranscriptRef = useRef("");
  const browserCommitRef = useRef(false);
  const startGeneration = useRef(0);
  const originScopeRef = useRef<string | null>(null);
  const previousComposerScope = useRef(composerScope);
  const controlRef = useRef<HTMLSpanElement | null>(null);
  const runIdRef = useRef("");
  const levelRef = useRef(0);
  const levelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownerRef = useRef("");
  if (!ownerRef.current) ownerRef.current = `dictation-mic:${++micOwners}`;
  const onDeviceRef = useRef<OnDeviceSpeechAvailability>("unavailable");
  const pressRef = useRef<{ at: number; started: boolean } | null>(null);
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const selectionReady = serverSelection !== undefined;
  const provider = serverSelection?.provider ?? prefs.dictationProvider;
  const transport = serverSelection?.transport ?? prefs.dictationTransport;
  const providerModel = serverSelection?.model || prefs.dictationModel;
  const language = serverSelection?.language || prefs.lang || "auto";
  const contextInjection = serverSelection?.contextInjection ?? prefs.contextInjection;
  const processingPolicy = serverSelection?.processingPolicy ?? prefs.processingPolicy;
  // The processing policy chooses the preferred provider. An unavailable
  // server/native route may use Web Speech as a last-mile fallback (including
  // mobile WebKit), except when local-only is an explicit privacy choice.
  const browserFallback = support.stt && processingPolicy !== "local-only";
  const cloudPrimaryPolicy = processingPolicy === "prefer-cloud" || processingPolicy === "browser-fallback";
  const directCapability = providerCapabilities(provider);
  // Auto-fallback remains on the server so recoverable cloud failures can replay
  // PCM into local Nemotron. Direct is selected only from verified capability data.
  const directCloud = cloudPrimaryPolicy
    && directCapability?.ephemeralClientAuth === true
    && directCapability.transports.includes("direct-browser")
    && canStartDirectProvider(provider)
    && (transport === "auto" || transport === "direct-browser");

  // The mic is the only dictation indicator, so it carries the speech level
  // itself. The variable is written straight to the DOM: ~25 audio chunks a
  // second must not re-render the composer rail.
  const writeLevel = (value: number) => {
    levelRef.current = value;
    // Silence still delivers chunks; rounding first means a quiet room stops
    // touching styles instead of invalidating them 25 times a second.
    const next = value.toFixed(2);
    const el = controlRef.current;
    if (!el || el.style.getPropertyValue("--mic-level") === next) return;
    el.style.setProperty("--mic-level", next);
  };

  const clearLevelTimer = () => {
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    levelTimerRef.current = null;
  };

  const resetLevel = () => {
    clearLevelTimer();
    writeLevel(0);
  };

  /** Measured loudness from a PCM transport, decaying between loud chunks. */
  const reportLevel = (rms: number) => {
    writeLevel(Math.max(speechLevel(rms), levelRef.current * LEVEL_DECAY));
  };

  /** Web Speech hands over no audio, so recognized words stand in for it. */
  const pulseLevel = () => {
    writeLevel(1);
    clearLevelTimer();
    levelTimerRef.current = setTimeout(() => {
      levelTimerRef.current = null;
      writeLevel(0);
    }, 700);
  };

  /** Stream the run's cumulative transcript into the composer it started in. */
  const publish = (text: string, final: boolean) => {
    requestComposerDictation({ runId: runIdRef.current, text, final });
  };

  useEffect(() => () => {
    startGeneration.current++;
    originScopeRef.current = null;
    browserCommitRef.current = false;
    clearLevelTimer();
    recRef.current?.abort();
    streamRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (previousComposerScope.current === composerScope) return;
    previousComposerScope.current = composerScope;
    // Session/project navigation invalidates the recording immediately. The
    // completion path also checks this scope to close the pre-effect race.
    startGeneration.current++;
    originScopeRef.current = null;
    browserCommitRef.current = false;
    browserTranscriptRef.current = "";
    const rec = recRef.current;
    recRef.current = null;
    try { rec?.abort(); } catch { /* already ended */ }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.cancel();
    resetLevel();
    setError(null);
    setPhase("idle");
  }, [composerScope]);

  useEffect(() => {
    if (!prefs.dictation) {
      setServerSelection(null);
      return;
    }
    let cancelled = false;
    setServerSelection(undefined);
    void api.voiceSettings()
      .then((settings) => (settings as typeof settings & { dictation?: RuntimeDictationSettings }).dictation ?? null)
      // A paired phone cannot read the settings; the capability names the
      // server's choice instead of letting this device's defaults guess it.
      .catch(() => api.dictationCapability()
        .then((capability) => (capability as { selection?: RuntimeDictationSettings }).selection ?? null))
      .then((selection) => {
        if (!cancelled) setServerSelection(selection);
      })
      .catch(() => {
        if (!cancelled) setServerSelection(null);
      });
    return () => { cancelled = true; };
  }, [
    prefs.dictation,
    prefs.dictationProvider,
    prefs.dictationTransport,
    prefs.dictationModel,
    prefs.processingPolicy,
    prefs.contextInjection,
    prefs.lang,
  ]);

  // Probe once per language whether the browser can recognize on-device.
  // Starting reads only this cached answer, so the mic never waits on it.
  useEffect(() => {
    onDeviceRef.current = "unavailable";
    if (!prefs.dictation || !prefs.onDeviceSpeech || !support.stt) return;
    let cancelled = false;
    const lang = language === "auto" ? navigator.language : language;
    void onDeviceSpeechAvailability(window, lang).then((availability) => {
      if (!cancelled) onDeviceRef.current = availability;
    });
    return () => { cancelled = true; };
  }, [prefs.dictation, prefs.onDeviceSpeech, support.stt, language]);

  useEffect(() => {
    if (!prefs.dictation) {
      setCapability(null);
      return;
    }
    if (!selectionReady) {
      setCapability(null);
      return;
    }
    let cancelled = false;
    if (directCloud) {
      void fetch("/api/voice/providers")
        .then(async (response) => response.ok
          ? response.json() as Promise<{ providers?: Array<{ id?: string; available?: boolean; reason?: string }> }>
          : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then((body) => {
          if (cancelled) return;
          const selected = body.providers?.find((item) => item.id === provider);
          setCapability(selected?.available
            ? { available: true, engine: `${provider}-direct` }
            : { available: false, reason: selected?.reason ?? `${provider} direct transcription is unavailable` });
        })
        .catch((e) => {
          if (!cancelled) setCapability({ available: false, reason: boundedReason(e) });
        });
    } else {
      void api.dictationCapability().then((c) => { if (!cancelled) setCapability(c); });
    }
    return () => { cancelled = true; };
  }, [prefs.dictation, selectionReady, directCloud, provider, transport, processingPolicy]);

  const providerOrBrowserAvailable = Boolean(capability?.available) || browserFallback;
  const availability: { available: boolean; reason?: string } =
    !prefs.dictation ? { available: false, reason: tr("voice.dictationOff") }
    : browserFallback ? { available: true }
    : !selectionReady || capability === null ? { available: false, reason: tr("voice.checkingMicrophone") }
      : !providerOrBrowserAvailable
        ? {
          available: false,
          reason: capability?.reason ?? tr("voice.serverTranscriptionUnavailable"),
        }
      : { available: true };

  // Dictation state is carried by the mic itself, never by text beside it, so
  // this string exists only for the live region screen readers hear.
  const lifecycleStatus = error !== null ? tr("voice.dictationFailedValue", { error })
    : phase === "starting" ? tr("voice.startingMicrophone")
    : phase === "listening" ? tr("voice.listening")
    : phase === "transcribing" ? tr("voice.transcribing")
    : availability.available ? null
    : availability.reason ?? null;

  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (lifecycleStatus !== lastAnnounced.current) announce(lifecycleStatus);
    lastAnnounced.current = lifecycleStatus;
  }, [lifecycleStatus]);

  const fail = (raw: unknown) => {
    startGeneration.current++;
    originScopeRef.current = null;
    browserCommitRef.current = false;
    // Release the span without rewriting it: a failed transport is no reason
    // to throw away the words already in the draft, and its own idea of the
    // transcript is exactly what just proved unreliable.
    publish("", true);
    browserTranscriptRef.current = "";
    const rec = recRef.current;
    recRef.current = null;
    try { rec?.abort(); } catch { /* already ended */ }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.cancel();
    resetLevel();
    setPhase("idle");
    setError(boundedReason(raw));
  };

  const stop = () => {
    const rec = recRef.current;
    if (rec) {
      setPhase("transcribing");
      try { rec.stop(); } catch (stopError) { fail(stopError); }
      return;
    }

    const stream = streamRef.current;
    if (stream) {
      const generation = startGeneration.current;
      const originScope = originScopeRef.current;
      const runId = runIdRef.current;
      setPhase("transcribing");
      void stream.stop()
        .then((text) => {
          if (streamRef.current === stream) streamRef.current = null;
          if (
            originScope === null
            || startGeneration.current !== generation
            || originScopeRef.current !== originScope
            || composerScopeKey() !== originScope
          ) return;
          originScopeRef.current = null;
          resetLevel();
          setPhase("idle");
          requestComposerDictation({ runId, text: text.trim(), final: true });
        })
        .catch((stopError) => {
          if (streamRef.current === stream) streamRef.current = null;
          if (
            originScope === null
            || startGeneration.current !== generation
            || originScopeRef.current !== originScope
            || composerScopeKey() !== originScope
          ) return;
          fail(stopError);
        });
      return;
    }
    resetLevel();
    setPhase("idle");
  };

  const startBrowser = (generation: number, originScope: string) => {
    const Ctor = recognitionCtor(window);
    if (!Ctor) {
      fail(tr("voice.dictationUnsupported"));
      return;
    }
    const rec = new Ctor();
    rec.lang = language === "auto" ? navigator.language : language;
    rec.continuous = true;
    rec.interimResults = true;
    // Prefer the browser's on-device recognizer when it has this language:
    // nothing leaves the machine and words arrive with less network delay.
    const onDevice = prefs.onDeviceSpeech && onDeviceRef.current === "available";
    if (onDevice) rec.processLocally = true;
    // English browser recognition does not punctuate; spoken commands do.
    // The rewrite is deterministic, so the cumulative span stays consistent.
    const punctuate = (text: string) => prefs.spokenPunctuation ? applySpokenPunctuation(text, rec.lang) : text;
    browserTranscriptRef.current = "";
    browserCommitRef.current = true;
    rec.onresult = (e) => {
      if (startGeneration.current !== generation || composerScopeKey() !== originScope) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) browserTranscriptRef.current = mergeTranscript(browserTranscriptRef.current, r[0].transcript);
        else interim = mergeTranscript(interim, r[0].transcript);
      }
      pulseLevel();
      publish(punctuate(mergeTranscript(browserTranscriptRef.current, interim)), false);
    };
    rec.onerror = (e) => {
      if (startGeneration.current !== generation || composerScopeKey() !== originScope) return;
      // Abort can synchronously trigger `onend` in some WebKit builds. Fence
      // this recognizer before aborting so an error never commits its partial
      // transcript through that callback.
      startGeneration.current++;
      browserCommitRef.current = false;
      try { rec.abort(); } catch { /* recognition may already be closed */ }
      recRef.current = null;
      // An on-device pack that cannot serve this run is not retried on-device;
      // the next start uses the browser's ordinary recognizer.
      if (onDevice && (e.error === "language-not-supported" || e.error === "service-not-allowed")) {
        onDeviceRef.current = "unavailable";
      }
      fail(e.error ?? tr("voice.microphoneError"));
    };
    rec.onend = () => {
      if (startGeneration.current !== generation || composerScopeKey() !== originScope) return;
      const commit = browserCommitRef.current;
      const text = punctuate(browserTranscriptRef.current.trim());
      const runId = runIdRef.current;
      // Invalidate this recognizer before publishing idle. Some mobile WebKit
      // builds deliver a queued result after `onend`; the generation fence
      // keeps that stale callback from mutating a new/idle composer.
      startGeneration.current++;
      browserCommitRef.current = false;
      browserTranscriptRef.current = "";
      recRef.current = null;
      originScopeRef.current = null;
      resetLevel();
      setPhase("idle");
      if (commit) requestComposerDictation({ runId, text, final: true });
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch (startError) {
      if (startGeneration.current === generation && composerScopeKey() === originScope) {
        fail(startError);
      }
      return;
    }
    if (startGeneration.current !== generation || composerScopeKey() !== originScope) {
      recRef.current = null;
      try { rec.abort(); } catch { /* already ended */ }
      return;
    }
    setPhase("listening");
  };

  const startProvider = async (generation: number, originScope: string, originSessionId: string | null) => {
    setPhase("starting");
    try {
      const context = contextInjection ? currentDictationContext(language) : { language };
      const onPartial = (text: string) => {
        if (startGeneration.current === generation && composerScopeKey() === originScope) publish(text, false);
      };
      const onLevel = (rms: number) => {
        if (startGeneration.current === generation && composerScopeKey() === originScope) reportLevel(rms);
      };
      const onError = (error: unknown) => {
        if (startGeneration.current === generation && composerScopeKey() === originScope) fail(error);
      };
      const serverOptions = {
        ...(originSessionId ? { sessionId: originSessionId } : {}),
        language,
        ...(contextInjection ? { context } : {}),
        onPartial,
        onLevel,
        onError,
      };
      let stream: StreamingDictation;
      if (directCloud) {
        try {
          stream = await startDirectProvider({
            provider,
            model: providerModel,
            language,
            context,
            onPartial,
            onLevel,
            onError,
          });
        } catch (directError) {
          if (transport !== "auto") throw directError;
          stream = await startStreamingDictation(serverOptions);
        }
      } else {
        stream = await startStreamingDictation(serverOptions);
      }
      if (startGeneration.current !== generation || composerScopeKey() !== originScope) {
        stream.cancel();
        return;
      }
      streamRef.current = stream;
      setPhase("listening");
    } catch (startError) {
      if (startGeneration.current !== generation || composerScopeKey() !== originScope) return;
      streamRef.current = null;
      if (browserFallback && support.stt) {
        startBrowser(generation, originScope);
        return;
      }
      fail(startError);
    }
  };

  const start = () => {
    setError(null);
    resetLevel();
    // One microphone owner at a time, and never dictate over our own voice.
    claimMicrophone(ownerRef.current);
    stopSpeaking();
    const origin = getState();
    const originScope = composerScopeKey(origin);
    originScopeRef.current = originScope;
    runIdRef.current = `dictation:${++dictationRuns}`;
    const generation = ++startGeneration.current;
    if (capability?.available) {
      void startProvider(generation, originScope, origin.activeSessionId);
    } else if (browserFallback && support.stt) {
      startBrowser(generation, originScope);
    }
  };

  /** Abandon a start that has no recognizer yet (a push-to-talk press
   *  released while the provider is still connecting). */
  const abandon = () => {
    startGeneration.current++;
    originScopeRef.current = null;
    browserCommitRef.current = false;
    resetLevel();
    setPhase("idle");
  };
  const release = () => (recRef.current || streamRef.current ? stop() : abandon());

  const busy = phase === "starting" || phase === "transcribing";
  // Commands and window listeners outlive a render; they read the latest one.
  const live = useRef({ phase, available: availability.available && !busy, start, release });
  live.current = { phase, available: availability.available && !busy, start, release };

  useEffect(() => {
    const controller: MicController = {
      toggle: () => {
        const current = live.current;
        if (current.phase === "listening") {
          current.release();
          return true;
        }
        if (current.phase !== "idle" || !current.available) return false;
        current.start();
        return true;
      },
      element: () => controlRef.current,
    };
    micControllers.add(controller);
    return () => { micControllers.delete(controller); };
  }, []);

  // Another owner (voice mode) took the microphone. Finish this dictation the
  // normal way so the words already spoken stay in the draft.
  useEffect(() => {
    const claimed = (event: Event) => {
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner === ownerRef.current) return;
      if (recRef.current || streamRef.current || live.current.phase === "starting") live.current.release();
    };
    window.addEventListener(MICROPHONE_CLAIM_EVENT, claimed);
    return () => window.removeEventListener(MICROPHONE_CLAIM_EVENT, claimed);
  }, []);

  // Escape ends a running dictation wherever focus is, keeping its words.
  useEffect(() => {
    if (phase !== "listening") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      live.current.release();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [phase]);

  const action = phase === "listening" ? tr("voice.stopDictation") : tr("voice.dictate");
  // Why dictation cannot run, or why it stopped, stays truthful without taking
  // space in the composer rail: the tooltip carries it on demand and `announce`
  // already delivered it to the live region.
  const detail = error !== null ? tr("voice.dictationFailedValue", { error })
    : availability.available ? null
    : availability.reason ?? null;
  // The mic is the whole control: no status text, no cancel and no retry
  // button beside it. Transcribed words go straight into the composer and the
  // button brightens with the voice it hears.
  return (
    <span ref={controlRef} className={`mic-control mic-${error ? "failed" : phase}`}>
      <IconButton
        type="button"
        className={`mic-btn${phase === "listening" ? " listening" : ""}`}
        icon={MicIcon}
        size="md"
        variant="ghost"
        label={action}
        title={detail ?? action}
        pressed={phase === "listening"}
        disabled={!availability.available || busy}
        onPointerDown={(event) => {
          pressRef.current = null;
          // A mouse or pen press is user activation, so dictation starts on the
          // press itself and a long hold works as push-to-talk. Touch keeps
          // tap-to-toggle: mobile WebKit unlocks audio only when a tap ends.
          if (event.button !== 0 || event.pointerType === "touch") return;
          if (phase !== "idle" || !availability.available || busy) return;
          const press = { at: Date.now(), started: true };
          pressRef.current = press;
          const up = () => {
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            if (pressRef.current === press && Date.now() - press.at >= HOLD_TO_TALK_MS) live.current.release();
          };
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
          start();
        }}
        onClick={(event) => {
          const press = pressRef.current;
          pressRef.current = null;
          // The press already started (and maybe ended) this dictation.
          if (press?.started && event.detail !== 0) return;
          if (phase === "listening") stop();
          else start();
        }}
      />
    </span>
  );
}

let uninstallVoice: (() => void) | null = null;

const VOICE_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "voice",
  name: tr("packages.voice.voice"),
  widgets: [{
    id: "voice.mic",
    title: tr("voice.dictate"),
    description: tr("voice.startOrStopVoiceDictation"),
    kind: "mini-widget",
    defaultSlot: "composer.leading",
    supportedSlots: [
      "composer.leading",
      "app.header.actions",
      "session.header.actions",
      "app.nav",
    ],
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 5,
    render: () => <MicButton />,
  }],
});

export function installVoice(host: WebPackageHost): () => void {
  uninstallVoice?.();
  const unregisterWidget = host.widgets.registerPlugin(VOICE_WIDGET_PLUGIN);
  const unregisterReadReply = host.slots.register({
    slot: "session.message.actions",
    id: "dictation.read-reply",
    order: 25,
    render: (context) => <ReadReplyAction context={context} />,
    meta: {
      messageAction: {
        label: () => tr("settings.voicepage.readRepliesAloud"),
        icon: PlayIcon,
        roles: ["assistant"],
        menu: true,
      } satisfies MessageActionSlotMeta,
    },
  });
  const current = () => {
    stopSpeaking();
    unregisterReadReply();
    unregisterWidget();
    if (uninstallVoice === current) uninstallVoice = null;
  };
  uninstallVoice = current;
  return current;
}
