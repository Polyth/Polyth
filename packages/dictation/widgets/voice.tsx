// Voice glue: a placeable mic mini-widget and optional read-aloud of assistant
// replies. Provider transport lives behind @polyth/dictation; this file owns
// DOM/store wiring and deliberately bounded lexical context only.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  VOICE_PREFS_KEY,
  mergeTranscript,
  parseVoicePrefs,
  recognitionCtor,
  serializeVoicePrefs,
  speakableText,
  speechSupport,
  type DictationContext,
  type DictationProcessingPolicy,
  type DictationProviderId,
  type DictationTransport,
  type SpeechRecognitionLike,
  type VoicePrefs,
} from "@polyth/dictation";
import { defineWidgetPlugin } from "../../../apps/web/src/widgets/catalog.ts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";
import { getState, openSettingsPage, subscribeStore } from "../../../apps/web/src/store.ts";
import { api } from "@polyth/session/web-api";
import { startStreamingDictation, type StreamingDictation } from "./dictationClient.ts";
import { startDirectElevenLabsDictation } from "./directElevenLabs.ts";
import { announce } from "../../../apps/web/src/components/a11y/live.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, IconButton, MicIcon } from "@polyth/web/ui";

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
  u.lang = voicePrefs.lang === "auto" ? navigator.language : voicePrefs.lang;
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
  if (voicePrefs.ttsEngine === "server") void speakServer(text).catch(() => speakBrowser(text));
  else speakBrowser(text);
}

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

  const keywords = [
    session?.title ?? "",
    state.gitBranch,
    basename(session?.worktreePath),
    basename(state.editorFile),
    ...commands.slice(0, 24).map((command) => command.name),
  ].filter(Boolean);

  const recentChat = events.slice(-8).flatMap((event) => {
    if (event.type !== "user/message" && event.type !== "assistant/message") return [];
    const text = String((event.data as { text?: unknown }).text ?? "").trim();
    return text ? [text.slice(0, 600)] : [];
  }).join("\n").slice(-3_000);

  const lexicalContext = [
    session?.title ? `Session: ${session.title}` : "",
    session?.worktreePath ? `Worktree: ${session.worktreePath}` : "",
    state.gitBranch ? `Branch: ${state.gitBranch}` : "",
    state.editorFile ? `Open file: ${state.editorFile}` : "",
    recentChat ? `Recent conversation:\n${recentChat}` : "",
  ].filter(Boolean).join("\n");

  return {
    language: language || "auto",
    ...(keywords.length ? { keywords } : {}),
    ...(lexicalContext ? { lexicalContext } : {}),
  };
}

type MicPhase = "idle" | "starting" | "listening" | "transcribing";

type RuntimeDictationSettings = {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
};

const boundedReason = (raw: unknown): string => {
  const s = raw instanceof Error ? raw.message : String(raw ?? tr("voice.microphoneError"));
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

const boundedPartial = (text: string): string => {
  const value = text.trim().replace(/\s+/g, " ");
  if (value.length <= 180) return value;
  return `…${value.slice(-179)}`;
};

function MicButton() {
  const prefs = useVoicePrefs();
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [capability, setCapability] = useState<{ available: boolean; engine?: string; reason?: string } | null>(null);
  // undefined means server routing is still loading; null means an older or
  // unreachable settings endpoint, where local prefs remain a compatibility fallback.
  const [serverSelection, setServerSelection] = useState<RuntimeDictationSettings | null | undefined>(undefined);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<StreamingDictation | null>(null);
  const browserTranscriptRef = useRef("");
  const browserCommitRef = useRef(false);
  const startGeneration = useRef(0);
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const serverStt = prefs.sttEngine === "server";
  const selectionReady = !serverStt || serverSelection !== undefined;
  const provider = serverSelection?.provider ?? prefs.dictationProvider;
  const transport = serverSelection?.transport ?? prefs.dictationTransport;
  const providerModel = serverSelection?.model || prefs.dictationModel;
  const contextInjection = serverSelection?.contextInjection ?? prefs.contextInjection;
  const processingPolicy = serverSelection?.processingPolicy ?? prefs.processingPolicy;
  const browserFallback = processingPolicy === "browser-fallback";
  const cloudPrimaryPolicy = processingPolicy === "prefer-cloud" || browserFallback;
  // Keep auto-fallback on the server so recoverable cloud failures can replay
  // PCM into local Nemotron. Direct browser cannot provide that mid-stream
  // transition without shipping the local runtime into the WebView.
  const directElevenLabs = serverStt
    && cloudPrimaryPolicy
    && provider === "elevenlabs"
    && (transport === "auto" || transport === "direct-browser");

  useEffect(() => () => {
    startGeneration.current++;
    browserCommitRef.current = false;
    recRef.current?.abort();
    streamRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (!prefs.dictation || !serverStt) {
      setServerSelection(null);
      return;
    }
    let cancelled = false;
    setServerSelection(undefined);
    void api.voiceSettings()
      .then((settings) => {
        if (cancelled) return;
        const dictation = (settings as typeof settings & { dictation?: RuntimeDictationSettings }).dictation;
        setServerSelection(dictation ?? null);
      })
      .catch(() => {
        if (!cancelled) setServerSelection(null);
      });
    return () => { cancelled = true; };
  }, [
    prefs.dictation,
    serverStt,
    prefs.dictationProvider,
    prefs.dictationTransport,
    prefs.dictationModel,
    prefs.processingPolicy,
    prefs.contextInjection,
  ]);

  useEffect(() => {
    if (!prefs.dictation || !serverStt) {
      setCapability(null);
      return;
    }
    if (!selectionReady) {
      setCapability(null);
      return;
    }
    let cancelled = false;
    if (directElevenLabs) {
      void fetch("/api/voice/providers")
        .then(async (response) => response.ok
          ? response.json() as Promise<{ providers?: Array<{ id?: string; available?: boolean; reason?: string }> }>
          : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then((body) => {
          if (cancelled) return;
          const selected = body.providers?.find((item) => item.id === "elevenlabs");
          setCapability(selected?.available
            ? { available: true, engine: "elevenlabs-direct" }
            : { available: false, reason: selected?.reason ?? "ElevenLabs direct transcription is unavailable" });
        })
        .catch((e) => {
          if (!cancelled) setCapability({ available: false, reason: boundedReason(e) });
        });
    } else {
      void api.dictationCapability().then((c) => { if (!cancelled) setCapability(c); });
    }
    return () => { cancelled = true; };
  }, [prefs.dictation, serverStt, selectionReady, directElevenLabs, provider, transport, processingPolicy]);

  const providerOrBrowserAvailable = Boolean(capability?.available) || (browserFallback && support.stt);
  const availability: { available: boolean; reason?: string; settings?: boolean } =
    !prefs.dictation ? { available: false, reason: tr("voice.dictationOff"), settings: true }
    : serverStt && (!selectionReady || capability === null) ? { available: false, reason: tr("voice.checkingMicrophone") }
    : serverStt && !providerOrBrowserAvailable
      ? {
          available: false,
          reason: capability?.reason ?? tr("voice.serverTranscriptionUnavailable"),
          settings: true,
        }
    : !serverStt && !support.stt
      ? { available: false, reason: tr("voice.dictationUnsupported"), settings: true }
    : { available: true };

  const lifecycleStatus = error !== null ? tr("voice.dictationFailedValue", { error })
    : phase === "starting" ? tr("voice.startingMicrophone")
    : phase === "listening" ? tr("voice.listening")
    : phase === "transcribing" ? tr("voice.transcribing")
    : availability.available ? null
    : availability.reason ?? null;
  const status = phase === "listening" && partial.trim()
    ? boundedPartial(partial)
    : lifecycleStatus;

  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (lifecycleStatus && lifecycleStatus !== lastAnnounced.current) announce(lifecycleStatus);
    lastAnnounced.current = lifecycleStatus;
  }, [lifecycleStatus]);

  const fail = (raw: unknown) => {
    startGeneration.current++;
    browserCommitRef.current = false;
    browserTranscriptRef.current = "";
    const rec = recRef.current;
    recRef.current = null;
    try { rec?.abort(); } catch { /* already ended */ }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.cancel();
    setPartial("");
    setPhase("idle");
    setError(boundedReason(raw));
  };

  const cancel = () => {
    startGeneration.current++;
    browserCommitRef.current = false;
    browserTranscriptRef.current = "";
    const rec = recRef.current;
    recRef.current = null;
    try { rec?.abort(); } catch { /* already ended */ }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.cancel();
    setPartial("");
    setError(null);
    setPhase("idle");
  };

  const stop = () => {
    const rec = recRef.current;
    if (rec) {
      setPhase("transcribing");
      try { rec.stop(); } catch (stopError) { fail(stopError); }
      return;
    }

    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      setPhase("transcribing");
      void stream.stop()
        .then((text) => {
          setPartial("");
          setPhase("idle");
          if (text.trim()) requestComposerInsert(text.trim());
        })
        .catch(fail);
      return;
    }
    setPartial("");
    setPhase("idle");
  };

  const startBrowser = () => {
    const Ctor = recognitionCtor(window);
    if (!Ctor) {
      fail(tr("voice.dictationUnsupported"));
      return;
    }
    const rec = new Ctor();
    rec.lang = prefs.lang === "auto" ? navigator.language : prefs.lang;
    rec.continuous = true;
    rec.interimResults = true;
    browserTranscriptRef.current = "";
    browserCommitRef.current = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) browserTranscriptRef.current = mergeTranscript(browserTranscriptRef.current, r[0].transcript);
        else interim = mergeTranscript(interim, r[0].transcript);
      }
      setPartial(mergeTranscript(browserTranscriptRef.current, interim));
    };
    rec.onerror = (e) => {
      recRef.current = null;
      browserCommitRef.current = false;
      fail(e.error ?? tr("voice.microphoneError"));
    };
    rec.onend = () => {
      const commit = browserCommitRef.current;
      const text = browserTranscriptRef.current.trim();
      browserCommitRef.current = false;
      browserTranscriptRef.current = "";
      recRef.current = null;
      setPartial("");
      setPhase("idle");
      if (commit && text) requestComposerInsert(text);
    };
    recRef.current = rec;
    rec.start();
    setPhase("listening");
  };

  const startProvider = async (generation: number) => {
    setPhase("starting");
    try {
      const language = prefs.lang || "auto";
      const context = contextInjection ? currentDictationContext(language) : { language };
      const onPartial = (text: string) => {
        if (startGeneration.current === generation) setPartial(text);
      };
      const serverOptions = {
        ...(getState().activeSessionId ? { sessionId: getState().activeSessionId! } : {}),
        language,
        ...(contextInjection ? { context } : {}),
        onPartial,
        onError: fail,
      };
      let stream: StreamingDictation;
      if (directElevenLabs) {
        try {
          stream = await startDirectElevenLabsDictation({
            model: providerModel || "scribe_v2_realtime",
            language,
            context,
            onPartial,
            onError: fail,
          });
        } catch (directError) {
          if (transport !== "auto") throw directError;
          stream = await startStreamingDictation(serverOptions);
        }
      } else {
        stream = await startStreamingDictation(serverOptions);
      }
      if (startGeneration.current !== generation) {
        stream.cancel();
        return;
      }
      streamRef.current = stream;
      setPhase("listening");
    } catch (startError) {
      if (startGeneration.current !== generation) return;
      streamRef.current = null;
      if (browserFallback && support.stt) {
        startBrowser();
        return;
      }
      fail(startError);
    }
  };

  const start = () => {
    setError(null);
    setPartial("");
    const generation = ++startGeneration.current;
    if (serverStt) {
      if (capability?.available) {
        void startProvider(generation);
      } else if (browserFallback && support.stt) {
        startBrowser();
      }
      return;
    }
    startBrowser();
  };

  const busy = phase === "starting" || phase === "transcribing";
  const showSettings = error !== null || (!availability.available && availability.settings === true);

  return (
    <span className={`mic-control mic-${error ? "failed" : phase}`}>
      <IconButton
        type="button"
        className={`mic-btn${phase === "listening" ? " listening" : ""}`}
        icon={MicIcon}
        size="md"
        variant="ghost"
        label={phase === "listening" ? tr("voice.stopDictation") : tr("voice.dictate")}
        pressed={phase === "listening"}
        disabled={!availability.available || busy}
        onClick={() => (phase === "listening" ? stop() : start())}
      />
      {status && <span className="mic-status">{status}</span>}
      {phase === "listening" && (
        <Button size="sm" className="mic-cancel" onClick={cancel}>{tr("common.cancel")}</Button>
      )}
      {error !== null && (
        <Button size="sm" className="mic-retry" onClick={start}>
          {tr("voice.tryAgain")}</Button>
      )}
      {showSettings && (
        <Button size="sm" className="mic-settings" onClick={() => openSettingsPage("voice")}>
          {tr("voice.voiceSettings")}</Button>
      )}
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
      "composer.trailing",
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
    if (!voicePrefs.tts) return;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.seq <= from) break;
      if (e.type === "assistant/message") {
        speakReply(speakableText(String((e.data as { text?: unknown }).text ?? "")));
        break;
      }
    }
  };
  const unsubscribeStore = subscribeStore(check);
  const current = () => {
    unsubscribeStore();
    unregisterWidget();
    if (uninstallVoice === current) uninstallVoice = null;
  };
  uninstallVoice = current;
  return current;
}