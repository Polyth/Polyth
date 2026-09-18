// Explicit small-model helpers shared by composer suggestion, prompt rewrite,
// chat→note distillation, and task briefing. Passive idle recap is owned by
// the optional @polyth/recap package.
import type { SessionEvent } from "@polyth/contracts";
import {
  recentCompletedConversationContext,
  renderConversationContext,
  type ConversationExchange,
} from "@polyth/session/next-action";

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
