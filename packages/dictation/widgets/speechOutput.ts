// Queued text-to-speech output shared by read-aloud and voice mode. Text
// arrives as speakable chunks (often while a reply is still streaming); the
// queue speaks them in order, prefetches server clips one chunk ahead, reports
// output loudness for visuals and falls back from a failing server voice to
// the browser voice instead of going silent.
import { pickVoice } from "../src/speech.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export type SpeechOutputEngine = "browser" | "server" | "local";

export interface SpeechOutputSettings {
  engine: SpeechOutputEngine;
  /** Built-in voice on the Polyth server (engine "local"). */
  localVoice?: string;
  localSpeaker?: number;
  /** BCP-47 language; "auto" uses the browser language. */
  lang: string;
  /** Explicit browser voice name; empty picks the best available voice. */
  voice?: string;
  rate: number;
  pitch: number;
  volume: number;
  /** False previews the chosen voice exactly: a failing server voice reports
   *  its error instead of playing the browser voice in its place. */
  fallback?: boolean;
}

export interface SpeechOutputEvents {
  /** True when the first chunk becomes audible, false when the queue drains
   *  after `end()` or is cancelled. */
  onSpeaking?(speaking: boolean): void;
  /** Output loudness 0..1, at most once per animation frame while audible. */
  onLevel?(level: number): void;
  /** A chunk started playing (captions). */
  onChunk?(text: string, kind: SpeechChunkKind): void;
  /** Non-fatal: the queue continues, possibly on the browser voice. */
  onError?(error: Error): void;
  /** Everything queued so far has been spoken but more may follow (a reply
   *  paused for tool work). */
  onIdle?(): void;
  /** Everything queued before `end()` has been spoken. */
  onDone?(): void;
  /** Another owner took the speaker and this output was cancelled for it. */
  onClaimed?(): void;
}

/** A reply is the content itself; an aside is a lower-priority remark beside
 *  it (voice mode narrating the agent's work) that may be dropped unheard. */
export type SpeechChunkKind = "reply" | "aside";

export interface SpeechEnqueueOptions {
  kind?: SpeechChunkKind;
  /** An aside still waiting at this time (ms since epoch) is skipped. */
  expiresAt?: number;
}

export interface SpeechOutput {
  enqueue(text: string, options?: SpeechEnqueueOptions): void;
  /** Drop asides that have not started playing (and their prefetches). */
  dropAsides(): void;
  /** No more text will arrive for this utterance group. */
  end(): void;
  cancel(): void;
  /** Cancel and stop listening for speaker claims; the output is unusable after. */
  dispose(): void;
  /** Queued or audible. */
  readonly active: boolean;
}

/** Another owner (read-aloud, voice mode, a second tab bundle) took the
 *  speaker; every other output stops. Packages are bundled separately, so this
 *  is a window event rather than shared module state. */
export const SPEECH_CLAIM_EVENT = "polyth:speech-claim";

let sharedContext: AudioContext | null = null;

export function speechAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new Ctor({ latencyHint: "interactive" });
  return sharedContext;
}

/** Call from a user gesture: mobile WebKit only lets audio start inside one,
 *  and an utterance spoken later from a timer is otherwise silently dropped. */
export function primeSpeechOutput(): void {
  const context = speechAudioContext();
  if (context?.state === "suspended") void context.resume().catch(() => {});
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined" || synth.speaking) return;
  try {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    synth.speak(silent);
  } catch { /* priming is best effort */ }
}

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

/** Chrome fills the voice list asynchronously; wait briefly for it. */
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  voicesReady ??= new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.("voiceschanged", done);
      resolve(synth.getVoices());
    };
    synth.addEventListener?.("voiceschanged", done);
    setTimeout(done, 900);
  }).finally(() => { voicesReady = null; }) as Promise<SpeechSynthesisVoice[]>;
  return voicesReady;
}

const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(typeof error === "string" && error ? error : fallback);

interface QueueItem {
  text: string;
  kind: SpeechChunkKind;
  expiresAt?: number;
  clip?: Promise<AudioBuffer>;
  abort?: AbortController;
}

let outputs = 0;

export function createSpeechOutput(
  settings: () => SpeechOutputSettings,
  events: SpeechOutputEvents = {},
): SpeechOutput {
  const owner = `speech-output:${++outputs}`;
  const queue: QueueItem[] = [];
  let current: QueueItem | null = null;
  let ended = false;
  let audible = false;
  let generation = 0;
  let serverFailed = false;
  let source: AudioBufferSourceNode | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let pulse = 0;
  let levelSource: (() => number) | null = null;

  const synth = (): SpeechSynthesis | undefined =>
    typeof window !== "undefined" ? window.speechSynthesis : undefined;

  const stopLevels = () => {
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = null;
    levelSource = null;
    events.onLevel?.(0);
  };

  const runLevels = (read: () => number) => {
    levelSource = read;
    if (frame !== null || typeof requestAnimationFrame !== "function" || !events.onLevel) return;
    const tick = () => {
      frame = null;
      if (!levelSource) return;
      events.onLevel?.(Math.max(0, Math.min(1, levelSource())));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };

  const setAudible = (value: boolean) => {
    if (audible === value) return;
    audible = value;
    if (value && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SPEECH_CLAIM_EVENT, { detail: { owner } }));
    }
    events.onSpeaking?.(value);
  };

  const claim = (event: Event) => {
    const detail = (event as CustomEvent<{ owner?: string }>).detail;
    if (detail?.owner !== owner && (audible || queue.length || current)) {
      cancel();
      events.onClaimed?.();
    }
  };
  if (typeof window !== "undefined") window.addEventListener(SPEECH_CLAIM_EVENT, claim);

  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  const fetchClip = (item: QueueItem): Promise<AudioBuffer> => {
    if (item.clip) return item.clip;
    const abort = new AbortController();
    item.abort = abort;
    item.clip = (async () => {
      const prefs = settings();
      // Built-in voices take the pace server-side, so it never shifts pitch.
      const response = prefs.engine === "local"
        ? await fetch("/api/tts/local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: item.text,
            voice: prefs.localVoice ?? "",
            ...(prefs.localSpeaker !== undefined ? { speaker: prefs.localSpeaker } : {}),
            lang: prefs.lang === "auto" && typeof navigator !== "undefined" ? navigator.language : prefs.lang,
            speed: prefs.rate,
          }),
          signal: abort.signal,
        })
        : await fetch("/api/tts/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: item.text,
            lang: prefs.lang === "auto" && typeof navigator !== "undefined" ? navigator.language : prefs.lang,
          }),
          signal: abort.signal,
        });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? tr("dictation.error.ttsHttpFailed", { status: response.status }));
      }
      const context = speechAudioContext();
      if (!context) throw new Error(tr("dictation.error.webAudioUnavailable"));
      return context.decodeAudioData(await response.arrayBuffer());
    })();
    // A prefetch that fails before it is played must not surface as an
    // unhandled rejection; playback awaits and handles it.
    item.clip.catch(() => {});
    return item.clip;
  };

  const prefetch = () => {
    if (settings().engine === "browser" || serverFailed) return;
    for (const item of queue.slice(0, 2)) void fetchClip(item);
  };

  const finishChunk = (expected: number) => {
    if (expected !== generation) return;
    clearWatchdog();
    source = null;
    utterance = null;
    current = null;
    void next();
  };

  const playServer = async (item: QueueItem, expected: number): Promise<boolean> => {
    let buffer: AudioBuffer;
    try {
      buffer = await fetchClip(item);
    } catch (error) {
      if (expected !== generation) return true;
      serverFailed = true;
      events.onError?.(asError(error, tr("dictation.error.speechFailed")));
      return false;
    }
    if (expected !== generation) return true;
    const context = speechAudioContext();
    if (!context) return false;
    if (context.state === "suspended") await context.resume().catch(() => {});
    const prefs = settings();
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = prefs.engine === "local" ? 1 : Math.max(0.5, Math.min(2, prefs.rate * prefs.pitch));
    const gain = context.createGain();
    gain.gain.value = prefs.volume;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const samples = new Float32Array(analyser.fftSize);
    node.connect(gain);
    gain.connect(analyser);
    analyser.connect(context.destination);
    source = node;
    node.onended = () => {
      try { analyser.disconnect(); gain.disconnect(); } catch { /* already detached */ }
      finishChunk(expected);
    };
    node.start();
    setAudible(true);
    events.onChunk?.(item.text, item.kind);
    runLevels(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length) * 4.5;
    });
    prefetch();
    return true;
  };

  const playBrowser = async (item: QueueItem, expected: number): Promise<void> => {
    const speech = synth();
    if (!speech || typeof SpeechSynthesisUtterance === "undefined") {
      events.onError?.(new Error(tr("dictation.error.speechUnavailable")));
      finishChunk(expected);
      return;
    }
    const prefs = settings();
    const lang = !prefs.lang || prefs.lang === "auto" ? navigator.language : prefs.lang;
    const voices = await loadVoices(speech);
    if (expected !== generation) return;
    const spoken = new SpeechSynthesisUtterance(item.text);
    spoken.lang = lang;
    spoken.rate = prefs.rate;
    spoken.pitch = prefs.pitch;
    spoken.volume = prefs.volume;
    const voice = pickVoice(voices, lang, prefs.voice);
    if (voice) {
      spoken.voice = voice;
      spoken.lang = voice.lang || lang;
    }
    spoken.onstart = () => {
      if (expected !== generation) return;
      setAudible(true);
      events.onChunk?.(item.text, item.kind);
      pulse = 0.7;
      // The browser voice exposes no audio, so word boundaries drive a
      // plausible envelope: a lift on each word that relaxes between them.
      runLevels(() => {
        pulse = Math.max(0.18, pulse * 0.9);
        return pulse;
      });
    };
    spoken.onboundary = () => { pulse = 0.65 + Math.random() * 0.35; };
    spoken.onend = () => finishChunk(expected);
    spoken.onerror = (event) => {
      const reason = (event as SpeechSynthesisErrorEvent).error;
      if (reason !== "interrupted" && reason !== "canceled") {
        events.onError?.(new Error(reason ? tr("dictation.error.speechFailedDetail", { message: reason }) : tr("dictation.error.speechFailed")));
      }
      finishChunk(expected);
    };
    utterance = spoken;
    // Some engines never fire `end` (Chrome after a device change); advance
    // once the chunk has certainly had time to finish.
    const estimateMs = 4_000 + (item.text.length / (13 * Math.max(0.5, prefs.rate))) * 1_000;
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (expected === generation && utterance === spoken && !speech.speaking) finishChunk(expected);
    }, estimateMs);
    if (speech.paused) speech.resume();
    speech.speak(spoken);
  };

  async function next(): Promise<void> {
    if (current) return;
    // An aside that waited too long describes work that is already over.
    while (queue[0]?.kind === "aside" && queue[0].expiresAt !== undefined && queue[0].expiresAt <= Date.now()) {
      queue.shift()?.abort?.abort();
    }
    const item = queue.shift();
    if (!item) {
      if (ended) {
        ended = false;
        stopLevels();
        setAudible(false);
        events.onDone?.();
      } else {
        // Between streamed chunks: hold the speaking state, drop the level.
        levelSource = () => 0;
        events.onIdle?.();
      }
      return;
    }
    current = item;
    const expected = generation;
    if (settings().engine !== "browser" && !serverFailed) {
      if (await playServer(item, expected)) return;
      if (expected !== generation) return;
      if (settings().fallback === false) {
        // Nothing else of this group can play on the chosen voice either.
        queue.length = 0;
        ended = true;
        finishChunk(expected);
        return;
      }
    }
    await playBrowser(item, expected);
  }

  function cancel(): void {
    generation++;
    // A new utterance group retries the server voice: one earlier failure
    // (not yet configured, a restart, a network blip) must not pin every
    // later reply and sample to the browser voice for the page's lifetime.
    serverFailed = false;
    clearWatchdog();
    for (const item of [current, ...queue]) item?.abort?.abort();
    queue.length = 0;
    current = null;
    ended = false;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source = null;
    }
    if (utterance) {
      utterance.onend = null;
      utterance.onerror = null;
      utterance = null;
      synth()?.cancel();
    }
    stopLevels();
    setAudible(false);
  }

  return {
    enqueue(text, options = {}) {
      const value = text.trim();
      if (!value) return;
      const kind = options.kind ?? "reply";
      queue.push({ text: value, kind, ...(kind === "aside" && options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}) });
      prefetch();
      if (!current) void next();
    },
    end() {
      ended = true;
      if (!current && !queue.length) void next();
    },
    dropAsides() {
      // Only what waits: an aside already playing is one short sentence and
      // finishes.
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]!.kind !== "aside") continue;
        queue[index]!.abort?.abort();
        queue.splice(index, 1);
      }
    },
    cancel,
    dispose() {
      cancel();
      if (typeof window !== "undefined") window.removeEventListener(SPEECH_CLAIM_EVENT, claim);
    },
    get active() { return audible || Boolean(current) || queue.length > 0; },
  };
}
