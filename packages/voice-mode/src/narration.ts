// Turns the canonical events of one agent turn into spoken asides: short
// remarks about what the agent is doing (tool calls) and what it is thinking
// (streamed reasoning). Asides are lower priority than the reply: the
// controller drops any that still wait when the reply or the user speaks, and
// the speech queue skips one that waited too long. This module only decides
// *what* to say and *when* it is due; it never touches audio.
//
// Cadence "key" groups the steps of a short window into one remark and keeps
// a gap between remarks; "every" says each step as it starts. Failures are
// said at once either way. Reasoning that only arrives with the final message
// (harnesses that never stream it) is never read: it would delay the reply.
import { createSpeakableStream, type SpeakableStream } from "@polyth/dictation";
import type { ToolActivityDescription, ToolActivityKind } from "@polyth/web-sdk";
import type { NarrationPhrases } from "./narrationPhrases.ts";
import type { VoiceNarrationCadence, VoiceThoughts } from "./prefs.ts";
import type { TrackedEvent } from "./replyTracker.ts";

export interface NarrationCue {
  kind: "actions" | "thought";
  text: string;
  /** Said now, ahead of the cadence (a failed step). */
  urgent: boolean;
  /** When the cue was made (ms since epoch); it goes stale after a while. */
  at: number;
  /** The slice of canonical history it speaks about: after `fromSeq`, up to
   *  and including `toSeq` (what the small-model narrator reads). */
  fromSeq: number;
  toSeq: number;
}

export interface NarrationSettings {
  thoughts: VoiceThoughts;
  actions: boolean;
  cadence: VoiceNarrationCadence;
}

export type DescribeTool = (tool: string, input: Readonly<Record<string, unknown>>) => ToolActivityDescription;

export interface NarrationTrackerOptions {
  describe: DescribeTool;
  phrases(): NarrationPhrases;
  settings(): NarrationSettings;
  now(): number;
}

export interface NarrationTracker {
  /** Cues to say now for this event (urgent ones, every-step ones, streamed thoughts). */
  accept(event: TrackedEvent): NarrationCue[];
  /** The grouped cue whose window has ended by now, if any. */
  due(): NarrationCue[];
  /** When `due()` next has something (ms since epoch), or null. */
  nextDueAt(): number | null;
  /** Forget what waits to be said (the reply or the user is speaking). */
  dropPending(): void;
  /** A new turn, or the turn ended. */
  reset(): void;
}

/** Steps that start within this window are said as one remark. */
export const NARRATION_GROUP_MS = 3_000;
/** At least this long between grouped remarks ("key" cadence). */
export const NARRATION_GAP_MS = 12_000;
/** A brief thought longer than this is cut at a word. */
const BRIEF_MAX_CHARS = 160;
/** At most this many kinds of step in one grouped remark (the latest ones). */
const KINDS_PER_REMARK = 2;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (data: unknown, key: string): string => {
  const value = record(data)[key];
  return typeof value === "string" ? value : "";
};

/** Without the host's classifier every step is a plain tool use. */
export function fallbackDescribe(tool: string): ToolActivityDescription {
  const name = tool.replace(/^mcp__/, "").replace(/[-_]+/g, " ").trim();
  return name && name.length <= 30 ? { kind: "tool", target: name } : { kind: "tool" };
}

const TARGET_PHRASE: Partial<Record<ToolActivityKind, [keyof NarrationPhrases, keyof NarrationPhrases]>> = {
  read: ["read", "readBare"],
  edit: ["edit", "editBare"],
  write: ["write", "writeBare"],
  create: ["write", "writeBare"],
  delete: ["delete", "deleteBare"],
  search: ["search", "searchBare"],
  web: ["web", "webBare"],
  mcp: ["mcp", "mcpBare"],
  shell: ["shell", "shellBare"],
  tool: ["tool", "toolBare"],
};

const BARE_PHRASE: Partial<Record<ToolActivityKind, keyof NarrationPhrases>> = {
  move: "move",
  browser: "browser",
  test: "test",
  git: "git",
  subagent: "subagent",
  plan: "plan",
};

/** One step in words: "Reading config.ts". `several` uses the bare form. */
export function actionPhrase(description: ToolActivityDescription, phrases: NarrationPhrases, several = false): string {
  const bare = BARE_PHRASE[description.kind];
  if (bare) return phrases[bare];
  const [withTarget, withoutTarget] = TARGET_PHRASE[description.kind] ?? TARGET_PHRASE.tool!;
  const target = description.target?.trim();
  return target && !several ? phrases[withTarget].replace("{target}", target) : phrases[withoutTarget];
}

const sentence = (phrase: string, period: string): string =>
  /[.!?。！？…]$/.test(phrase) ? phrase : `${phrase}${period}`;

/** Markdown emphasis, code ticks and links reduced to their words. */
function plain(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*|__(.+?)__)\s*:?\s*$/;

/** Headline lines of a reasoning text ("**Planning the fix**", "## Plan"),
 *  counting the last line only when the text is complete. */
export function thoughtHeadlines(reasoning: string, complete: boolean): string[] {
  const lines = reasoning.split(/\r?\n/);
  if (!complete) lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    const match = HEADING.exec(line);
    const value = match ? plain(match[1] ?? match[2] ?? match[3] ?? "") : "";
    if (value) out.push(value);
  }
  return out;
}

/** The first sentence of a reasoning text, once it is complete (or the text
 *  ran long without one); null while it is still arriving. */
export function firstThoughtSentence(reasoning: string, complete: boolean): string | null {
  const flat = plain(reasoning.replace(/```[\s\S]*?(?:```|$)/g, " "));
  if (!flat) return null;
  const match = /^(.+?[.!?。！？])(?:\s|$)/u.exec(flat);
  if (match && (match[1]!.length <= BRIEF_MAX_CHARS)) return match[1]!;
  if (!match && !complete && flat.length <= BRIEF_MAX_CHARS) return null;
  if (flat.length <= BRIEF_MAX_CHARS) return flat;
  const cut = flat.slice(0, BRIEF_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
}

interface ThoughtPart {
  raw: string;
  firstSeq: number;
  headlines: number;
  sentenceSaid: boolean;
  stream: SpeakableStream | null;
  closed: boolean;
}

interface PendingStep {
  description: ToolActivityDescription;
  at: number;
  seq: number;
}

export function createNarrationTracker(options: NarrationTrackerOptions): NarrationTracker {
  let parts = new Map<string, ThoughtPart>();
  let steps: PendingStep[] = [];
  let thought: { text: string; at: number; fromSeq: number; toSeq: number } | null = null;
  let dueAt: number | null = null;
  let lastRemarkAt = Number.NEGATIVE_INFINITY;
  let seenCalls = new Set<string>();

  const cue = (kind: NarrationCue["kind"], value: string, range: { fromSeq: number; toSeq: number }, urgent = false): NarrationCue =>
    ({ kind, text: value, urgent, at: options.now(), fromSeq: range.fromSeq, toSeq: range.toSeq });

  const clearPending = () => {
    steps = [];
    thought = null;
    dueAt = null;
  };

  const reset = () => {
    parts = new Map();
    seenCalls = new Set();
    clearPending();
  };

  /** Key cadence: open a window unless one is already waiting. */
  const schedule = () => {
    if (dueAt !== null) return;
    dueAt = Math.max(options.now() + NARRATION_GROUP_MS, lastRemarkAt + NARRATION_GAP_MS);
  };

  const remark = (cues: NarrationCue[]): NarrationCue[] => {
    if (cues.length) lastRemarkAt = options.now();
    return cues;
  };

  /** The waiting steps as one remark: the latest kinds, in order. */
  const stepsRemark = (list: readonly PendingStep[]): string => {
    const phrases = options.phrases();
    const kinds: ToolActivityKind[] = [];
    for (const step of [...list].reverse()) {
      if (!kinds.includes(step.description.kind)) kinds.unshift(step.description.kind);
      if (kinds.length === KINDS_PER_REMARK) break;
    }
    return kinds.map((kind) => {
      const ofKind = list.filter((step) => step.description.kind === kind);
      const latest = ofKind.at(-1)!.description;
      const several = new Set(ofKind.map((step) => step.description.target ?? "")).size > 1;
      return sentence(actionPhrase(latest, phrases, several), phrases.period);
    }).join(" ");
  };

  const part = (id: string, seq: number): ThoughtPart => {
    let existing = parts.get(id);
    if (!existing) {
      existing = { raw: "", firstSeq: seq, headlines: 0, sentenceSaid: false, stream: null, closed: false };
      parts.set(id, existing);
    }
    return existing;
  };

  /** Brief thoughts: each new headline, or the first sentence of a part. */
  const briefThoughts = (current: ThoughtPart, complete: boolean): string[] => {
    const out: string[] = [];
    const headlines = thoughtHeadlines(current.raw, complete);
    if (headlines.length > current.headlines) {
      out.push(...headlines.slice(current.headlines));
      current.headlines = headlines.length;
      current.sentenceSaid = true;
      return out;
    }
    if (current.sentenceSaid || HEADING.test(current.raw.split(/\r?\n/)[0] ?? "")) return out;
    const first = firstThoughtSentence(current.raw, complete);
    if (first) {
      current.sentenceSaid = true;
      out.push(first);
    }
    return out;
  };

  const thoughtCues = (values: string[], settings: NarrationSettings, range: { fromSeq: number; toSeq: number }): NarrationCue[] => {
    if (!values.length) return [];
    if (settings.thoughts === "full") return values.map((value) => cue("thought", value, range));
    if (settings.cadence === "every") return remark(values.map((value) => cue("thought", value, range)));
    thought = { text: values.at(-1)!, at: options.now(), ...range };
    schedule();
    return [];
  };

  /** A part ends when the agent moves on (a tool, the reply, the turn's end). */
  const closeParts = (settings: NarrationSettings, seq: number): NarrationCue[] => {
    const cues: NarrationCue[] = [];
    for (const current of parts.values()) {
      if (current.closed) continue;
      current.closed = true;
      const said = settings.thoughts === "full" ? current.stream?.flush() ?? []
        : settings.thoughts === "brief" ? briefThoughts(current, true) : [];
      cues.push(...thoughtCues(said, settings, { fromSeq: current.firstSeq - 1, toSeq: seq - 1 }));
    }
    return cues;
  };

  return {
    accept(event) {
      const settings = options.settings();
      switch (event.type) {
        case "turn/started":
          reset();
          return [];
        case "assistant/reasoning-chunk": {
          if (settings.thoughts === "off") return [];
          const current = part(text(event.data, "partId"), event.seq);
          if (current.closed) return [];
          const delta = text(event.data, "text");
          current.raw += delta;
          const range = { fromSeq: current.firstSeq - 1, toSeq: event.seq };
          if (settings.thoughts === "full") {
            current.stream ??= createSpeakableStream({ minChars: 60, maxChars: 220 });
            return thoughtCues(current.stream.push(delta), settings, range);
          }
          return thoughtCues(briefThoughts(current, false), settings, range);
        }
        case "assistant/chunk":
        case "assistant/message":
          // The reply is about to be spoken: nothing waiting is said now.
          for (const current of parts.values()) current.closed = true;
          clearPending();
          return [];
        case "tool/call":
        case "tool/started": {
          const said = settings.thoughts === "off" ? [] : closeParts(settings, event.seq);
          if (!settings.actions) return said;
          const callId = text(event.data, "callId");
          if (callId && seenCalls.has(callId)) return said;
          if (callId) seenCalls.add(callId);
          const description = options.describe(text(event.data, "tool"), record(record(event.data).input));
          if (settings.cadence === "every") {
            const phrases = options.phrases();
            const range = { fromSeq: event.seq - 1, toSeq: event.seq };
            return [...said, ...remark([cue("actions", sentence(actionPhrase(description, phrases), phrases.period), range)])];
          }
          steps.push({ description, at: options.now(), seq: event.seq });
          schedule();
          return said;
        }
        case "tool/error": {
          if (!settings.actions) return [];
          const phrases = options.phrases();
          const description = options.describe(text(event.data, "tool"), record(record(event.data).input));
          // Whatever waited is over: the failure is the news.
          clearPending();
          const range = { fromSeq: event.seq - 1, toSeq: event.seq };
          return remark([cue("actions", description.kind === "test" ? phrases.testsFailed : phrases.stepFailed, range, true)]);
        }
        case "turn/stopped":
          reset();
          return [];
        default:
          return [];
      }
    },
    due() {
      if (dueAt === null || options.now() < dueAt) return [];
      const lastStep = steps.at(-1);
      // One remark per window: the newer of what was thought and what was done.
      const value = thought && (!lastStep || thought.at >= lastStep.at)
        ? cue("thought", thought.text, thought)
        : lastStep ? cue("actions", stepsRemark(steps), { fromSeq: steps[0]!.seq - 1, toSeq: lastStep.seq }) : null;
      clearPending();
      return value ? remark([value]) : [];
    },
    nextDueAt: () => dueAt,
    dropPending: clearPending,
    reset,
  };
}
