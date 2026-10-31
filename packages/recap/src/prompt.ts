import type { SessionEvent } from "@polyth/contracts";
import {
  assistFreshnessSeq, isAssistConversationActivity, recentCompletedConversationContext, renderConversationContext,
  type ConversationExchange,
} from "@polyth/session/next-action";

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
  generate(
    sessionId: string,
    draft?: string,
    userId?: string,
    options?: { regenerate?: boolean },
  ): Promise<{ suggestion: string; atSeq: number }>;
  invalidate(): void;
}

const SHARED_SUGGESTIONS_MAX = 200;

/** Ephemeral prompt requests; this never writes the session log or projection.
 *
 * A next-action suggestion is keyed by the conversation it answers
 * (`assistFreshnessSeq`), so post-turn bookkeeping neither invalidates it nor
 * buys a second model call: concurrent requests for the same conversation —
 * another open client, a remount — share one flight and its answer, and only
 * an explicit `regenerate` asks the model again. A draft rewrite depends on the
 * draft alone and stays one flight per session. */
export function createManualSuggestionService(deps: {
  latestSeq(sessionId: string): Promise<number>;
  events(sessionId: string, afterSeq?: number): Promise<SessionEvent[]>;
  complete(sessionId: string, prompt: string, userId?: string): Promise<string>;
}): ManualSuggestionService {
  const inFlight = new Set<string>();
  const flights = new Map<string, Promise<{ suggestion: string; atSeq: number }>>();
  const answers = new Map<string, { suggestion: string; atSeq: number }>();
  let generation = 0;
  const fail: (code: "in-flight" | "stale" | "no-completed-exchange") => never = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const remember = (key: string, answer: { suggestion: string; atSeq: number }) => {
    answers.delete(key);
    answers.set(key, answer);
    while (answers.size > SHARED_SUGGESTIONS_MAX) answers.delete(answers.keys().next().value!);
  };

  const improve = async (sessionId: string, draft: string, userId: string | undefined) => {
    if (inFlight.has(sessionId)) fail("in-flight");
    inFlight.add(sessionId);
    const admittedGeneration = generation;
    try {
      const atSeq = await deps.latestSeq(sessionId);
      const raw = await deps.complete(sessionId, buildPromptImprovementPrompt(draft), userId);
      if (admittedGeneration !== generation) fail("stale");
      return { suggestion: sanitizeNextActionReply(raw, PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS), atSeq };
    } finally {
      inFlight.delete(sessionId);
    }
  };

  return {
    invalidate() {
      generation += 1;
      flights.clear();
      answers.clear();
    },
    async generate(sessionId, draft = "", userId, options) {
      if (draft.trim()) return improve(sessionId, draft, userId);
      const events = await deps.events(sessionId);
      const atSeq = assistFreshnessSeq(events);
      const key = `${sessionId}\0${atSeq}\0${userId ?? ""}`;
      const shared = flights.get(key);
      if (shared) return shared;
      const answered = answers.get(key);
      if (answered && !options?.regenerate) return answered;
      const context = recentCompletedConversationContext(events);
      if (context.length === 0) fail("no-completed-exchange");
      const admittedGeneration = generation;
      const flight = (async () => {
        const raw = await deps.complete(sessionId, buildNextActionPrompt(context), userId);
        const later = await deps.events(sessionId, atSeq);
        if (admittedGeneration !== generation || later.some(isAssistConversationActivity)) fail("stale");
        const answer = { suggestion: sanitizeNextActionReply(raw), atSeq };
        remember(key, answer);
        return answer;
      })();
      flights.set(key, flight);
      try {
        return await flight;
      } finally {
        if (flights.get(key) === flight) flights.delete(key);
      }
    },
  };
}
