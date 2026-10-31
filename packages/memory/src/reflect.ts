/** Pure correction/preference detection for Reflect. Kept free of storage and
 * host services so the authorship and injection rules are testable alone.
 *
 * Only text a person typed counts. Assistant output, tool results, pasted
 * code/quotes, hidden resume prompts, command expansions, delegated-child
 * prompts and imported history are data, never a source of rules. */
import { sanitizeHarvestText } from "./extraction.ts";

export type ReflectSignal = "always" | "never" | "correction" | "preference";

export interface ReflectDetection {
  signal: ReflectSignal;
  /** The single sentence the user wrote, bounded and redacted. */
  rule: string;
}

export interface ReflectSourceEvent {
  id?: string;
  seq: number;
  type: string;
  data: unknown;
}

export interface ReflectSessionShape {
  parentId?: string;
  historyImport?: unknown;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const REFLECT_RULE_MAX = 280;
const MAX_RULES_PER_MESSAGE = 3;

/** A delegated child's prompts are written by its parent agent and imported
 * sessions replay another tool's transcript; neither is user authority. */
export function reflectSessionEligible(session: ReflectSessionShape): boolean {
  return !session.parentId && session.historyImport === undefined;
}

/** Returns the text the person authored, or undefined when the event is not a
 * user-authored message Reflect may learn from. */
export function userAuthoredText(event: ReflectSourceEvent): string | undefined {
  if (event.type !== "user/message") return undefined;
  const data = object(event.data);
  if (data.hiddenUserMessage === true || data.autoResume === true || data.githubConflictResolution === true) return undefined;
  if (object(data.memory).remember === "off") return undefined;
  // A slash command expands a template into `text`; only `raw` is typed.
  if (typeof data.raw === "string") return data.raw;
  if (data.command !== undefined) return undefined;
  return typeof data.text === "string" ? data.text : undefined;
}

/** Remove material the user pasted rather than wrote: fenced/indented code,
 * quoted replies and inline code spans. */
export function stripPastedContent(value: string): string {
  return value
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line) && !/^(?: {4}|\t)/.test(line))
    .join("\n")
    .replace(/`[^`\n]*`/g, (span) => span.length <= 48 ? span : " ");
}

// Ordered: the first matching rule names the signal.
const patterns: Array<{ signal: ReflectSignal; pattern: RegExp }> = [
  { signal: "never", pattern: /^(?:please\s+)?(?:never|don'?t\s+ever|do\s+not\s+ever|stop\s+(?:using|doing|adding|writing|running)|avoid)\b/i },
  // `\b` is ASCII-only in JS; Cyrillic keywords use an explicit end guard.
  { signal: "never", pattern: /^(?:ніколи|перестань)(?=[\s,.:;!]|$)/iu },
  { signal: "always", pattern: /^(?:please\s+)?(?:always|from\s+now\s+on|going\s+forward|remember\s+(?:to|that)|make\s+sure\s+(?:to|you)\s+always)\b/i },
  { signal: "always", pattern: /^(?:завжди|відтепер|надалі|запам['’]?ятай)(?=[\s,.:;!]|$)/iu },
  { signal: "correction", pattern: /^(?:no|nope|wrong|not\s+like\s+that)[,.:;!-]+\s*(?!thanks|thank\b|problem|worries|need\b)\S.{6,}/i },
  { signal: "correction", pattern: /\binstead\s+of\b|\b(?:use|do|write|call)\b[^.!?\n]{1,80}\binstead\b/i },
  { signal: "correction", pattern: /^(?:ні|неправильно)[,.:;!-]+\s*(?!дякую)\S.{6,}|(?:^|\s)замість\s/iu },
  { signal: "preference", pattern: /^(?:i|we)\s+(?:prefer|always\s+use|never\s+use|want\s+you\s+to\s+(?:always|never))\b/i },
  { signal: "preference", pattern: /^(?:я|ми)\s+(?:віддаю\s+перевагу|завжди\s+використовуємо|надаю\s+перевагу)(?=[\s,.:;!]|$)/iu },
];

// Conversational lead-ins that answer the agent rather than state the rule
// ("No, never run…", "Yes, always…", "Ні, використовуй…"). Repeated
// ("No, no, …") and only when punctuated, so "No tests in CI" is untouched.
const LEAD_IN = /^(?:no|nope|nah|yes|yeah|yep|ok(?:ay)?|right|well|actually|wait|hmm+|ні|так|добре|ок|ну|стоп)\s*[,.:;!—–-]+\s*/iu;

/** The sentence without conversational lead-ins, first letter capitalised. */
export function stripLeadIn(sentence: string): string {
  let body = sentence;
  for (let next = body.replace(LEAD_IN, ""); next !== body; next = body.replace(LEAD_IN, "")) body = next;
  return body === sentence || !body ? sentence : body.charAt(0).toLocaleUpperCase() + body.slice(1);
}

const sentences = (value: string): string[] =>
  value.split(/(?<=[.!?])\s+|\n+/u).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);

/** Normalize a rule for dedupe across sessions and repeated phrasing. */
export function ruleKey(rule: string): string {
  return stripLeadIn(rule).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** One-line, bounded, redacted rule text safe to show, store and append to an
 * instruction file. Undefined when it carries an injection phrase or URL. */
export function sanitizeRule(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").replace(/^[#>*\-\s]+/, "").trim();
  if (!line) return undefined;
  const clean = sanitizeHarvestText(line);
  if (!clean || clean.length > REFLECT_RULE_MAX) return undefined;
  return clean;
}

export function detectCorrections(text: string): ReflectDetection[] {
  const out: ReflectDetection[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(stripPastedContent(text))) {
    // Questions ask for information; they do not state a rule.
    if (sentence.endsWith("?") || sentence.length < 8) continue;
    // Classify the stated rule first ("No, never X" is a never-rule); the
    // whole sentence still counts for "No, use X" style corrections.
    const body = stripLeadIn(sentence);
    if (body.length < 8) continue;
    const match = patterns.find((entry) => entry.pattern.test(body)) ?? patterns.find((entry) => entry.pattern.test(sentence));
    if (!match) continue;
    const rule = sanitizeRule(body);
    if (!rule) continue;
    const key = ruleKey(rule);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ signal: match.signal, rule });
    if (out.length >= MAX_RULES_PER_MESSAGE) break;
  }
  return out;
}
