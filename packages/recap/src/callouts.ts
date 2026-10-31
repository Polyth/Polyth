// Key callouts: must-know items from a completed turn, always quoted from the
// assistant's own text. Pure and browser-safe (shared by the widget and server).
import type { SessionEvent } from "@polyth/contracts";

export const CALLOUT_KINDS = ["action", "risk", "failed-check", "unverified", "decision", "credential"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface Callout {
  /** Stable within a turn: `${seq}:${kind}:${index}`. */
  id: string;
  kind: CalloutKind;
  /** Verbatim text from the source message (whitespace-normalised). */
  quote: string;
  /** Seq of the assistant/message the quote came from. */
  seq: number;
  source: "heuristic" | "model";
}

export interface CalloutSource { seq: number; text: string }

const MAX_QUOTE = 240;
export const MAX_CALLOUTS = 8;
/** Most urgent first: the agent waiting on an answer, then what broke, then
 *  what the person has to do, then what is merely worth knowing. */
export const CALLOUT_ORDER: readonly CalloutKind[] = ["decision", "failed-check", "credential", "action", "unverified", "risk"];

const CHECK = String.raw`(?:tests?|builds?|lint|typecheck|type check|checks?|ci|compilation|suites?|e2e|assertions?)`;

// Ordered by priority: the first rule that matches a sentence and is not
// excused by its `skip` wins. `skip` drops the common false alarms (an expected
// failure in a mutation check, "no breaking changes", a polite sign-off), so a
// sentence it excuses can still match a later rule.
const RULES: ReadonlyArray<{ kind: CalloutKind; pattern: RegExp; skip?: RegExp }> = [
  {
    kind: "credential",
    pattern: /\b(api[ _-]?key|token|password|passphrase|secret|credential|log ?in|sign ?in|2fa|mfa|oauth|authori[sz]e)\b.*\b(need|require|must|set|provide|enter|add|missing|expired|invalid)|\b(need|require|must|set|provide|enter|add|missing|expired|invalid)\b.*\b(api[ _-]?key|token|password|passphrase|secret|credential|2fa|mfa|oauth)\b/i,
    skip: /\bno\s+(?:\w+\s+){0,2}(?:is\s+|are\s+)?(?:needed|required)\b|\b(?:not|isn't|aren't) (?:needed|required)\b/i,
  },
  {
    kind: "failed-check",
    pattern: new RegExp(String.raw`\b${CHECK}\b[^.\n]*\b(?:fail(?:ed|s|ing|ures?)?|broke(?:n)?|errored)\b|\b[1-9]\d*\s+(?:${CHECK}\s+)?(?:failed|failing|failures?)\b|\b(?:failed|failing) ${CHECK}\b`, "i"),
    // An expected or hypothetical failure, a zero count, or one already fixed.
    skip: /\b(?:should|would|will|must|to|can|could|might|may|expected to|supposed to|meant to)\s+(?:\w+ly\s+|now\s+|still\s+)?fail\b|\bfail(?:s|ed)? (?:as expected|without the fix|before the fix)\b|\b(?:mutation|red[- ]green|deliberately|intentionally|on purpose)\b|\b(?:no|zero|0|none of the|nothing)\s+(?:\w+\s+){0,2}(?:fail(?:ed|s|ing|ures?)?)\b|\b(?:fix(?:ed|es)?|resolved|addressed)\s+(?:the\s+|a\s+|\d+\s+)?(?:\w+\s+){0,2}(?:fail(?:ing|ed|ures?)|broken)\b|\bfail(?:ed|ing|s)?\b[^.\n]*\b(?:now|then)\b[^.\n]*\bpass/i,
  },
  {
    kind: "unverified",
    pattern: new RegExp(String.raw`\b(?:not (?:verified|tested)|unverified|untested|(?:did(?:n't| not)|could(?:n't| not)|wasn't able to|was not able to|unable to) (?:run|verify|test|be (?:run|verified|tested))\b[^.\n]*|${CHECK}\b[^.\n]*\b(?:skipped|not run)\b|\bskipped (?:the )?${CHECK}\b)`, "i"),
    skip: /\b(?:no|zero|0|none)\s+(?:\w+\s+){0,2}(?:were\s+|was\s+)?skipped\b/i,
  },
  {
    kind: "decision",
    pattern: /\b(which (?:one|option|approach|do you|would you)|do you (?:want|prefer)|would you (?:like|prefer)|want me to|should (?:i|we)|shall (?:i|we)|any preference|let me know|your (?:call|decision|choice)|need(?:s)? (?:your|a) (?:\w+ )?(?:decision|input|confirmation|approval)|please (?:confirm|choose|decide|approve)|decide (?:whether|between))\b/i,
    // A polite sign-off is not a question unless it names the options.
    skip: /\blet me know if (?:you(?:'d| would)? (?:like|want|need)|there(?:'s| is) anything|anything|you have (?:any )?questions)\b(?![^.?!]*\b(?:or|whether)\b)/i,
  },
  {
    kind: "action",
    pattern: /\b(you (?:need|must|have|will need|'ll need) to|you should|you'll want to|please (?:run|restart|install|update|set|add|review|check|delete|remove|rotate|re-?run)|remember to|make sure (?:you|to)|manual(?:ly)? (?:step|action|steps)|before (?:you )?(?:deploy|merge|ship|release|running))\b/i,
    // "you should now see…" describes the result; "If you need to…" is a how-to.
    skip: /\byou should (?:now |also )?(?:see|notice|get|find|be able|have)\b|^if you\b/i,
  },
  {
    kind: "risk",
    pattern: /^\W*(?:warning|caution|careful|danger|heads[- ]up|important)\b\s*[:!,-]|\b(breaking change|irreversible|cannot be undone|can't be undone|data loss|lose (?:data|work|changes)|destructive|insecure|vulnerab\w*|security (?:risk|issue|hole)|not safe|unsafe|may (?:break|lose|overwrite|delete|corrupt)|will (?:overwrite|delete|remove|drop|wipe|erase)|force[- ]push(?:ed|ing)?|backward[- ]incompatible)\b/i,
    // A zero count or a negation that governs the word ("finds 0
    // vulnerabilities", "never touches the vulnerable code") is an all-clear.
    skip: /\b(?:no|not|non|without|nothing|isn't|aren't|won't|doesn't)\b[^.\n]{0,24}\b(?:breaking|destructive|data loss|irreversible|unsafe|risky?)\b|\b(?:fix(?:ed|es)?|patched|resolved|closed)\b[^.\n]*\b(?:vulnerab|security|unsafe|insecure)|\b(?:no|zero|0|none of the|never|not|isn't|aren't|doesn't|don't|didn't|won't)\s+(?:[\w-]+\s+){0,2}vulnerab/i,
  },
];

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

/** Split into sentence-ish units; list items and lines stay whole. */
export function splitUnits(text: string): string[] {
  const units: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*>\s?/, "").replace(/^#{1,6}\s+/, "");
    // No lookbehind: a regex literal with one is a SyntaxError that fails the
    // whole package bundle on WebKit before 16.4 (older iPhones).
    for (const part of line.replace(/([.!?])\s+(?=[A-Z0-9`"'(*])/g, "$1\n").split("\n")) {
      const unit = norm(part.replace(/\*\*|__/g, ""));
      if (unit.length >= 12) units.push(unit);
    }
  }
  return units;
}

const clip = (unit: string) => (unit.length <= MAX_QUOTE ? unit : `${unit.slice(0, MAX_QUOTE - 1)}…`);

export function extractCalloutsFromText(source: CalloutSource): Callout[] {
  const out: Callout[] = [];
  for (const unit of splitUnits(source.text)) {
    const rule = RULES.find((candidate) => candidate.pattern.test(unit) && !candidate.skip?.test(unit));
    if (!rule) continue;
    out.push({ id: `${source.seq}:${rule.kind}:${out.length}`, kind: rule.kind, quote: clip(unit), seq: source.seq, source: "heuristic" });
  }
  return out;
}

/** Assistant text of the latest completed turn (after the last user message). */
export function latestTurnSources(events: readonly SessionEvent[]): CalloutSource[] {
  const lastUser = events.findLastIndex((event) => event.type === "user/message" && !event.ignorable);
  const tail = events.slice(lastUser + 1);
  if (!tail.some((event) => event.type === "turn/stopped" && (event.data as { reason?: unknown }).reason === "completed")) return [];
  const sources: CalloutSource[] = [];
  for (const event of tail) {
    if (event.type !== "assistant/message" || event.ignorable) continue;
    const text = (event.data as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) sources.push({ seq: event.seq, text });
  }
  return sources;
}

/** Prefer higher-severity kinds, keep the cap, preserve reading order within a kind. */
export function rankCallouts(callouts: readonly Callout[]): Callout[] {
  const seen = new Set<string>();
  const unique = callouts.filter((callout) => {
    const key = callout.quote.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = (callout: Callout) => CALLOUT_ORDER.indexOf(callout.kind);
  return unique.map((callout, index) => ({ callout, index }))
    .sort((a, b) => order(a.callout) - order(b.callout) || a.index - b.index)
    .slice(0, MAX_CALLOUTS)
    .map(({ callout }) => callout);
}

export function extractCallouts(events: readonly SessionEvent[]): { atSeq: number; callouts: Callout[] } {
  const sources = latestTurnSources(events);
  const atSeq = sources.at(-1)?.seq ?? 0;
  return { atSeq, callouts: rankCallouts(sources.flatMap(extractCalloutsFromText)) };
}

// ---- optional model pass -------------------------------------------------

export function buildCalloutPrompt(sources: readonly CalloutSource[]): string {
  const body = sources.map((source) => `[#${source.seq}]\n${source.text}`).join("\n\n").slice(-12_000);
  return [
    "You review one assistant turn and surface ONLY what the user must not miss:",
    "an action they must take, a risk or warning, a failed check, a check that",
    "was skipped or could not run (unverified), a decision needed from them,",
    "or a credential/manual step. Expected failures (a mutation check, a test",
    "written to fail first) and polite sign-offs do not qualify.",
    `Output at most ${MAX_CALLOUTS} lines, each exactly: <kind> | <message number> | <verbatim quote>`,
    `kind is one of: ${CALLOUT_KINDS.join(", ")}.`,
    "The quote MUST be copied word for word from that message (one sentence or line).",
    "Never paraphrase, summarise or add anything not written. Output `none` if nothing qualifies.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<turn>",
    body,
    "</turn>",
  ].join("\n");
}

/** Keep only items whose quote is verbatim in the cited message. */
export function parseCalloutReply(raw: string, sources: readonly CalloutSource[]): Callout[] {
  const bySeq = new Map(sources.map((source) => [source.seq, norm(source.text)]));
  const out: Callout[] = [];
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^([a-z-]+)\s*\|\s*#?(\d+)\s*\|\s*(.+)$/i);
    if (!match) continue;
    const kind = match[1]!.toLowerCase() as CalloutKind;
    const seq = Number(match[2]);
    const quote = norm(match[3]!.replace(/^["“'`]+|["”'`]+$/g, "").replace(/\*\*|__/g, ""));
    const text = bySeq.get(seq)?.replace(/\*\*|__/g, "");
    if (!CALLOUT_KINDS.includes(kind) || !text || quote.length < 8 || !text.includes(quote)) continue;
    out.push({ id: `${seq}:${kind}:m${out.length}`, kind, quote: clip(quote), seq, source: "model" });
  }
  return rankCallouts(out);
}

/** Merge model items over heuristic ones, deduping overlapping quotes. */
export function mergeCallouts(heuristic: readonly Callout[], model: readonly Callout[]): Callout[] {
  const covered = (a: string, b: string) => a.includes(b) || b.includes(a);
  const extra = model.filter((item) => !heuristic.some((h) => h.seq === item.seq && covered(h.quote.toLowerCase(), item.quote.toLowerCase())));
  return rankCallouts([...heuristic, ...extra]);
}
