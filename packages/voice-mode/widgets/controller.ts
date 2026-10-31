// Voice mode turn-taking. The microphone stays open for the whole
// conversation — while the agent thinks and works too — so the user can always
// talk: an utterance while the agent is idle is sent, one while it works is
// queued behind the running turn, and spoken commands ("stop", "send now")
// act at once instead of being sent. Only the agent's own spoken reply closes
// the microphone (it would hear itself); talking over it interrupts.
//
// Voice mode is pinned to the conversation it started in. When that
// conversation's composer is on screen, idle turns stream into its draft and
// are sent through its own Send path, so the canonical user message, model
// and new-session creation are exactly what typing would produce. Otherwise
// (another conversation is open, or the agent is busy) the words are sent
// straight to the pinned conversation.
//
// Nothing here gives up on its own: a failing recognizer falls back to the
// next route and then retries with backoff, a hidden tab recovers when it is
// shown again, and a message that did not go through is a notice, not the
// end of the conversation.
//
// While the agent works it may also narrate, if the person turned that on:
// short asides about its steps and thoughts (`src/narration.ts`). An aside
// never waits in front of the reply or the user — either one drops what is
// still queued — and one that waited too long is skipped unheard.
//
// Audio, recognition and the host are injected so the state machine is tested
// without a microphone.
import type { DictationError } from "@polyth/dictation";
import type { SpeechOutput, SpeechOutputEvents, SpeechOutputSettings } from "@polyth/dictation/voice-runtime";
import { matchVoiceCommand, type VoiceCommandId, type VoiceCommandPhrases } from "../src/commands.ts";
import {
  actionPhrase,
  createNarrationTracker,
  fallbackDescribe,
  type DescribeTool,
  type NarrationCue,
} from "../src/narration.ts";
import type { NarrationPhrases } from "../src/narrationPhrases.ts";
import { createReplyTracker, sameUtterance, type ReplyActivity, type TrackedEvent } from "../src/replyTracker.ts";
import { PAUSE_MS, type VoiceModePrefs, type VoiceRecognitionChoice } from "../src/prefs.ts";
import type { VoiceModeStrings } from "../src/strings.ts";
import type { Listener, ListenerEvents, ListenerOptions, RecognitionRoute } from "./listener.ts";
import type { MicMonitor, MicMonitorEvents } from "./micMonitor.ts";
import type { Earcon } from "./earcons.ts";
import type { NarrateOutcome } from "./narrateClient.ts";
import type { NarrateRequest } from "../src/narrateRoutes.ts";
import type { RouteResolution } from "./route.ts";

/** What the microphone side is doing. */
export type VoicePhase =
  | "off"
  | "starting"
  | "listening"
  | "hearing"
  | "sending"
  | "speaking"
  | "paused"
  | "error";

/** What the pinned conversation's agent is doing. */
export type VoiceAgentState = "idle" | "working" | "needs-input";

export interface VoiceModeSnapshot {
  phase: VoicePhase;
  agent: VoiceAgentState;
  /** The user's words this turn (live while speaking). */
  userText: string;
  /** The sentence being spoken now. */
  assistantText: string;
  /** Tool the agent is running, while it works. */
  tool: string | null;
  /** That step in words ("Reading config.ts"), when the host can describe it. */
  action: string | null;
  error: string | null;
  /** A short-lived outcome: queued, stopped, not sent… */
  notice: string | null;
  muted: boolean;
  /** Explicit layout for this conversation; null follows the preference. */
  immersive: boolean | null;
  /** The browser recognizer is in use (no audio-level meter is available). */
  route: RecognitionRoute["kind"] | null;
  /** The conversation voice mode talks to (null until a New chat is sent). */
  sessionId: string | null;
}

export interface VoiceLevels {
  input: number;
  output: number;
}

export interface VoiceHost {
  store: { getSnapshot(): { activeSessionId: string | null } };
  sessions: {
    subscribeEvents(listener: (event: TrackedEvent) => void): () => void;
    get?(sessionId: string): { status?: string } | undefined;
  };
  conversation: {
    dictate?(update: { runId: string; text: string; final: boolean; discard?: boolean }): boolean;
    submitDraft?(options?: { delivery?: "queue" | "steer" | "interrupt" }): boolean;
    send?(sessionId: string, text: string, options?: { delivery?: "normal" | "queue" | "interrupt" }): Promise<boolean>;
  };
  navigation: { setActiveView(view: string): void };
  execution?: { describe: DescribeTool };
}

export interface VoiceModeDeps {
  host: VoiceHost;
  owner: string;
  strings(): VoiceModeStrings;
  prefs(): VoiceModePrefs;
  /** Narration in the spoken language, and in the UI language for status. */
  spokenPhrases(): NarrationPhrases;
  shownPhrases(): NarrationPhrases;
  /** BCP-47 language narration is spoken in (the small model's too). */
  spokenLang(): string;
  /** Ask the account's small model to word a remark. Optional: without it
   *  every remark uses the phrases. */
  narrate?(request: NarrateRequest, signal: AbortSignal): Promise<NarrateOutcome>;
  /** Resolved command phrases (custom or the language defaults). */
  commandPhrases(): VoiceCommandPhrases;
  outputSettings(): SpeechOutputSettings;
  resolveRoutes(choice: VoiceRecognitionChoice, sessionId: string | null): Promise<RouteResolution>;
  startListener(route: RecognitionRoute, events: ListenerEvents, options: ListenerOptions): Promise<Listener>;
  createOutput(settings: () => SpeechOutputSettings, events: SpeechOutputEvents): SpeechOutput;
  primeOutput(): void;
  startMicMonitor(events: MicMonitorEvents): Promise<MicMonitor>;
  bargeIn(): boolean;
  earcon(kind: Earcon): void;
  claimMicrophone(owner: string): void;
  claimSpeaker(owner: string): void;
  onMicrophoneClaimed(listener: (owner: string) => void): () => void;
  /** Stop the conversation's running turn. */
  stopTurn(sessionId: string): Promise<void>;
  /** Deliver the conversation's queued messages now; resolves how many. */
  sendQueuedNow(sessionId: string): Promise<number>;
  /** Voice mode runs in one browser tab: announce this one, hear the others. */
  claimTab?(): void;
  onTabClaimed?(listener: () => void): () => void;
  /** Called with true when the page becomes visible again. */
  onVisibilityChange?(listener: (visible: boolean) => void): () => void;
  wakeLock?(): Promise<(() => void) | null>;
  haptic?(): void;
  now(): number;
}

export interface VoiceModeController {
  getSnapshot(): VoiceModeSnapshot;
  subscribe(listener: () => void): () => void;
  getLevels(): VoiceLevels;
  subscribeLevels(listener: (levels: VoiceLevels) => void): () => void;
  start(): void;
  stop(): void;
  toggle(): void;
  /** The one obvious action: send now, interrupt, resume or retry. */
  primary(): void;
  /** Stop the agent's running turn (the spoken "stop"). */
  stopAgent(): void;
  toggleMute(): void;
  setImmersive(immersive: boolean): void;
  /** Apply a Replies change (spoken ↔ silent) to the running conversation. */
  applyFeedback(): void;
  dispose(): void;
}

const OFF: VoiceModeSnapshot = {
  phase: "off",
  agent: "idle",
  userText: "",
  assistantText: "",
  tool: null,
  action: null,
  error: null,
  notice: null,
  muted: false,
  immersive: null,
  route: null,
  sessionId: null,
};

/** A composer send that never shows up as a canonical message or queue entry
 *  within this window was refused by the composer (its error is on screen). */
const SEND_CONFIRM_MS = 25_000;
/** A command said on its own acts after this much stillness, not the pause. */
const COMMAND_SETTLE_MS = 450;
/** Speech that ran dry mid-reply (tool work) reopens the microphone after this. */
const SPEECH_IDLE_MS = 700;
const NOTICE_MS = 3_500;
/** An aside still waiting after this long describes work that is over. */
const ASIDE_FRESH_MS = 6_000;
/** Failed small-model remarks in a row before the conversation keeps to phrases. */
const NARRATOR_FAILURES = 2;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

const LISTEN_PHASES = new Set<VoicePhase>(["listening", "hearing"]);
const BUSY_STATUSES = new Set(["working", "waiting", "reconciling"]);
const REQUEST_SETTLED = new Set([
  "permission/resolved", "permission/expired", "question/answered", "question/expired",
]);

export function createVoiceModeController(deps: VoiceModeDeps): VoiceModeController {
  let snapshot: VoiceModeSnapshot = OFF;
  const listeners = new Set<() => void>();
  const levelListeners = new Set<(levels: VoiceLevels) => void>();
  let levels: VoiceLevels = { input: 0, output: 0 };

  let epoch = 0;
  let runs = 0;
  let runId = "";
  let routes: RecognitionRoute[] = [];
  let routeIndex = 0;
  let listener: Listener | null = null;
  let listenerToken = 0;
  let output: SpeechOutput | null = null;
  let monitor: MicMonitor | null = null;
  let monitorToken = 0;
  let unsubscribers: Array<() => void> = [];
  let releaseWakeLock: (() => void) | null = null;
  let pending: { text: string; at: number } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let commandTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;
  let targetSessionId: string | null = null;
  /** The agent is (or is about to be) running a turn in the pinned session. */
  let busy = false;
  /** This turn's reply may be spoken (cleared by an interruption). */
  let speakTurn = false;
  /** Reply speech that arrived while the user was talking. */
  let held: string[] = [];
  /** The current utterance streams into the composer draft. */
  let streamToComposer = false;
  /** The composer took the current utterance's last update. */
  let spanLive = false;
  /** Counts reply sentences handed to the speaker (idle detection). */
  let spoken = 0;
  /** The Replies mode this conversation runs in (silent: no audio out). */
  let silentNow = false;

  /** Reply chunks handed to the speaker that have not started playing. */
  let replyWaiting = 0;
  /** What the speaker is playing now. */
  let playing: "reply" | "aside" | null = null;
  let narrationTimer: ReturnType<typeof setTimeout> | null = null;
  /** The small-model remark being worded (a newer cue replaces it). */
  let narrating: AbortController | null = null;
  let narratorFailures = 0;
  /** The small model is out for this conversation: phrases only. */
  let narratorOff = false;

  const tracker = createReplyTracker({
    get codePlaceholder() { return deps.strings().codeOmitted; },
    get tablePlaceholder() { return deps.strings().tableOmitted; },
  });
  const describe: DescribeTool = (tool, input) => deps.host.execution?.describe(tool, input) ?? fallbackDescribe(tool);
  const narrator = createNarrationTracker({
    describe,
    phrases: () => deps.spokenPhrases(),
    settings: () => {
      const prefs = deps.prefs();
      return { thoughts: prefs.thoughts, actions: prefs.actions, cadence: prefs.narrationCadence };
    },
    now: () => deps.now(),
  });

  const set = (patch: Partial<VoiceModeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const setLevels = (patch: Partial<VoiceLevels>) => {
    const next = { ...levels, ...patch };
    if (next.input === levels.input && next.output === levels.output) return;
    levels = next;
    for (const listener of [...levelListeners]) listener(levels);
  };

  const silent = () => deps.prefs().feedback === "silent";
  const sound = (kind: Earcon) => {
    if (!silent() && deps.prefs().sounds) deps.earcon(kind);
  };

  const clear = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
    return null;
  };

  const notify = (notice: string | null) => {
    noticeTimer = clear(noticeTimer);
    set({ notice });
    if (!notice) return;
    const currentEpoch = epoch;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (currentEpoch === epoch && snapshot.notice === notice) set({ notice: null });
    }, NOTICE_MS);
  };

  const clearPending = () => {
    pendingTimer = clear(pendingTimer);
    pending = null;
  };

  const stopMonitor = () => {
    monitorToken++;
    monitor?.stop();
    monitor = null;
  };

  const speaking = () => snapshot.phase === "speaking";

  /** While the agent speaks, talking over it interrupts. */
  const startMonitor = () => {
    if (monitor || snapshot.muted || !deps.bargeIn() || !speaking()) return;
    const token = ++monitorToken;
    void deps.startMicMonitor({
      onSpeech: () => {
        if (token !== monitorToken) return;
        deps.haptic?.();
        interrupt();
      },
    }).then((started) => {
      if (token !== monitorToken) started.stop();
      else monitor = started;
    }).catch(() => {
      // Barge-in is a convenience; tap-to-interrupt keeps working without it.
    });
  };

  /** The conversation's composer is the one on screen. */
  const composerShowsTarget = (): boolean => {
    const active = deps.host.store.getSnapshot().activeSessionId;
    return targetSessionId === null || active === targetSessionId;
  };

  /** Stream into the draft — only while that conversation's composer is the
   *  one on screen, so switching chats mid-sentence never writes elsewhere. */
  const dictate = (text: string, final: boolean, discard = false): boolean => {
    if (!runId || !streamToComposer || !composerShowsTarget()) return false;
    return deps.host.conversation.dictate?.({ runId, text, final, ...(discard ? { discard: true } : {}) }) ?? false;
  };

  /** Release this turn's composer span without rewriting the draft. */
  const releaseSpan = () => {
    if (spanLive) dictate("", true);
    spanLive = false;
  };

  /** Take this turn's words back out of the draft (a command). */
  const discardSpan = () => {
    if (spanLive) dictate("", true, true);
    spanLive = false;
  };

  const cancelListener = () => {
    listenerToken++;
    commandTimer = clear(commandTimer);
    const current = listener;
    listener = null;
    current?.cancel();
    setLevels({ input: 0 });
  };

  const isMicDenied = (error: unknown): boolean =>
    (error as Partial<DictationError> | null)?.code === "mic_denied";

  /** Recognition failed on every route. Show it and try again later — a
   *  hands-free conversation must not need a tap to come back. */
  const retryLater = (message: string, denied = false) => {
    cancelListener();
    releaseSpan();
    retryTimer = clear(retryTimer);
    if (snapshot.phase !== "error") sound("error");
    set({ phase: "error", error: message });
    // A denied microphone needs the user; it is retried when the page is
    // shown again or on a tap, never in a prompt loop.
    if (denied) return;
    const currentEpoch = epoch;
    const delay = retryDelay;
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (currentEpoch === epoch && snapshot.phase === "error") recover();
    }, delay);
  };

  /** Start over from the first route; re-resolve them when none are known. */
  function recover(): void {
    retryTimer = clear(retryTimer);
    routeIndex = 0;
    if (routes.length) {
      void listen();
      return;
    }
    const currentEpoch = epoch;
    void deps.resolveRoutes(deps.prefs().recognition, targetSessionId ?? deps.host.store.getSnapshot().activeSessionId)
      .then((resolution) => {
        if (currentEpoch !== epoch) return;
        if (!resolution.routes.length) {
          retryLater(deps.strings().unavailable);
          return;
        }
        routes = resolution.routes;
        // A reply already being spoken keeps the microphone closed; it opens
        // when the reply ends.
        if (!speaking()) void listen();
      })
      .catch(() => {
        if (currentEpoch === epoch) retryLater(deps.strings().unavailable);
      });
  }

  const armCommand = (text: string) => {
    commandTimer = clear(commandTimer);
    if (!deps.prefs().commands || !matchVoiceCommand(text, deps.commandPhrases())) return;
    const token = listenerToken;
    commandTimer = setTimeout(() => {
      commandTimer = null;
      if (token === listenerToken && listener) void commit();
    }, COMMAND_SETTLE_MS);
  };

  async function listen(): Promise<void> {
    if (snapshot.phase === "off") return;
    if (!routes.length) {
      recover();
      return;
    }
    stopMonitor();
    cancelListener();
    retryTimer = clear(retryTimer);
    idleTimer = clear(idleTimer);
    if (snapshot.muted) {
      set({ phase: "paused" });
      return;
    }
    const currentEpoch = epoch;
    const token = ++listenerToken;
    runId = `${deps.owner}:${++runs}`;
    streamToComposer = false;
    spanLive = false;
    set({ phase: "listening", userText: "", error: null });
    const prefs = deps.prefs();
    const stale = () => currentEpoch !== epoch || token !== listenerToken;
    const events: ListenerEvents = {
      onPartial: (text) => {
        if (stale()) return;
        retryDelay = RETRY_MIN_MS;
        // Decided when the utterance begins: an idle conversation gets the
        // words in its draft; a busy one gets them sent directly.
        if (!snapshot.userText) {
          streamToComposer = !busy;
          dropAsides();
        }
        set({ phase: "hearing", userText: text });
        // A command on its own never flashes into the draft.
        const command = deps.prefs().commands ? matchVoiceCommand(text, deps.commandPhrases()) : null;
        if (!(command && !command.rest)) spanLive = dictate(text, false) || spanLive;
        armCommand(text);
      },
      onLevel: (level) => { if (!stale()) setLevels({ input: level }); },
      onSpeechStart: () => {
        if (stale() || snapshot.phase !== "listening") return;
        dropAsides();
        set({ phase: "hearing" });
      },
      onEndOfTurn: () => { if (!stale()) void commit(); },
      onError: (error) => {
        if (stale()) return;
        listener = null;
        setLevels({ input: 0 });
        if (isMicDenied(error)) {
          retryLater(deps.strings().micDenied, true);
          return;
        }
        // The route broke mid-turn (network, provider): continue on the next.
        releaseSpan();
        if (routeIndex + 1 < routes.length) {
          routeIndex++;
          void listen();
          return;
        }
        retryLater(error.message || deps.strings().unavailable);
      },
    };
    for (let index = routeIndex; index < routes.length; index++) {
      try {
        const started = await deps.startListener(routes[index]!, events, {
          pauseMs: PAUSE_MS[prefs.pause],
          autoEndpoint: prefs.turnTaking === "auto",
        });
        if (stale()) {
          started.cancel();
          return;
        }
        listener = started;
        routeIndex = index;
        set({ route: routes[index]!.kind });
        sound("listen");
        flushHeld();
        return;
      } catch (error) {
        if (stale()) return;
        if (isMicDenied(error)) {
          retryLater(deps.strings().micDenied, true);
          return;
        }
      }
    }
    retryLater(deps.strings().unavailable);
  }

  async function commit(): Promise<void> {
    const current = listener;
    if (!current) return;
    listener = null;
    listenerToken++;
    commandTimer = clear(commandTimer);
    const currentEpoch = epoch;
    set({ phase: "sending" });
    setLevels({ input: 0 });
    let text = "";
    try {
      text = (await current.stop()).trim();
    } catch {
      text = snapshot.userText.trim();
    }
    if (currentEpoch !== epoch) return;
    const command = deps.prefs().commands ? matchVoiceCommand(text, deps.commandPhrases()) : null;
    if (command) {
      await runCommand(command.command, command.rest);
      return;
    }
    if (!text) {
      releaseSpan();
      void listen();
      return;
    }
    deliver(text, busy ? "queue" : "normal");
    void listen();
  }

  /** Send one utterance: through the composer when it shows the idle
   *  conversation, straight to the pinned conversation otherwise. */
  function deliver(text: string, delivery: "normal" | "queue" | "interrupt"): void {
    sound("send");
    deps.haptic?.();
    set({ userText: text });
    // A reply still being spoken while the user talks is superseded by an
    // interrupting send; a queued message lets it finish.
    if (delivery === "interrupt") dropReply();
    // Confirm the composer still holds this run's words before closing them:
    // an unconsumed final would be queued as an insert for a later composer.
    if (streamToComposer && spanLive && dictate(text, false)) {
      dictate(text, true);
      spanLive = false;
      const submitted = deps.host.conversation.submitDraft?.(
        delivery === "normal" ? { delivery: "queue" } : { delivery: delivery === "queue" ? "queue" : "interrupt" },
      ) ?? false;
      if (submitted) {
        busy = true;
        expectConfirmation(text);
        return;
      }
      // The draft keeps the words; nothing is sent twice.
      notify(deps.strings().notSent);
      return;
    }
    releaseSpan();
    const target = targetSessionId;
    const send = deps.host.conversation.send;
    if (!target || !send) {
      notify(deps.strings().noComposer);
      return;
    }
    busy = true;
    const currentEpoch = epoch;
    void send(target, text, { delivery }).then((ok) => {
      if (currentEpoch !== epoch) return;
      if (!ok) notify(deps.strings().notSent);
      else if (delivery === "queue" && snapshot.agent !== "idle") notify(deps.strings().queued);
    }).catch(() => {
      if (currentEpoch === epoch) notify(deps.strings().notSent);
    });
  }

  function expectConfirmation(text: string): void {
    clearPending();
    pending = { text, at: deps.now() };
    const currentEpoch = epoch;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (currentEpoch !== epoch || !pending) return;
      pending = null;
      notify(deps.strings().notSent);
    }, SEND_CONFIRM_MS);
  }

  async function runCommand(command: VoiceCommandId, rest: string): Promise<void> {
    const strings = deps.strings();
    deps.haptic?.();
    switch (command) {
      case "cancel":
        discardSpan();
        notify(strings.cancelled);
        void listen();
        return;
      case "send":
        if (rest) deliver(rest, busy ? "queue" : "normal");
        else discardSpan();
        void listen();
        return;
      case "sendNow":
        if (rest) {
          deliver(rest, busy ? "interrupt" : "normal");
          void listen();
          return;
        }
        discardSpan();
        void listen();
        await sendQueued();
        return;
      case "stop":
        discardSpan();
        void listen();
        stopAgent();
        return;
    }
  }

  async function sendQueued(): Promise<void> {
    const strings = deps.strings();
    const target = targetSessionId;
    if (!target) {
      notify(strings.nothingQueued);
      return;
    }
    const currentEpoch = epoch;
    try {
      const sent = await deps.sendQueuedNow(target);
      if (currentEpoch !== epoch) return;
      if (!sent) {
        notify(strings.nothingQueued);
        return;
      }
      dropReply();
      sound("send");
      notify(strings.sentNow);
    } catch {
      if (currentEpoch === epoch) notify(strings.notSent);
    }
  }

  /** Stop the spoken reply and the rest of this turn's speech. */
  function dropReply(): void {
    speakTurn = false;
    held = [];
    idleTimer = clear(idleTimer);
    output?.cancel();
    replyWaiting = 0;
    playing = null;
    narrator.dropPending();
    cancelNarrating();
    stopMonitor();
  }

  /** The user or the reply is about to speak: nothing waiting is said. */
  function dropAsides(): void {
    narrator.dropPending();
    cancelNarrating();
    output?.dropAsides();
  }

  function cancelNarrating(): void {
    narrating?.abort();
    narrating = null;
  }

  function stopAgent(): void {
    if (snapshot.phase === "off") return;
    const strings = deps.strings();
    const wasSpeaking = speaking();
    dropReply();
    if (wasSpeaking) void listen();
    const target = targetSessionId;
    if (!target || (!busy && snapshot.agent === "idle")) {
      if (!wasSpeaking) notify(strings.nothingToStop);
      return;
    }
    sound("end");
    notify(strings.stopped);
    const currentEpoch = epoch;
    void deps.stopTurn(target).catch(() => {
      if (currentEpoch === epoch) notify(strings.stopFailed);
    });
  }

  /** Switching to silent drops the reply being spoken and gives the
   *  microphone back; switching to spoken takes the speaker and voices the
   *  next turn (one already running is not joined mid-sentence). */
  function applyFeedback(): void {
    if (snapshot.phase === "off" || silent() === silentNow) return;
    silentNow = silent();
    if (silentNow) {
      const wasSpeaking = speaking();
      dropReply();
      if (wasSpeaking) void listen();
    } else {
      deps.claimSpeaker(deps.owner);
    }
  }

  function interrupt(): void {
    if (!speaking()) return;
    if (playing === "aside" && replyWaiting === 0) {
      // Talking over a remark silences it; the reply to come is still spoken.
      idleTimer = clear(idleTimer);
      output?.cancel();
      playing = null;
      narrator.dropPending();
      stopMonitor();
    } else {
      dropReply();
    }
    void listen();
  }

  /** Reply words held while the user talked are spoken once they finish. */
  function flushHeld(): void {
    if (!held.length) return;
    const chunks = held;
    held = [];
    speak(chunks);
  }

  function speak(chunks: string[]): void {
    if (!chunks.length || !output) return;
    if (snapshot.phase === "hearing" || snapshot.phase === "sending") {
      // The user is mid-sentence: their words win, the reply waits.
      held.push(...chunks);
      return;
    }
    // The reply comes first: remarks still waiting are dropped.
    dropAsides();
    takeSpeaker();
    spoken += chunks.length;
    replyWaiting += chunks.length;
    for (const chunk of chunks) output.enqueue(chunk);
    if (snapshot.phase !== "paused") set({ phase: "speaking", error: null });
    startMonitor();
  }

  /** Nothing heard yet: close the microphone so it does not transcribe what
   *  is spoken. It reopens when the speech ends or pauses. */
  function takeSpeaker(): void {
    idleTimer = clear(idleTimer);
    if (LISTEN_PHASES.has(snapshot.phase) || snapshot.phase === "error") {
      cancelListener();
      releaseSpan();
      retryTimer = clear(retryTimer);
    }
  }

  /** Say the newest remark, unless the reply or the user has the floor. The
   *  one waiting before it is replaced: only fresh news is worth hearing. */
  function speakAside(cues: readonly NarrationCue[]): void {
    const cue = cues.at(-1);
    if (!cue || !output || !speakTurn || silent()) return;
    if (deps.now() - cue.at > ASIDE_FRESH_MS) return;
    if (snapshot.phase === "hearing" || snapshot.phase === "sending" || held.length) return;
    if (replyWaiting > 0 || playing === "reply") return;
    output.dropAsides();
    takeSpeaker();
    spoken++;
    output.enqueue(cue.text, { kind: "aside", expiresAt: cue.at + ASIDE_FRESH_MS });
    if (snapshot.phase !== "paused") set({ phase: "speaking", error: null });
    startMonitor();
  }

  /** A remark worded by the small model when the person chose it; the
   *  phrases otherwise, and whenever the model is unavailable, limited or
   *  slow. Failures are never spoken: after two in a row the conversation
   *  keeps to phrases and says so once on screen. Urgent remarks (a failed
   *  step) and full thoughts (read as written) never wait for the model. */
  function narrate(cues: readonly NarrationCue[]): void {
    const cue = cues.at(-1);
    if (!cue || !speakTurn || silent()) return;
    const prefs = deps.prefs();
    const target = targetSessionId;
    const useModel = prefs.narrator === "model" && deps.narrate && !narratorOff && target && !cue.urgent
      && !(cue.kind === "thought" && prefs.thoughts === "full") && cue.toSeq > cue.fromSeq;
    if (!useModel) {
      speakAside([cue]);
      return;
    }
    cancelNarrating();
    const abort = new AbortController();
    narrating = abort;
    const currentEpoch = epoch;
    void deps.narrate!({
      sessionId: target,
      afterSeq: cue.fromSeq,
      uptoSeq: cue.toSeq,
      kind: cue.kind,
      lang: deps.spokenLang(),
    }, abort.signal).then((outcome) => {
      if (abort.signal.aborted || currentEpoch !== epoch) return;
      narrating = null;
      switch (outcome.kind) {
        case "text":
          narratorFailures = 0;
          speakAside([outcome.text ? { ...cue, text: outcome.text } : cue]);
          return;
        case "unconfigured":
          narratorOff = true;
          break;
        case "failed":
          if (++narratorFailures >= NARRATOR_FAILURES) {
            narratorOff = true;
            notify(deps.strings().narratorFellBack);
          }
          break;
        case "limited":
          break;
      }
      speakAside([cue]);
    });
  }

  /** Key-moment remarks are due when their grouping window closes. */
  function scheduleNarration(): void {
    narrationTimer = clear(narrationTimer);
    const at = narrator.nextDueAt();
    if (at === null) return;
    const currentEpoch = epoch;
    narrationTimer = setTimeout(() => {
      narrationTimer = null;
      if (currentEpoch !== epoch) return;
      narrate(narrator.due());
      scheduleNarration();
    }, Math.max(0, at - deps.now()));
  }

  const activity = (value: ReplyActivity) => {
    switch (value.kind) {
      case "thinking":
        busy = true;
        set({ agent: "working", tool: null, action: null });
        return;
      case "tool":
        busy = true;
        set({ agent: "working", tool: value.tool });
        return;
      case "needs-input":
        busy = true;
        set({ agent: "needs-input" });
        if (speakTurn && !silent()) speak([deps.strings().needsInputSpoken]);
        return;
      case "done":
        busy = false;
        set({ agent: "idle", tool: null, action: null });
        if (value.reason === "error" && speakTurn && !silent()) speak([deps.strings().turnFailed]);
        output?.end();
        return;
    }
  };

  const onEvent = (event: TrackedEvent) => {
    if (snapshot.phase === "off") return;
    if (event.type === "user/message" || event.type === "queue/enqueued") {
      const data = event.data && typeof event.data === "object" ? event.data as { text?: unknown } : {};
      if (pending && typeof data.text === "string" && sameUtterance(pending.text, data.text)) {
        // A New chat learns its conversation from its first message.
        if (!targetSessionId) {
          targetSessionId = event.sessionId;
          set({ sessionId: targetSessionId });
        }
        clearPending();
        if (event.type === "queue/enqueued" && event.sessionId === targetSessionId) notify(deps.strings().queued);
      }
      return;
    }
    if (!targetSessionId || event.sessionId !== targetSessionId) return;
    if (event.type === "turn/started") {
      busy = true;
      tracker.reset();
      held = [];
      // Every turn that starts while voice mode is on is answered aloud; one
      // already running when it started is not (it would begin mid-sentence).
      speakTurn = !silent();
    }
    if (REQUEST_SETTLED.has(event.type) && snapshot.agent === "needs-input") set({ agent: "working" });
    const update = tracker.accept(event);
    if (speakTurn && !silent() && update.speak.length) speak(update.speak);
    if (update.activity) activity(update.activity);
    if ((event.type === "tool/call" || event.type === "tool/started") && deps.host.execution) {
      const data = event.data && typeof event.data === "object" ? event.data as { tool?: unknown; input?: unknown } : {};
      const input = data.input && typeof data.input === "object" && !Array.isArray(data.input)
        ? data.input as Record<string, unknown>
        : {};
      set({ action: actionPhrase(describe(typeof data.tool === "string" ? data.tool : "", input), deps.shownPhrases()) });
    }
    narrate(narrator.accept(event));
    scheduleNarration();
  };

  /** The reply finished or ran dry: give the microphone back. */
  const afterSpeech = () => {
    idleTimer = clear(idleTimer);
    stopMonitor();
    if (speaking()) void listen();
    else flushHeld();
  };

  const outputEvents: SpeechOutputEvents = {
    onSpeaking: (audible) => {
      if (audible && speaking()) startMonitor();
      if (!audible) setLevels({ output: 0 });
    },
    onClaimed: () => {
      // Someone else took the speaker (Read aloud on a message). Listening
      // now would transcribe it, so the microphone pauses until the user taps.
      speakTurn = false;
      held = [];
      replyWaiting = 0;
      playing = null;
      narrator.dropPending();
      cancelNarrating();
      stopMonitor();
      cancelListener();
      releaseSpan();
      set({ phase: "paused", muted: true });
    },
    onLevel: (level) => setLevels({ output: level }),
    onChunk: (text, kind) => {
      playing = kind;
      if (kind === "reply") replyWaiting = Math.max(0, replyWaiting - 1);
      set({ assistantText: text });
      if (speaking()) startMonitor();
    },
    onIdle: () => {
      playing = null;
      // Between streamed sentences, or the agent went off to work: reopen the
      // microphone after a beat so the user can talk while it works. A new
      // sentence in the meantime keeps it closed.
      idleTimer = clear(idleTimer);
      if (!speaking()) return;
      const currentEpoch = epoch;
      const mark = spoken;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (currentEpoch === epoch && speaking() && spoken === mark) afterSpeech();
      }, SPEECH_IDLE_MS);
    },
    onDone: () => {
      playing = null;
      afterSpeech();
    },
  };

  const onVisible = (visible: boolean) => {
    if (!visible || snapshot.phase === "off") return;
    // Mobile browsers release the screen lock and often the recognizer while
    // hidden; take both back.
    if (!releaseWakeLock) acquireWakeLock();
    if (snapshot.phase === "error") {
      recover();
      return;
    }
    if (LISTEN_PHASES.has(snapshot.phase) && !listener) void listen();
  };

  function acquireWakeLock(): void {
    const currentEpoch = epoch;
    void deps.wakeLock?.().then((release) => {
      if (currentEpoch !== epoch) release?.();
      else {
        releaseWakeLock?.();
        releaseWakeLock = release;
      }
    }).catch(() => {});
  }

  function start(): void {
    if (snapshot.phase !== "off") return;
    epoch++;
    // Inside the user's gesture: mobile WebKit unlocks audio only here.
    deps.primeOutput();
    deps.claimTab?.();
    deps.claimMicrophone(deps.owner);
    silentNow = silent();
    if (!silentNow) deps.claimSpeaker(deps.owner);
    routes = [];
    routeIndex = 0;
    retryDelay = RETRY_MIN_MS;
    targetSessionId = deps.host.store.getSnapshot().activeSessionId;
    const status = targetSessionId ? deps.host.sessions.get?.(targetSessionId)?.status : undefined;
    busy = !!status && BUSY_STATUSES.has(status);
    speakTurn = false;
    held = [];
    clearPending();
    tracker.reset();
    narrator.reset();
    replyWaiting = 0;
    playing = null;
    narratorFailures = 0;
    narratorOff = false;
    set({
      ...OFF,
      phase: "starting",
      immersive: snapshot.immersive,
      sessionId: targetSessionId,
      agent: busy ? (status === "waiting" ? "needs-input" : "working") : "idle",
    });
    output = deps.createOutput(deps.outputSettings, outputEvents);
    unsubscribers = [
      deps.host.sessions.subscribeEvents(onEvent),
      // Another microphone owner (the dictation mic) taking over pauses us.
      deps.onMicrophoneClaimed((owner) => {
        if (owner === deps.owner || snapshot.phase === "off") return;
        if (LISTEN_PHASES.has(snapshot.phase) || snapshot.phase === "error") {
          cancelListener();
          releaseSpan();
          retryTimer = clear(retryTimer);
          set({ phase: "paused", muted: true, error: null });
        } else {
          set({ muted: true });
        }
      }),
      // Starting voice mode in another tab ends it here: one microphone,
      // one conversation.
      deps.onTabClaimed?.(() => {
        if (snapshot.phase !== "off") stop();
      }) ?? (() => {}),
      deps.onVisibilityChange?.(onVisible) ?? (() => {}),
    ];
    deps.host.navigation.setActiveView("session");
    sound("start");
    acquireWakeLock();
    recover();
  }

  function stop(): void {
    if (snapshot.phase === "off") return;
    epoch++;
    cancelListener();
    releaseSpan();
    runId = "";
    stopMonitor();
    output?.dispose();
    output = null;
    for (const off of unsubscribers) off();
    unsubscribers = [];
    releaseWakeLock?.();
    releaseWakeLock = null;
    clearPending();
    retryTimer = clear(retryTimer);
    idleTimer = clear(idleTimer);
    noticeTimer = clear(noticeTimer);
    narrationTimer = clear(narrationTimer);
    cancelNarrating();
    narrator.reset();
    replyWaiting = 0;
    playing = null;
    targetSessionId = null;
    busy = false;
    held = [];
    sound("end");
    setLevels({ input: 0, output: 0 });
    set({ ...OFF, immersive: snapshot.immersive });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getLevels: () => levels,
    subscribeLevels(listener) {
      levelListeners.add(listener);
      return () => { levelListeners.delete(listener); };
    },
    start,
    stop,
    toggle() {
      if (snapshot.phase === "off") start();
      else stop();
    },
    primary() {
      switch (snapshot.phase) {
        case "off":
          start();
          return;
        case "listening":
        case "hearing":
          void commit();
          return;
        case "speaking":
          interrupt();
          return;
        case "paused":
          set({ muted: false });
          void listen();
          return;
        case "error":
          retryDelay = RETRY_MIN_MS;
          recover();
          return;
        case "sending":
        case "starting":
          return;
      }
    },
    stopAgent,
    toggleMute() {
      if (snapshot.phase === "off") return;
      const muted = !snapshot.muted;
      set({ muted });
      if (muted) {
        stopMonitor();
        if (LISTEN_PHASES.has(snapshot.phase) || snapshot.phase === "error") {
          cancelListener();
          releaseSpan();
          retryTimer = clear(retryTimer);
          set({ phase: "paused", error: null });
        }
        return;
      }
      if (snapshot.phase === "paused") void listen();
      else startMonitor();
    },
    setImmersive(immersive) {
      set({ immersive });
    },
    applyFeedback,
    dispose() {
      stop();
      listeners.clear();
      levelListeners.clear();
    },
  };
}
