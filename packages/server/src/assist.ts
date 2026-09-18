// F9 small-model idle assist: after a turn completes and the session stays
// quiet, generate a <=20-word recap and ONE suggested follow-up. Passive
// post-turn telemetry/metadata is allowed to settle during the quiet window;
// conversation activity cancels it. The saved result is then keyed to the
// actual log tail (never the event log itself), so any later event makes the
// visible assist stale. Hard settings switch: disabled means nothing is
// generated at all. One flight per session bounds token spend.
import type { SessionAssist } from "@polyth/contracts";
import {
  recentCompletedConversationContext,
  renderConversationContext,
  type ConversationExchange,
} from "@polyth/session/next-action";
import type { SessionEvent } from "@polyth/contracts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";

export interface AssistSettings {
  enabled: boolean;
  /** Quiet time after turn/stopped before a recap is generated. */
  idleSeconds: number;
}

const DEFAULT_ASSIST_SETTINGS: AssistSettings = { enabled: false, idleSeconds: 120 };
const MIN_IDLE_SECONDS = 10;
const MAX_IDLE_SECONDS = 3600;
export const RECAP_MAX_WORDS = 20;

export interface AssistSettingsService {
  get(): AssistSettings;
  put(patch: Record<string, unknown>): AssistSettings;
}

/** Token-spend switch persisted server-side: `data/assist.json`.
 *  Writes are atomic. A corrupt on-disk file is never overwritten with
 *  defaults on load — operate with in-memory defaults and leave the file
 *  untouched until a deliberate `put` succeeds. */
export function createAssistSettings(opts: { file: string }): AssistSettingsService {
  let current: AssistSettings = { ...DEFAULT_ASSIST_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Record<string, unknown>;
    current = sanitize(raw, current);
  } catch (err) {
    // Missing file = first run. Corrupt/unreadable: keep defaults in memory
    // and do NOT rewrite the file on load.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && existsSync(opts.file)) {
      console.warn("[polyth] assist.json is unreadable; starting with defaults (file left untouched)");
    }
  }

  function sanitize(patch: Record<string, unknown>, base: AssistSettings): AssistSettings {
    const next = { ...base };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.idleSeconds !== undefined) {
      const n = Number(patch.idleSeconds);
      if (!Number.isFinite(n)) throw Object.assign(new Error("idleSeconds must be a number"), { code: "invalid-input" });
      next.idleSeconds = Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(n)));
    }
    return next;
  }

  return {
    get: () => ({ ...current }),
    put: (patch) => {
      current = sanitize(patch, current);
      mkdirSync(dirname(opts.file), { recursive: true });
      atomicWriteSync(opts.file, JSON.stringify(current, null, 2));
      return { ...current };
    },
  };
}

// ------------------------------------------------------------- pure helpers

/** Hard cap on the recap length even if the model ignores the instruction. */
export function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/** An assist is fresh only while the log has not grown past the seq it was keyed to. */
export function isFresh(assist: { atSeq: number } | undefined, latestSeq: number): boolean {
  return !!assist && assist.atSeq === latestSeq;
}

const ASSIST_CONVERSATION_ACTIVITY_PREFIXES = [
  "user/",
  "assistant/",
  "turn/",
  "tool/",
  "permission/",
  "question/",
  "secret/",
  "queue/",
] as const;

/** Runtime telemetry and metadata may legitimately arrive just after
 * turn/stopped. Only real conversation/session activity should cancel the
 * pending quiet-window generation. */
export function isAssistConversationActivity(event: Pick<SessionEvent, "type">): boolean {
  return ASSIST_CONVERSATION_ACTIVITY_PREFIXES.some((prefix) => event.type.startsWith(prefix))
    || event.type === "session/rewound"
    || event.type === "session/rewind-cleared";
}

export function buildAssistPrompt(transcript: string): string {
  return [
    "You are reviewing a coding-assistant conversation that just went idle.",
    "Output EXACTLY two lines and nothing else:",
    `Recap: <what happened, at most ${RECAP_MAX_WORDS} words>`,
    "Suggestion: <ONE concrete next prompt the user could send, imperative, one sentence — or the single word none>",
    "",
    "Write `Suggestion: none` when the task is finished, the user closed the",
    "conversation, or nothing in the conversation grounds a next step. A recap",
    "with no suggestion is a complete and correct answer. Never invent work to",
    "fill the line: no \"add tests\" when the tests already passed, no",
    "\"implement it\" after it was implemented, no new requirements, no",
    "speculative cleanup, and no choice the user already made.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

/** A declined suggestion is structurally absent, never an empty call to
 *  action — the UI must be able to tell "nothing to suggest" from "the model
 *  produced an unusable line". */
const NO_SUGGESTION = /^(none|no suggestion|n\/a|-{1,2})\.?$/i;

/** Tolerant two-line parse; null when the model reply is unusable. A missing
 *  or explicitly declined suggestion still yields a usable recap. */
export function parseAssistReply(raw: string): { recap: string; suggestion?: string } | null {
  const lines = raw.replace(/^```[a-z]*\n?|```$/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  let recap = "";
  let suggestion = "";
  for (const line of lines) {
    const m = line.match(/^(recap|suggestion)\s*:\s*(.+)$/i);
    if (!m) continue;
    if (m[1]!.toLowerCase() === "recap" && !recap) recap = m[2]!.trim();
    else if (m[1]!.toLowerCase() === "suggestion" && !suggestion) suggestion = m[2]!.trim();
  }
  // fall back to "first two non-empty lines" for label-less replies
  if (!recap && !suggestion && lines.length >= 2) {
    recap = lines[0]!;
    suggestion = lines[1]!;
  }
  // A lone UNLABELLED line stays unusable: it is as likely to be a refusal or
  // a stray sentence as a recap. Only an explicit `Recap:` stands alone.
  if (!recap) return null;
  const capped = capWords(recap, RECAP_MAX_WORDS);
  return NO_SUGGESTION.test(suggestion) || !suggestion
    ? { recap: capped }
    : { recap: capped, suggestion };
}

export function buildNotePrompt(transcript: string): string {
  return [
    "Distill the coding-assistant conversation below into a project note.",
    "Line 1: a <=60 character title. Then a blank line, then a concise markdown",
    "body capturing decisions, changes made, and open items. No preamble.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

export function parseNoteReply(raw: string): { title: string; body: string } {
  const clean = raw.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const nl = clean.indexOf("\n");
  if (nl === -1) return { title: clean.slice(0, 60), body: "" };
  return { title: clean.slice(0, nl).trim().slice(0, 120), body: clean.slice(nl + 1).trim() };
}

// ------------------------------------------------------------- next action

const NEXT_ACTION_CONTEXT_MAX_CHARS = 12_000;
const NEXT_ACTION_OUTPUT_MAX_CHARS = 800;
export const PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS = 4_000;

const capChars = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max).trimEnd();

/** Plain-text prompt for the explicit composer action, over the recent
 *  completed exchanges rather than the last one alone — a closing "yes" or
 *  "looks good" must not erase the work it refers to. */
export function buildNextActionPrompt(context: readonly ConversationExchange[]): string {
  return [
    "You generate the single best next message the user could send to a coding agent.",
    "Based only on the recent conversation below, produce ONE immediately sendable next user message that moves the current task forward.",
    "The exchanges are ordered oldest to newest; the newest one is the user's current intent, and the earlier ones are there to explain what a short closing message refers to.",
    "",
    "Rules:",
    "- Return only the message itself.",
    "- No label such as \"Suggestion:\".",
    "- No explanation.",
    "- No markdown wrapper.",
    "- No alternatives.",
    "- Pick one best next action yourself.",
    "- Do not use \"or\" to make the user choose between actions.",
    "- Do not repeat a question whose answer is already present in the assistant response.",
    "- Do not ask to inspect implementation details merely for the sake of inspection.",
    "- Do not ask for exact code, file paths, or prompt locations if they were already provided.",
    "- Do not generate generic workflow requests such as \"Run tests\" unless testing is clearly the unresolved next step.",
    "- Prefer a concrete action: implement the proposed improvement; fix the identified problem; validate the latest change; improve the current approach; resolve a remaining issue; explain an important trade-off; or continue the task from the current result.",
    "- Do not invent facts, decisions, values, preferences, credentials, or requirements on behalf of the user.",
    "- Match the language of the latest conversation exchange.",
    "- Match the user's concise/direct tone where it can be inferred.",
    "- Keep the message concise but complete enough to send without editing.",
    "",
    "- Do not propose work that the conversation shows is already finished.",
    "",
    "If the task is complete, the user has closed the conversation, or no grounded next action exists, return an empty string. An empty answer is a correct answer; never invent a follow-up to fill the space.",
    "",
    "RECENT CONVERSATION:",
    capChars(renderConversationContext(context), NEXT_ACTION_CONTEXT_MAX_CHARS),
  ].join("\n");
}

/** Rewrite only the user's draft: this keeps input tokens (and cost) low and
 * prevents unrelated conversation details from changing the user's intent. */
export function buildPromptImprovementPrompt(draft: string): string {
  return [
    "Improve the user prompt below for a coding agent.",
    "Return only the rewritten prompt, ready to send.",
    "Preserve the user's intent, facts, language, and tone.",
    "Fix unclear wording, grammar, and structure. Make requirements and the desired outcome explicit when they are already implied.",
    "Do not invent requirements, technical details, decisions, credentials, or acceptance criteria.",
    "Do not answer the prompt, explain your changes, add a label, or wrap the result in markdown fences.",
    "Keep it concise; leave an already-effective prompt mostly unchanged.",
    "",
    "USER PROMPT:",
    capChars(draft.trim(), NEXT_ACTION_CONTEXT_MAX_CHARS),
  ].join("\n");
}

/** Be forgiving of common model adornments while keeping the result sendable. */
export function sanitizeNextActionReply(raw: string, maxChars = NEXT_ACTION_OUTPUT_MAX_CHARS): string {
  let text = raw.trim()
    .replace(/^```[^\n]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim()
    .replace(/^(?:suggestion|(?:improved\s+)?prompt|next(?:\s+(?:user\s+)?(?:message|action))?)\s*:\s*/i, "");
  const quoted = text.match(/^["“]([\s\S]*)["”]$/);
  if (quoted) text = quoted[1]!.trim();
  return capChars(text, maxChars);
}

export interface ManualSuggestionService {
  generate(sessionId: string, draft?: string, userId?: string): Promise<{ suggestion: string; atSeq: number }>;
}

/** One explicit, ephemeral request per session. This never writes the session log or projection. */
export function createManualSuggestionService(deps: {
  latestSeq(sessionId: string): Promise<number>;
  events(sessionId: string): Promise<SessionEvent[]>;
  complete(sessionId: string, prompt: string, userId?: string): Promise<string>;
}): ManualSuggestionService {
  const inFlight = new Set<string>();
  const fail = (code: "in-flight" | "stale" | "no-completed-exchange"): never => {
    throw Object.assign(new Error(code), { code });
  };

  return {
    async generate(sessionId, draft = "", userId) {
      if (inFlight.has(sessionId)) fail("in-flight");
      inFlight.add(sessionId);
      try {
        const atSeq = await deps.latestSeq(sessionId);
        let prompt: string;
        if (draft.trim()) {
          prompt = buildPromptImprovementPrompt(draft);
        } else {
          const context = recentCompletedConversationContext(await deps.events(sessionId));
          if (context.length === 0) throw Object.assign(new Error("no-completed-exchange"), { code: "no-completed-exchange" });
          prompt = buildNextActionPrompt(context);
        }
        if ((await deps.latestSeq(sessionId)) !== atSeq) fail("stale");
        const raw = await deps.complete(sessionId, prompt, userId);
        if ((await deps.latestSeq(sessionId)) !== atSeq) fail("stale");
        return {
          suggestion: sanitizeNextActionReply(raw, draft.trim() ? PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS : undefined),
          atSeq,
        };
      } finally {
        inFlight.delete(sessionId);
      }
    },
  };
}

// ------------------------------------------------------------- service

export interface AssistService {
  /** Called on every completed turn; schedules a debounced generation. */
  onTurnCompleted(sessionId: string): void;
  /** Cancel all pending timers (shutdown). */
  stop(): void;
}

export function createAssistService(deps: {
  settings: () => AssistSettings;
  latestSeq(sessionId: string): Promise<number>;
  /** Canonical events appended after the completed-turn tail. */
  eventsAfter(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
  transcript(sessionId: string): Promise<string>;
  /** One-shot small-model completion on the session's runtime. */
  complete(sessionId: string, prompt: string): Promise<string>;
  /** Persist onto the projection + broadcast (never the event log). */
  save(sessionId: string, assist: SessionAssist): Promise<void>;
  now?(): number;
  onError?(sessionId: string, err: unknown): void;
}): AssistService {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();

  const fire = async (sessionId: string, seqAtSchedule: number) => {
    timers.delete(sessionId);
    if (inFlight.has(sessionId)) return; // one flight per session
    if (!deps.settings().enabled) return; // switch may have flipped while waiting
    inFlight.add(sessionId);
    try {
      // Providers can append passive usage/title metadata after turn/stopped.
      // Let that settle without treating it as renewed conversation activity,
      // then anchor the generated assist to the real current log tail.
      const trailing = await deps.eventsAfter(sessionId, seqAtSchedule);
      if (trailing.some(isAssistConversationActivity)) return;
      const atSeq = trailing[trailing.length - 1]?.seq ?? seqAtSchedule;
      // Close the read race before spending tokens.
      if ((await deps.latestSeq(sessionId)) !== atSeq) return;
      const transcript = await deps.transcript(sessionId);
      if (!transcript.trim()) return;
      const parsed = parseAssistReply(await deps.complete(sessionId, buildAssistPrompt(transcript)));
      if (!parsed) return;
      // Once generation starts, any event wins over the slow model result.
      if ((await deps.latestSeq(sessionId)) !== atSeq) return;
      await deps.save(sessionId, { ...parsed, atSeq, generatedAt: now() });
    } catch (err) {
      deps.onError?.(sessionId, err);
    } finally {
      inFlight.delete(sessionId);
    }
  };

  return {
    onTurnCompleted(sessionId) {
      const s = deps.settings();
      if (!s.enabled) return; // hard switch: nothing scheduled at all
      const existing = timers.get(sessionId);
      if (existing) clearTimeout(existing);
      void deps.latestSeq(sessionId).then((seq) => {
        const t = setTimeout(() => void fire(sessionId, seq), s.idleSeconds * 1000);
        t.unref?.();
        timers.set(sessionId, t);
      }).catch((err: unknown) => deps.onError?.(sessionId, err));
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
