// Voice mode turn-taking with fake recognition, speech output and host. The
// microphone stays open for the whole conversation: idle turns stream into
// the composer and are sent through it, turns spoken while the agent works are
// queued, spoken commands act at once, and nothing gives up on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceModeController, type VoiceHost, type VoiceModeDeps } from "../widgets/controller.ts";
import type { Listener, ListenerEvents, RecognitionRoute } from "../widgets/listener.ts";
import type { MicMonitorEvents } from "../widgets/micMonitor.ts";
import type { TrackedEvent } from "../src/replyTracker.ts";
import { defaultCommandPhrases } from "../src/commands.ts";
import { defaultVoiceModePrefs, type VoiceModePrefs } from "../src/prefs.ts";
import { voiceModeStrings } from "../src/strings.ts";
import { narrationPhrases } from "../src/narrationPhrases.ts";
import type { NarrateRequest } from "../src/narrateRoutes.ts";
import type { NarrateOutcome } from "../widgets/narrateClient.ts";
import type { SpeechOutputEvents } from "@polyth/dictation/voice-runtime";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const strings = voiceModeStrings("en");

interface Sent { sessionId: string; text: string; delivery: string | undefined }

function harness(options: {
  routes?: RecognitionRoute[];
  submit?: boolean;
  startError?: () => Error | null;
  prefs?: Partial<VoiceModePrefs>;
  bargeIn?: boolean;
  activeSessionId?: string | null;
  status?: string;
  queued?: number;
  /** The fake speaker plays one chunk at a time until `finishChunk()`. */
  queueing?: boolean;
  /** The host describes tool calls (as the real host does). */
  describe?: boolean;
  /** The small-model narrator's answers, in order; absent: no narrator. */
  narrate?: Array<NarrateOutcome | "hang">;
  /** A clock the test moves; absent: the real one. */
  now?: () => number;
  /** The conversation-long capture is available (streaming routes use it). */
  shared?: boolean | "denied" | "broken";
} = {}) {
  const dictated: Array<{ runId: string; text: string; final: boolean; discard?: boolean }> = [];
  const submits: Array<{ delivery?: string } | undefined> = [];
  const sent: Sent[] = [];
  const stopped: string[] = [];
  const sentNow: string[] = [];
  const narrations: Array<{ request: NarrateRequest; signal: AbortSignal }> = [];
  const earcons: string[] = [];
  const claims: string[] = [];
  const speakerClaims: string[] = [];
  let tabClaims = 0;
  let eventListener: ((event: TrackedEvent) => void) | null = null;
  let claimListener: ((owner: string) => void) | null = null;
  let tabListener: (() => void) | null = null;
  let visibilityListener: ((visible: boolean) => void) | null = null;
  let activeSessionId: string | null = options.activeSessionId === undefined ? "s1" : options.activeSessionId;
  let composerMounted = true;
  const host: VoiceHost = {
    store: { getSnapshot: () => ({ activeSessionId }) },
    sessions: {
      subscribeEvents(listener) {
        eventListener = listener;
        return () => { eventListener = null; };
      },
      get: () => (options.status ? { status: options.status } : { status: "idle" }),
    },
    conversation: {
      dictate(update) { dictated.push(update); return composerMounted; },
      submitDraft(request) { submits.push(request); return options.submit ?? true; },
      async send(sessionId, text, request) {
        sent.push({ sessionId, text, delivery: request?.delivery });
        return true;
      },
    },
    navigation: { setActiveView() {} },
    ...(options.describe ? {
      execution: {
        describe: (tool: string, input: Readonly<Record<string, unknown>>) => ({
          kind: tool as "read",
          ...(typeof input.path === "string" ? { target: input.path } : {}),
        }),
      },
    } : {}),
  };

  const listeners: Array<{ events: ListenerEvents; final: string; stopped: boolean; cancelled: boolean; route: RecognitionRoute }> = [];
  type Item = { text: string; kind: "reply" | "aside"; expiresAt?: number };
  const output = {
    chunks: [] as string[], items: [] as Item[], queue: [] as Item[], playing: null as Item | null,
    dropAsides: 0, ended: 0, cancelled: 0, speaking: false, events: null as SpeechOutputEvents | null,
  };
  const monitors: Array<{ events: MicMonitorEvents; stopped: boolean }> = [];
  // Narration and the acknowledgement are their own tests' subject: everything
  // else runs with both off, so the speaker holds only what the test names.
  const prefs: VoiceModePrefs = { ...defaultVoiceModePrefs(), actions: false, acknowledge: false, ...options.prefs };
  const stored: { latency: unknown[] } = { latency: [] };
  const live: Array<{ sessionId: string | null; live: boolean }> = [];
  type Capture = { stopped: boolean; dead: boolean; prerolls: number[]; watchers: Array<{ events: MicMonitorEvents; stopped: boolean }>; floor: number | undefined };
  const captures: Capture[] = [];
  const startOptions: Array<{ capture: boolean; noiseFloor: number | undefined }> = [];

  const deps: VoiceModeDeps = {
    host,
    owner: "voice-mode",
    strings: () => strings,
    prefs: () => prefs,
    commandPhrases: () => defaultCommandPhrases(["en", "uk"]),
    outputSettings: () => ({ engine: "browser", lang: "en-US", rate: 1, pitch: 1, volume: 1 }),
    resolveRoutes: async () => ({ routes: options.routes ?? [{ kind: "browser", lang: "en-US", onDevice: false, punctuation: true }] }),
    startListener: async (route, events, listenerOptions) => {
      const error = options.startError?.();
      if (error) throw error;
      startOptions.push({ capture: !!listenerOptions.capture, noiseFloor: listenerOptions.noiseFloor });
      const entry = { events, final: "", stopped: false, cancelled: false, route };
      listeners.push(entry);
      const listener: Listener = {
        route,
        stop: async () => { entry.stopped = true; return entry.final; },
        cancel: () => { entry.cancelled = true; },
      };
      return listener;
    },
    spokenPhrases: () => narrationPhrases("en"),
    spokenLang: () => "en-US",
    ...(options.narrate ? {
      narrate: (request: NarrateRequest, signal: AbortSignal) => {
        narrations.push({ request, signal });
        const next = options.narrate!.shift() ?? { kind: "failed" as const };
        return next === "hang" ? new Promise<NarrateOutcome>(() => {}) : Promise.resolve(next);
      },
    } : {}),
    shownPhrases: () => narrationPhrases("en"),
    createOutput: (_settings, events) => {
      output.events = events;
      return {
        enqueue(text, request = {}) {
          const item: Item = { text, kind: request.kind ?? "reply", ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}) };
          output.chunks.push(text);
          output.items.push(item);
          if (options.queueing && output.playing) {
            output.queue.push(item);
            return;
          }
          output.playing = item;
          if (!output.speaking) { output.speaking = true; events.onSpeaking?.(true); }
          events.onChunk?.(text, item.kind);
        },
        dropAsides() {
          output.dropAsides++;
          output.queue = output.queue.filter((item) => item.kind !== "aside");
        },
        end() {
          output.ended++;
          if (output.speaking) { output.speaking = false; events.onSpeaking?.(false); }
          events.onDone?.();
        },
        cancel() {
          output.cancelled++;
          output.queue = [];
          output.playing = null;
          if (output.speaking) { output.speaking = false; events.onSpeaking?.(false); }
        },
        dispose() { this.cancel(); },
        get active() { return output.speaking; },
      };
    },
    primeOutput: () => {},
    startMicMonitor: async (events) => {
      const entry = { events, stopped: false };
      monitors.push(entry);
      return { stop: () => { entry.stopped = true; } };
    },
    ...(options.shared ? {
      startSharedCapture: async () => {
        if (options.shared === "denied") throw Object.assign(new Error("denied"), { code: "mic_denied" });
        if (options.shared === "broken") throw new Error("no audio worklet");
        const entry: Capture = { stopped: false, dead: false, prerolls: [], watchers: [], floor: 0.004 };
        captures.push(entry);
        return {
          get dead() { return entry.dead; },
          factory(prerollMs = 0) {
            entry.prerolls.push(prerollMs);
            return async () => ({ sampleRate: 16_000, channels: 1 as const, pause: async () => {}, resume: async () => {}, stop() {} });
          },
          noiseFloor: () => entry.floor,
          watch(events: MicMonitorEvents) {
            const watcher = { events, stopped: false };
            entry.watchers.push(watcher);
            return { stop: () => { watcher.stopped = true; } };
          },
          stop() { entry.stopped = true; entry.dead = true; },
        };
      },
    } : {}),
    bargeIn: () => options.bargeIn ?? true,
    earcon: (kind) => { earcons.push(kind); },
    claimMicrophone: (owner) => { claims.push(owner); },
    claimSpeaker: (owner) => { speakerClaims.push(owner); },
    onMicrophoneClaimed: (listener) => {
      claimListener = listener;
      return () => { claimListener = null; };
    },
    stopTurn: async (sessionId) => { stopped.push(sessionId); },
    sendQueuedNow: async (sessionId) => { sentNow.push(sessionId); return options.queued ?? 0; },
    claimTab: () => { tabClaims++; },
    onTabClaimed: (listener) => {
      tabListener = listener;
      return () => { tabListener = null; };
    },
    onVisibilityChange: (listener) => {
      visibilityListener = listener;
      return () => { visibilityListener = null; };
    },
    latencyStore: { load: () => [], save: (list) => { stored.latency = [...list]; } },
    announceLive: (state) => { live.push(state); },
    liveRenewMs: 40,
    now: options.now ?? (() => Date.now()),
  };
  const controller = createVoiceModeController(deps);
  let seq = 0;
  const emit = (type: string, data: Record<string, unknown>, sessionId = "s1") =>
    eventListener?.({ sessionId, seq: ++seq, type, data });
  /** Say something and pause: the recognizer ends the turn. */
  const say = async (text: string, waitedMs?: number) => {
    const turn = listeners.at(-1)!;
    turn.events.onSpeechStart();
    turn.events.onPartial(text);
    turn.final = text;
    turn.events.onEndOfTurn(waitedMs);
    await flush();
  };
  return {
    controller, narrations, dictated, submits, sent, stopped, sentNow, earcons, claims, speakerClaims, listeners, output, monitors,
    emit, say, stored, live, captures, startOptions,
    /** The playing chunk ends: the next one plays, or the speaker goes idle. */
    finishChunk: () => {
      const next = output.queue.shift();
      output.playing = next ?? null;
      if (next) output.events?.onChunk?.(next.text, next.kind);
      else output.events?.onIdle?.();
    },
    tabClaims: () => tabClaims,
    setActive: (id: string | null) => { activeSessionId = id; },
    unmountComposer: () => { composerMounted = false; },
    claimMic: (owner: string) => claimListener?.(owner),
    claimTab: () => tabListener?.(),
    setVisible: (visible: boolean) => visibilityListener?.(visible),
    listener: () => listeners.at(-1)!,
    hasEventListener: () => eventListener !== null,
    setPrefs: (patch: Partial<VoiceModePrefs>) => { Object.assign(prefs, patch); },
  };
}

test("an idle turn goes through the composer, and the microphone stays open while the agent works", async () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.controller.getSnapshot().phase, "starting");
  assert.deepEqual(h.claims, ["voice-mode"], "starting takes the microphone from the dictation mic");
  assert.equal(h.tabClaims(), 1, "starting announces this tab to the others");
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening");
  assert.equal(h.controller.getSnapshot().sessionId, "s1", "voice mode is pinned to the open conversation");

  const turn = h.listener();
  turn.events.onSpeechStart();
  turn.events.onPartial("fix the");
  turn.events.onPartial("fix the failing test");
  assert.equal(h.controller.getSnapshot().phase, "hearing");
  assert.deepEqual(h.dictated.map(({ text, final }) => [text, final]), [["fix the", false], ["fix the failing test", false]],
    "interim words stream into the composer draft");
  turn.final = "Fix the failing test.";
  turn.events.onEndOfTurn();
  await flush();
  assert.equal(turn.stopped, true);
  assert.deepEqual(h.dictated.at(-1), { runId: h.dictated[0]!.runId, text: "Fix the failing test.", final: true },
    "the final transcript closes the composer span");
  assert.equal(h.submits.length, 1, "the composer sends the draft exactly like Send");
  assert.deepEqual(h.submits[0], { delivery: "queue" }, "if a turn is running by then, the message queues");
  assert.ok(h.earcons.includes("send"));
  assert.equal(h.controller.getSnapshot().phase, "listening", "the microphone reopens at once");
  assert.equal(h.listeners.length, 2);

  h.emit("user/message", { text: "Fix the failing test." });
  h.emit("turn/started", { turnId: "t1" });
  assert.equal(h.controller.getSnapshot().agent, "working");
  h.emit("tool/call", { callId: "c0", tool: "read", status: "running", input: {} });
  assert.equal(h.controller.getSnapshot().phase, "listening", "tool work keeps the microphone open");
  assert.equal(h.controller.getSnapshot().tool, "read");

  h.emit("assistant/chunk", { partId: "p1", text: "I found the problem. The" });
  assert.deepEqual(h.output.chunks, ["I found the problem."], "speech starts on the first finished sentence");
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  assert.equal(h.listeners[1]!.cancelled, true, "the microphone closes so it does not hear the reply");
  h.emit("assistant/message", { partId: "p1", text: "I found the problem. The assertion used the old name." });
  h.emit("turn/stopped", { reason: "completed" });
  assert.equal(h.output.ended, 1);
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening", "listening resumes when the reply ends");
  assert.equal(h.controller.getSnapshot().agent, "idle");

  h.controller.stop();
  assert.equal(h.controller.getSnapshot().phase, "off");
  assert.equal(h.listener().cancelled, true, "ending releases the recognizer");
  assert.equal(h.hasEventListener(), false, "ending stops observing the conversation");
});

test("speech that pauses for tool work gives the microphone back until the next sentence", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Let me check. " });
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  const before = h.listeners.length;
  h.output.events?.onIdle?.();
  await wait(750);
  assert.equal(h.controller.getSnapshot().phase, "listening", "a reply that ran dry reopens the microphone");
  assert.equal(h.listeners.length, before + 1);
  h.emit("assistant/chunk", { partId: "p2", text: "Found it. " });
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  h.controller.stop();
});

test("a turn spoken while the agent works is queued straight to the conversation", async () => {
  const h = harness({ status: "working" });
  h.controller.start();
  await flush();
  assert.equal(h.controller.getSnapshot().agent, "working", "a running turn is known from the start");
  await h.say("and also update the docs");
  assert.equal(h.dictated.length, 0, "a busy conversation's draft is left alone");
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.sent, [{ sessionId: "s1", text: "and also update the docs", delivery: "queue" }]);
  await flush();
  assert.equal(h.controller.getSnapshot().notice, strings.queued);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.stop();
});

test("a request for the user's input keeps listening; what is said is queued without dismissing it", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("permission/requested", { requestId: "r1", permission: "bash", patterns: [] });
  assert.equal(h.output.chunks.at(-1), strings.needsInputSpoken);
  assert.equal(h.controller.getSnapshot().agent, "needs-input");
  h.output.events?.onIdle?.();
  await wait(750);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  await h.say("why do you need that");
  assert.deepEqual(h.sent.at(-1), { sessionId: "s1", text: "why do you need that", delivery: "queue" },
    "sent directly (no composer dismissal of the pending request)");
  h.emit("permission/resolved", { requestId: "r1" });
  assert.equal(h.controller.getSnapshot().agent, "working");
  h.controller.stop();
});

test("“stop” acts at once: no message, no draft, the running turn stops", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  const turn = h.listener();
  turn.events.onSpeechStart();
  turn.events.onPartial("Stop.");
  turn.final = "Stop.";
  assert.equal(h.dictated.length, 0, "a command on its own never flashes into the draft");
  await wait(500);
  assert.equal(turn.stopped, true, "the command does not wait for the end-of-turn pause");
  assert.deepEqual(h.stopped, ["s1"]);
  assert.equal(h.sent.length + h.submits.length, 0, "a command is never sent as a message");
  assert.equal(h.controller.getSnapshot().notice, strings.stopped);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.stop();
});

test("“stop” also silences a spoken reply; Ukrainian phrases work too", async () => {
  const h = harness({ bargeIn: true });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Here is a long answer. " });
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  h.monitors.at(-1)!.events.onSpeech();
  await flush();
  assert.equal(h.output.cancelled, 1, "talking over the reply stops it");
  await h.say("Зупинись!");
  assert.deepEqual(h.stopped, ["s1"]);
  const spoken = h.output.chunks.length;
  h.emit("assistant/chunk", { partId: "p1", text: "More words. " });
  assert.equal(h.output.chunks.length, spoken, "the rest of an interrupted reply stays unspoken");
  h.controller.stop();
});

test("“send now” delivers the queue at once; “…, send now” sends those words interrupting the turn", async () => {
  const h = harness({ status: "working", queued: 2 });
  h.controller.start();
  await flush();
  await h.say("send now");
  await flush();
  assert.deepEqual(h.sentNow, ["s1"], "the queued messages go now");
  assert.equal(h.controller.getSnapshot().notice, strings.sentNow);

  await h.say("Use the staging database, send now.");
  assert.deepEqual(h.sent.at(-1), { sessionId: "s1", text: "Use the staging database", delivery: "interrupt" });

  await h.say("відправ вже");
  assert.equal(h.sentNow.length, 2, "the user's own phrase in Ukrainian");
  h.controller.stop();
});

test("“send now” with nothing queued says so", async () => {
  const h = harness({ status: "working", queued: 0 });
  h.controller.start();
  await flush();
  await h.say("Send now.");
  await flush();
  assert.equal(h.controller.getSnapshot().notice, strings.nothingQueued);
  h.controller.stop();
});

test("manual turn-taking: “…, send” ends the turn by voice and “…, cancel” discards it", async () => {
  const h = harness({ prefs: { turnTaking: "manual" } });
  h.controller.start();
  await flush();
  let turn = h.listener();
  turn.events.onPartial("rename the helper send");
  turn.final = "Rename the helper, send.";
  await wait(500);
  assert.deepEqual(h.dictated.at(-1)?.text, "Rename the helper", "the span is rewritten without the command");
  assert.equal(h.dictated.at(-1)?.final, true);
  assert.equal(h.submits.length, 1);
  h.emit("turn/started", {});
  h.emit("turn/stopped", { reason: "completed" });

  turn = h.listener();
  turn.events.onPartial("delete everything cancel");
  turn.final = "Delete everything, cancel.";
  await wait(500);
  assert.deepEqual(h.dictated.at(-1), { runId: h.dictated.at(-1)!.runId, text: "", final: true, discard: true },
    "the words are taken back out of the draft");
  assert.equal(h.submits.length, 1, "nothing more was sent");
  assert.equal(h.controller.getSnapshot().notice, strings.cancelled);
  h.controller.stop();
});

test("commands can be turned off: the words are an ordinary message", async () => {
  const h = harness({ prefs: { commands: false } });
  h.controller.start();
  await flush();
  await h.say("stop");
  assert.equal(h.stopped.length, 0);
  assert.equal(h.submits.length, 1);
  h.controller.stop();
});

test("silent control mode never speaks or plays sounds, and keeps listening through the reply", async () => {
  const h = harness({ prefs: { feedback: "silent" } });
  h.controller.start();
  await flush();
  assert.deepEqual(h.speakerClaims, [], "a silent conversation leaves Read aloud alone");
  await h.say("run the tests");
  h.emit("user/message", { text: "run the tests" });
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Running them now. All green. " });
  h.emit("turn/stopped", { reason: "error", error: "boom" });
  assert.deepEqual(h.output.chunks, [], "nothing is spoken");
  assert.deepEqual(h.earcons, [], "no tones either");
  assert.equal(h.controller.getSnapshot().phase, "listening");
  await h.say("stop");
  assert.equal(h.controller.getSnapshot().notice, strings.nothingToStop, "commands still work");
  h.controller.stop();
});

test("switching Replies mid-conversation silences the reply at once and voices the next turn", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  assert.deepEqual(h.speakerClaims, ["voice-mode"]);
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Let me check. " });
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  const before = h.listeners.length;

  h.setPrefs({ feedback: "silent" });
  h.controller.applyFeedback();
  assert.equal(h.output.cancelled, 1, "the reply being spoken stops");
  assert.equal(h.controller.getSnapshot().phase, "listening", "the microphone comes back");
  assert.equal(h.listeners.length, before + 1);
  h.emit("assistant/chunk", { partId: "p2", text: "Found it. " });
  assert.deepEqual(h.output.chunks, ["Let me check."], "the rest of the reply stays silent");
  h.controller.applyFeedback();
  assert.equal(h.output.cancelled, 1, "an unchanged preference does nothing");
  h.emit("turn/stopped", { reason: "completed" });

  h.setPrefs({ feedback: "voice" });
  h.controller.applyFeedback();
  assert.deepEqual(h.speakerClaims, ["voice-mode", "voice-mode"], "spoken replies take the speaker back");
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p3", text: "Done. " });
  assert.equal(h.output.chunks.at(-1), "Done.", "the next turn is spoken");
  h.controller.stop();
  h.controller.applyFeedback();
  assert.equal(h.speakerClaims.length, 2, "nothing happens while voice mode is off");
});

test("voice mode stays with its conversation when another one is opened", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.setActive("s2");
  await h.say("check the logs");
  assert.equal(h.submits.length, 0, "the other conversation's composer is not used");
  assert.deepEqual(h.sent, [{ sessionId: "s1", text: "check the logs", delivery: "normal" }]);
  h.controller.stop();
});

test("a New chat is pinned by its first message", async () => {
  const h = harness({ activeSessionId: null });
  h.controller.start();
  await flush();
  assert.equal(h.controller.getSnapshot().sessionId, null);
  await h.say("start a new project");
  assert.equal(h.submits.length, 1, "the New chat composer creates the conversation");
  h.emit("user/message", { text: "start a new project" }, "s9");
  assert.equal(h.controller.getSnapshot().sessionId, "s9");
  h.setActive("s7");
  await h.say("and add a readme");
  assert.deepEqual(h.sent.at(-1)?.sessionId, "s9");
  h.controller.stop();
});

test("a reply that arrives while the user talks waits until they finish", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  const turn = h.listener();
  turn.events.onSpeechStart();
  turn.events.onPartial("one more thing");
  h.emit("assistant/chunk", { partId: "p1", text: "Done with the first part. " });
  assert.deepEqual(h.output.chunks, [], "the user's words win");
  assert.equal(turn.cancelled, false, "the user is not cut off");
  turn.final = "one more thing";
  turn.events.onEndOfTurn();
  await flush();
  await flush();
  assert.deepEqual(h.output.chunks, ["Done with the first part."], "the held reply is spoken afterwards");
  h.controller.stop();
});

test("a refused composer send is a notice, not the end of the conversation", async () => {
  const h = harness({ submit: false });
  h.controller.start();
  await flush();
  await h.say("hello");
  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, "listening");
  assert.equal(snapshot.notice, strings.notSent);
  h.controller.stop();
});

test("a broken route falls back, and when every route fails it retries by itself", async () => {
  const h = harness({
    routes: [
      { kind: "server", language: "en-US" },
      { kind: "browser", lang: "en-US", onDevice: false, punctuation: true },
    ],
  });
  h.controller.start();
  await flush();
  assert.equal(h.listener().route.kind, "server");
  h.listener().events.onError(new Error("network"));
  await flush();
  assert.equal(h.listener().route.kind, "browser", "a failing server route continues in the browser recognizer");
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.listener().events.onError(new Error("Speech recognition keeps stopping"));
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "error");
  await wait(1_100);
  assert.equal(h.controller.getSnapshot().phase, "listening", "retried without a tap");
  assert.equal(h.listener().route.kind, "server", "from the first route again");
  h.controller.stop();
});

test("a denied microphone waits for the user, and recovers when the page is shown again", async () => {
  let denied = true;
  const h = harness({ startError: () => denied ? Object.assign(new Error("denied"), { code: "mic_denied" }) : null });
  h.controller.start();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "error");
  assert.equal(h.controller.getSnapshot().error, strings.micDenied);
  await wait(1_100);
  assert.equal(h.listeners.length, 0, "no permission prompt loop");
  denied = false;
  h.setVisible(true);
  await flush();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.stop();
});

test("a recognizer lost while the tab was hidden comes back when it is shown", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  const before = h.listeners.length;
  // Hidden: the browser ended recognition without telling the turn.
  h.listener().events.onError(new Error("aborted"));
  await flush();
  h.setVisible(true);
  await flush();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening");
  assert.ok(h.listeners.length > before);
  h.controller.stop();
});

test("starting voice mode in another tab ends it here", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.claimTab();
  assert.equal(h.controller.getSnapshot().phase, "off");
  assert.equal(h.listener().cancelled, true);
});

test("the dictation mic taking the microphone pauses voice mode", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.claimMic("dictation-mic:1");
  assert.equal(h.controller.getSnapshot().phase, "paused");
  assert.equal(h.listener().cancelled, true);
  h.claimMic("voice-mode");
  assert.equal(h.controller.getSnapshot().phase, "paused", "its own claim is ignored");
  h.controller.primary();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening", "a tap resumes");
  h.controller.stop();
});

test("another speaker owner taking over pauses voice mode instead of transcribing it", async () => {
  const h = harness();
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Step one. " });
  h.output.events?.onClaimed?.();
  assert.equal(h.controller.getSnapshot().phase, "paused");
  h.controller.stop();
});

test("barge-in can be off; a tap still interrupts, and the Stop control stops the agent", async () => {
  const h = harness({ bargeIn: false });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("assistant/chunk", { partId: "p1", text: "Going. " });
  await flush();
  assert.equal(h.monitors.length, 0, "no microphone is opened during the reply");
  h.controller.primary();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.stopAgent();
  assert.deepEqual(h.stopped, ["s1"]);
  h.controller.stop();
});

test("narration is off unless chosen; the status line still says the step in words", async () => {
  const h = harness({ describe: true });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "config.ts" } });
  assert.deepEqual(h.output.items, [], "nothing is spoken about the work by default");
  assert.equal(h.controller.getSnapshot().action, "Reading config.ts");
  assert.equal(h.controller.getSnapshot().tool, "read");
  h.emit("turn/stopped", { reason: "completed" });
  assert.equal(h.controller.getSnapshot().action, null);
  h.controller.stop();
});

test("each step is said as an aside that expires, and the microphone closes for it", async () => {
  const h = harness({ describe: true, prefs: { actions: true, narrationCadence: "every" } });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  const before = Date.now();
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "config.ts" } });
  assert.deepEqual(h.output.items.map(({ text, kind }) => [text, kind]), [["Reading config.ts.", "aside"]]);
  assert.ok((h.output.items[0]!.expiresAt ?? 0) >= before + 5_000, "an aside goes stale if it waits too long");
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  assert.equal(h.listeners[0]!.cancelled, true, "the microphone does not hear the aside");
  h.emit("tool/started", { callId: "c1", tool: "read", input: { path: "config.ts" } });
  assert.equal(h.output.items.length, 1, "the same call is said once");
  h.controller.stop();
});

test("the reply drops waiting asides, and an aside never waits in front of the reply", async () => {
  const h = harness({ describe: true, queueing: true, prefs: { actions: true, narrationCadence: "every" } });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
  h.emit("tool/call", { callId: "c2", tool: "edit", status: "running", input: { path: "a.ts" } });
  h.emit("tool/call", { callId: "c3", tool: "test", status: "running", input: {} });
  assert.deepEqual(h.output.queue.map(({ text }) => text), ["Running the tests."], "the newest aside replaces the one waiting");
  h.emit("assistant/chunk", { partId: "p1", text: "All tests pass now. " });
  assert.deepEqual(h.output.queue.map(({ text, kind }) => [text, kind]), [["All tests pass now.", "reply"]],
    "the reply comes first: the waiting aside is gone");
  h.finishChunk();
  assert.equal(h.output.playing?.kind, "reply");
  h.emit("tool/call", { callId: "c4", tool: "read", status: "running", input: { path: "b.ts" } });
  assert.equal(h.output.items.at(-1)!.kind, "reply", "no aside while the reply plays");
  h.controller.stop();
});

test("talking drops waiting asides; talking over one keeps the reply to come", async () => {
  const h = harness({ describe: true, queueing: true, prefs: { actions: true, narrationCadence: "every" } });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
  await flush();
  h.monitors.at(-1)!.events.onSpeech();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "listening", "barge-in silences the aside");
  const drops = h.output.dropAsides;
  h.listener().events.onSpeechStart();
  assert.ok(h.output.dropAsides > drops, "the user's words drop what waits");
  h.listener().events.onPartial("hold on");
  h.emit("tool/call", { callId: "c2", tool: "edit", status: "running", input: { path: "a.ts" } });
  assert.equal(h.output.items.length, 1, "no aside while the user talks");
  h.listener().final = "";
  h.listener().events.onEndOfTurn();
  await flush();
  h.emit("assistant/chunk", { partId: "p1", text: "Fixed it. " });
  assert.equal(h.output.items.at(-1)!.text, "Fixed it.", "the turn's reply is still spoken");
  h.controller.stop();
});

test("silent replies say nothing about the work either", async () => {
  const h = harness({ describe: true, prefs: { actions: true, thoughts: "full", narrationCadence: "every", feedback: "silent" } });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("assistant/reasoning-chunk", { partId: "r1", text: "The parser drops the last line when the file has no newline. " });
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
  assert.deepEqual(h.output.items, []);
  assert.equal(h.controller.getSnapshot().action, "Reading a.ts", "the status line still says what is happening");
  h.controller.stop();
});

test("the small model words a remark from the history slice; without one, phrases are spoken", async () => {
  const h = harness({
    describe: true,
    prefs: { actions: true, narrationCadence: "every", narrator: "model" },
    narrate: [{ kind: "text", text: "I'm checking the clock helper." }, { kind: "unconfigured" }],
  });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("tool/call", { callId: "c1", tool: "read", status: "running", input: { path: "clock.ts" } });
  assert.equal(h.output.items.length, 0, "nothing is said while the model words it");
  assert.deepEqual(h.narrations[0]!.request, { sessionId: "s1", afterSeq: 1, uptoSeq: 2, kind: "actions", lang: "en-US" });
  await flush();
  assert.deepEqual(h.output.items.map(({ text, kind }) => [text, kind]), [["I'm checking the clock helper.", "aside"]]);

  h.output.events?.onIdle?.();
  h.emit("tool/call", { callId: "c2", tool: "edit", status: "running", input: { path: "clock.ts" } });
  await flush();
  assert.equal(h.output.items.at(-1)!.text, "Editing clock.ts.", "no small model: the phrase is said instead");
  h.emit("tool/call", { callId: "c3", tool: "read", status: "running", input: { path: "a.ts" } });
  assert.equal(h.narrations.length, 2, "and the model is not asked again in this conversation");
  h.controller.stop();
});

test("two failures in a row keep the conversation to phrases and say so once on screen", async () => {
  const h = harness({
    describe: true,
    prefs: { actions: true, narrationCadence: "every", narrator: "model" },
    narrate: [{ kind: "failed" }, { kind: "limited" }, { kind: "failed" }],
  });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  for (const [index, tool] of ["read", "edit", "test", "read"].entries()) {
    h.emit("tool/call", { callId: `c${index}`, tool, status: "running", input: { path: `f${index}.ts` } });
    await flush();
  }
  assert.equal(h.narrations.length, 3, "a rate limit is not a failure; the second failure stops the asking");
  assert.equal(h.controller.getSnapshot().notice, strings.narratorFellBack);
  assert.equal(h.output.items.at(-1)!.text, "Reading f3.ts.");
  h.controller.stop();
});

test("failures and full thoughts never wait for the model, and the reply cancels a remark being worded", async () => {
  const h = harness({
    describe: true,
    prefs: { actions: true, thoughts: "full", narrationCadence: "every", narrator: "model" },
    narrate: ["hang"],
  });
  h.controller.start();
  await flush();
  h.emit("turn/started", {});
  h.emit("tool/error", { callId: "c1", tool: "test", error: "exit 1" });
  assert.equal(h.output.items.at(-1)!.text, "The tests failed.");
  h.output.events?.onIdle?.();
  h.emit("assistant/reasoning-chunk", { partId: "r1", text: "The snapshot comparison runs before the clock is frozen, so it drifts. " });
  assert.equal(h.narrations.length, 0);
  assert.match(h.output.items.at(-1)!.text, /snapshot comparison/);
  h.output.events?.onIdle?.();
  h.emit("tool/call", { callId: "c2", tool: "read", status: "running", input: { path: "a.ts" } });
  assert.equal(h.narrations.length, 1);
  h.emit("assistant/chunk", { partId: "p1", text: "Fixed. " });
  assert.equal(h.narrations[0]!.signal.aborted, true, "the reply comes first");
  h.controller.stop();
});

test("a fallback route refused after the first route failed shows the first route's reason", async () => {
  // iOS app: the server route heard no audio, then Web Speech (the fallback)
  // was refused — "microphone blocked" would name the wrong cause.
  const routes: RecognitionRoute[] = [
    { kind: "server", language: "uk-UA" },
    { kind: "browser", lang: "uk-UA", onDevice: false, punctuation: false },
  ];
  let calls = 0;
  const h = harness({
    routes,
    startError: () => {
      calls++;
      if (calls === 1) return null;
      return Object.assign(new Error("denied"), { code: "mic_denied" });
    },
  });
  h.controller.start();
  await flush();
  assert.equal(h.listener().route.kind, "server");
  h.listener().events.onError(Object.assign(new Error("The microphone is on but no sound is coming through"), { code: "audio_format_error" }));
  await flush();
  await flush();
  assert.equal(h.controller.getSnapshot().phase, "error");
  assert.equal(h.controller.getSnapshot().error, "The microphone is on but no sound is coming through");
  h.controller.stop();
});

test("a refusal on the first route still reads as a blocked microphone", async () => {
  const h = harness({
    routes: [
      { kind: "server", language: "uk-UA" },
      { kind: "browser", lang: "uk-UA", onDevice: false, punctuation: false },
    ],
    startError: () => Object.assign(new Error("denied"), { code: "mic_denied" }),
  });
  h.controller.start();
  await flush();
  assert.equal(h.controller.getSnapshot().error, strings.micDenied);
  h.controller.stop();
});

test("a started turn that stays silent is acknowledged once — never before it has started", async () => {
  const h = harness({ prefs: { acknowledge: true } });
  h.controller.start();
  await flush();
  await h.say("Fix the failing test.");
  h.emit("user/message", { text: "Fix the failing test." });
  await wait(360);
  assert.equal(h.output.items.length, 0, "an accepted message is not yet a turn that runs: nothing is promised");
  h.emit("turn/started", { turnId: "t1" });
  assert.equal(h.output.items.length, 0, "a reply that begins at once would make it redundant");
  await wait(360);
  assert.deepEqual(h.output.items, [{ text: "Got it.", kind: "aside", expiresAt: h.output.items[0]!.expiresAt }]);
  assert.equal(h.controller.getSnapshot().agent, "working");
  h.emit("assistant/chunk", { partId: "p1", text: "The assertion used the old name. " });
  assert.deepEqual(h.output.items.map((item) => item.kind), ["aside", "reply"], "the reply follows; it is not acknowledged again");
  h.emit("turn/stopped", { reason: "completed" });

  h.output.events?.onDone?.();
  await flush();
  await h.say("And run the tests.");
  h.emit("user/message", { text: "And run the tests." });
  h.emit("turn/started", { turnId: "t2" });
  await wait(360);
  assert.equal(h.output.items.at(-1)!.text, "On it.", "the next turn uses the next phrase");
  h.controller.stop();
});

test("no acknowledgement when the reply begins first, for a queued message, in silent mode or when switched off", async () => {
  const fast = harness({ prefs: { acknowledge: true } });
  fast.controller.start();
  await flush();
  await fast.say("What time is it?");
  fast.emit("user/message", { text: "What time is it?" });
  fast.emit("turn/started", { turnId: "t1" });
  fast.emit("assistant/chunk", { partId: "p1", text: "It is noon. " });
  await wait(360);
  assert.deepEqual(fast.output.items.map((item) => item.kind), ["reply"]);
  fast.controller.stop();

  const queued = harness({ prefs: { acknowledge: true }, status: "working" });
  queued.controller.start();
  await flush();
  await queued.say("Then update the docs.");
  assert.equal(queued.sent[0]!.delivery, "queue");
  queued.emit("turn/started", { turnId: "t2" });
  await wait(360);
  assert.deepEqual(queued.output.items, [], "its turn starts whenever the queue drains: no remark out of nowhere");
  queued.controller.stop();

  for (const prefs of [{ acknowledge: true, feedback: "silent" as const }, { acknowledge: false }]) {
    const h = harness({ prefs });
    h.controller.start();
    await flush();
    await h.say("Fix it.");
    h.emit("user/message", { text: "Fix it." });
    h.emit("turn/started", { turnId: "t1" });
    await wait(360);
    assert.deepEqual(h.output.items, []);
    h.controller.stop();
  }
});

test("a turn that ended before the acknowledgement was due is not acknowledged", async () => {
  const h = harness({ prefs: { acknowledge: true } });
  h.controller.start();
  await flush();
  await h.say("Never mind.");
  h.emit("user/message", { text: "Never mind." });
  h.emit("turn/started", { turnId: "t1" });
  h.emit("turn/stopped", { reason: "aborted" });
  await wait(360);
  assert.deepEqual(h.output.items, []);
  h.controller.stop();
});

test("each spoken turn is measured from the end of speech to the first reply sound", async () => {
  let now = 50_000;
  const h = harness({ now: () => now, prefs: { acknowledge: false } });
  let changes = 0;
  h.controller.subscribeLatency(() => { changes++; });
  h.controller.start();
  await flush();
  await h.say("Fix the failing test.", 550);
  now += 80;
  h.emit("user/message", { text: "Fix the failing test." });
  now += 220;
  h.emit("turn/started", { turnId: "t1" });
  now += 1_400;
  h.emit("assistant/chunk", { partId: "p1", text: "Found it. " });
  assert.deepEqual(h.controller.getLatency(), [{
    at: 51_700, pause: 550, recognition: 0, sending: 300, agent: 1_400, voice: 0, total: 2_250,
  }]);
  assert.equal(changes, 1);
  assert.deepEqual(h.stored.latency, h.controller.getLatency(), "kept on the device: times only");
  h.emit("assistant/chunk", { partId: "p1", text: "The name was wrong. " });
  assert.equal(h.controller.getLatency().length, 1, "later sentences of the same reply are not new measurements");
  h.controller.stop();
});

test("queued turns, commands and refused sends are not measured", async () => {
  let now = 1_000;
  const busy = harness({ now: () => now, status: "working" });
  busy.controller.start();
  await flush();
  await busy.say("Then update the docs.");
  busy.emit("turn/started", { turnId: "t2" });
  busy.emit("assistant/chunk", { partId: "p1", text: "Done. " });
  assert.deepEqual(busy.controller.getLatency(), [], "a queued message waited behind another turn");
  busy.controller.stop();

  const refused = harness({ now: () => now, submit: false });
  refused.controller.start();
  await flush();
  await refused.say("Fix it.");
  refused.emit("turn/started", { turnId: "t1" });
  refused.emit("assistant/chunk", { partId: "p1", text: "Done. " });
  assert.deepEqual(refused.controller.getLatency(), [], "the composer refused it: that turn is not this message's");
  refused.controller.stop();

  const command = harness({ now: () => now });
  command.controller.start();
  await flush();
  await command.say("stop");
  command.emit("turn/started", { turnId: "t1" });
  command.emit("assistant/chunk", { partId: "p1", text: "Done. " });
  assert.deepEqual(command.controller.getLatency(), []);
  command.controller.stop();
  now += 1;
});

test("the server is told while replies are heard: on start, renewed, moved to a New chat's conversation, dropped on silent and at the end", async () => {
  const h = harness({ activeSessionId: null });
  h.controller.start();
  assert.deepEqual(h.live, [{ sessionId: null, live: true }], "a New chat is spoken before it has a conversation");
  await flush();
  await wait(100);
  assert.ok(h.live.length >= 3 && h.live.every((state) => state.live && state.sessionId === null), "renewed while it holds");
  await h.say("Start a new project.");
  h.emit("user/message", { text: "Start a new project." }, "new-1");
  assert.deepEqual(h.live.at(-1), { sessionId: "new-1", live: true }, "the first message names the conversation");

  h.setPrefs({ feedback: "silent" });
  h.controller.applyFeedback();
  assert.deepEqual(h.live.at(-1), { sessionId: "new-1", live: false }, "silent replies are read, not heard");
  const quiet = h.live.length;
  await wait(100);
  assert.equal(h.live.length, quiet, "nothing is renewed while silent");
  h.setPrefs({ feedback: "voice" });
  h.controller.applyFeedback();
  assert.deepEqual(h.live.at(-1), { sessionId: "new-1", live: true });
  h.controller.stop();
  assert.deepEqual(h.live.at(-1), { sessionId: "new-1", live: false });
  const ended = h.live.length;
  await wait(100);
  assert.equal(h.live.length, ended, "ending voice mode stops the renewals");

  const silent = harness({ prefs: { feedback: "silent" } });
  silent.controller.start();
  await flush();
  silent.controller.stop();
  assert.deepEqual(silent.live, [], "a silent conversation is never announced");
});

const STREAM: RecognitionRoute[] = [{ kind: "server", language: "en" }];

test("a streaming recognizer shares one microphone for the whole conversation", async () => {
  const h = harness({ routes: STREAM, shared: true });
  h.controller.start();
  await flush();
  assert.equal(h.captures.length, 1, "opened with the first turn");
  assert.deepEqual(h.startOptions, [{ capture: true, noiseFloor: undefined }], "the recognizer takes its audio from it");
  await h.say("Fix the failing test.");
  h.emit("user/message", { text: "Fix the failing test." });
  h.emit("turn/started", { turnId: "t1" });
  h.emit("assistant/chunk", { partId: "p1", text: "I found the problem. " });
  assert.equal(h.controller.getSnapshot().phase, "speaking");
  assert.equal(h.listeners.at(-1)!.cancelled, true, "no recognizer listens to the reply");
  assert.equal(h.captures[0]!.stopped, false, "…but the microphone itself stays open");
  assert.equal(h.monitors.length, 0, "noticing a barge-in needs no second microphone");
  assert.equal(h.captures[0]!.watchers.length, 1);
  h.output.events?.onDone?.();
  await flush();
  assert.equal(h.captures.length, 1, "the next turn reuses it");
  assert.deepEqual(h.captures[0]!.prerolls, [0, 0, 0], "an ordinary turn replays nothing from before");
  assert.equal(h.captures[0]!.watchers[0]!.stopped, true);
  h.controller.stop();
  assert.equal(h.captures[0]!.stopped, true, "ending the conversation closes the microphone");
});

test("talking over a reply hands the recognizer the words already spoken and the room's loudness", async () => {
  const h = harness({ routes: STREAM, shared: true });
  h.controller.start();
  await flush();
  h.emit("turn/started", { turnId: "t1" });
  h.emit("assistant/chunk", { partId: "p1", text: "Here is a long explanation. " });
  const before = h.listeners.length;
  h.captures[0]!.watchers[0]!.events.onSpeech();
  await flush();
  assert.equal(h.output.cancelled, 1, "the reply stops");
  assert.equal(h.controller.getSnapshot().phase, "listening");
  assert.equal(h.listeners.length, before + 1);
  assert.equal(h.captures[0]!.prerolls.at(-1), 700, "the recognizer first hears the moment before the interruption");
  assert.deepEqual(h.startOptions.at(-1), { capture: true, noiseFloor: 0.004 },
    "it cannot learn the room from audio that begins with speech, so it is told");

  h.emit("assistant/chunk", { partId: "p1", text: "More of the same reply. " });
  h.controller.primary();
  h.controller.stop();
});

test("a tap to interrupt replays nothing: nobody was speaking yet", async () => {
  const h = harness({ routes: STREAM, shared: true });
  h.controller.start();
  await flush();
  h.emit("turn/started", { turnId: "t1" });
  h.emit("assistant/chunk", { partId: "p1", text: "Here is a long explanation. " });
  h.controller.primary();
  await flush();
  assert.equal(h.captures[0]!.prerolls.at(-1), 0);
  assert.equal(h.startOptions.at(-1)!.noiseFloor, undefined);
  h.controller.stop();
});

test("mute and another microphone owner close the shared microphone; it reopens when listening resumes", async () => {
  const h = harness({ routes: STREAM, shared: true });
  h.controller.start();
  await flush();
  h.controller.toggleMute();
  assert.equal(h.captures[0]!.stopped, true, "muted means closed, not merely unused");
  h.controller.toggleMute();
  await flush();
  assert.equal(h.captures.length, 2);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.claimMic("dictation");
  assert.equal(h.captures[1]!.stopped, true, "the dictation mic takes the microphone, all of it");
  assert.equal(h.controller.getSnapshot().phase, "paused");
  h.controller.stop();
});

test("the shared microphone is only for streaming recognizers with barge-in on, and failing to open it is not fatal", async () => {
  const browser = harness({ shared: true });
  browser.controller.start();
  await flush();
  assert.equal(browser.captures.length, 0, "the browser recognizer captures by itself");
  assert.deepEqual(browser.startOptions, [{ capture: false, noiseFloor: undefined }]);
  browser.controller.stop();

  const off = harness({ routes: STREAM, shared: true, bargeIn: false });
  off.controller.start();
  await flush();
  assert.equal(off.captures.length, 0, "where an open microphone hurts playback (iPhone), each turn opens its own");
  off.controller.stop();

  const broken = harness({ routes: STREAM, shared: "broken" });
  broken.controller.start();
  await flush();
  assert.equal(broken.controller.getSnapshot().phase, "listening", "the recognizer opens the microphone itself");
  assert.deepEqual(broken.startOptions, [{ capture: false, noiseFloor: undefined }]);
  broken.controller.stop();

  const denied = harness({ routes: STREAM, shared: "denied" });
  denied.controller.start();
  await flush();
  assert.equal(denied.controller.getSnapshot().phase, "error");
  assert.equal(denied.controller.getSnapshot().error, strings.micDenied, "a blocked microphone is said plainly");
  assert.equal(denied.listeners.length, 0);
  denied.controller.stop();
});

test("a shared microphone that died is replaced on the next turn", async () => {
  const h = harness({ routes: STREAM, shared: true });
  h.controller.start();
  await flush();
  h.captures[0]!.dead = true;
  await h.say("Fix it.");
  await flush();
  assert.equal(h.captures.length, 2);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.stop();
  assert.equal(h.captures[1]!.stopped, true);
});
