// The report contract: how a run tells the person what it amounts to. The
// last `Report:` line of the run's final message carries a signal and a
// headline; `Remember:` lines are durable notes the agent keeps in its
// notebook. Pure and browser-safe: the server parses settled runs with it and
// the editor's preview shows the same instructions the agent receives.

/** quiet: nothing worth the person's time (filed silently); update: worth
 *  reading; alert: needs the person's attention soon. */
export type AgentSignal = "quiet" | "update" | "alert";

export const AGENT_SIGNALS: readonly AgentSignal[] = ["quiet", "update", "alert"];

/** Who hears about a finished run: only alerts (default), every update, nobody. */
export type AgentNotifyPolicy = "alerts" | "updates" | "off";

/** Something only the person can do: a decision, a review, a sign-in. */
export interface AgentNeed {
  text: string;
  /** Why, or what to do. */
  detail?: string;
  /** Where to do it (http/https only). */
  url?: string;
}

export interface AgentReport {
  /** Absent when the message carries no Report line. */
  signal?: AgentSignal;
  headline?: string;
  /** The message without its Report, Remember and Needs you lines. */
  body: string;
  /** Durable notes, in the order written. */
  remember: string[];
  /** What waits for the person, in the order written. */
  needs: AgentNeed[];
}

export const HEADLINE_LIMIT = 160;
export const REMEMBER_LINE_LIMIT = 300;
export const REMEMBER_PER_RUN = 5;
export const NEED_TEXT_LIMIT = 120;
export const NEED_DETAIL_LIMIT = 240;
export const NEEDS_PER_RUN = 3;
const URL_LIMIT = 500;
/** The notebook a person and an agent share; every run reads it. */
export const NOTEBOOK_LIMIT = 6_000;

// Markdown decoration a model may wrap around the keyword: "**Report:** …",
// "> Report: …", "- Report: …".
const DECOR = "[\\s>*_`~-]*";
const REPORT_LINE = new RegExp(`^${DECOR}report${DECOR}:${DECOR}(quiet|update|alert)\\b${DECOR}(?:[—–:|·-]+\\s*)?(.*)$`, "i");
const REMEMBER_LINE = new RegExp(`^${DECOR}remember${DECOR}:${DECOR}(.+)$`, "i");
const NEEDS_LINE = new RegExp(`^${DECOR}needs[ \\t]+you${DECOR}:${DECOR}(.+)$`, "i");
const FENCE = /^\s*(```|~~~)/;
const LINK = /<?\bhttps?:\/\/[^\s<>()]+>?/i;

const clean = (text: string, limit: number): string => {
  const plain = text.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
};

/** "<what> — <why> — <link>": the link may stand anywhere, or be a
 *  Markdown link around the words. */
function parseNeed(raw: string): AgentNeed | undefined {
  let text = raw;
  let url: string | undefined;
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i.exec(text);
  if (markdown) {
    url = markdown[2];
    text = text.replace(markdown[0], markdown[1]!);
  } else {
    const found = LINK.exec(text);
    if (found) {
      url = found[0].replace(/^<|>$/g, "").replace(/[.,;:]+$/, "");
      text = text.replace(found[0], "");
    }
  }
  const parts = text.split(/\s+[—–]\s+|\s+-\s+/).map((part) => part.trim()).filter((part) => part && !/^[—–:|·-]+$/.test(part));
  const what = clean(parts[0] ?? "", NEED_TEXT_LIMIT);
  if (!what) return undefined;
  const detail = clean(parts.slice(1).join(" — "), NEED_DETAIL_LIMIT);
  return {
    text: what,
    ...(detail ? { detail } : {}),
    ...(url && url.length <= URL_LIMIT ? { url } : {}),
  };
}

/** Split a run's final message into its report parts. Lines inside code
 *  fences are content, never protocol. */
export function parseAgentReport(text: string | undefined): AgentReport {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  let fenced = false;
  let reportAt = -1;
  let signal: AgentSignal | undefined;
  let headline: string | undefined;
  const protocolAt = new Set<number>();
  const remember: string[] = [];
  const needs: AgentNeed[] = [];
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const report = REPORT_LINE.exec(line);
    if (report) {
      // The last Report line wins: a model may quote the format earlier.
      reportAt = index;
      signal = report[1]!.toLowerCase() as AgentSignal;
      const rest = clean(report[2] ?? "", HEADLINE_LIMIT);
      headline = rest || undefined;
      return;
    }
    const note = REMEMBER_LINE.exec(line);
    if (note) {
      protocolAt.add(index);
      const value = clean(note[1]!, REMEMBER_LINE_LIMIT);
      if (value && remember.length < REMEMBER_PER_RUN && !remember.includes(value)) remember.push(value);
      return;
    }
    const need = NEEDS_LINE.exec(line);
    if (need) {
      protocolAt.add(index);
      const value = parseNeed(need[1]!);
      if (value && needs.length < NEEDS_PER_RUN && !needs.some((known) => known.text === value.text)) needs.push(value);
    }
  });
  const body = lines
    .filter((_, index) => index !== reportAt && !protocolAt.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    ...(signal ? { signal } : {}),
    ...(headline ? { headline } : {}),
    body,
    remember,
    needs,
  };
}

/** First meaningful line of a body, as a headline when the agent gave none. */
export function headlineFrom(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const value = clean(line.replace(/^#+\s*/, "").replace(/^[-*]\s+/, ""), HEADLINE_LIMIT);
    if (value) return value;
  }
  return undefined;
}

/** Append notes to a notebook. Already-known notes are skipped; when the
 *  notebook would overflow, the oldest bullet notes go first (a person's
 *  prose and headings are never dropped). Returns the notes actually added. */
export function appendToNotebook(
  notebook: string | undefined,
  notes: readonly string[],
  limit = NOTEBOOK_LIMIT,
): { notebook: string; added: string[] } {
  let text = (notebook ?? "").replace(/\r\n/g, "\n").trimEnd();
  const known = text.toLocaleLowerCase();
  const added = notes.filter((note, index) => note.trim() && notes.indexOf(note) === index && !known.includes(note.toLocaleLowerCase()));
  if (!added.length) return { notebook: text, added: [] };
  const lines = text ? text.split("\n") : [];
  lines.push(...added.map((note) => `- ${note}`));
  while (lines.join("\n").length > limit) {
    const oldest = lines.findIndex((line) => /^\s*[-*]\s+/.test(line));
    if (oldest < 0 || oldest >= lines.length - added.length) break;
    lines.splice(oldest, 1);
  }
  text = lines.join("\n");
  if (text.length > limit) {
    // Only the new notes themselves are left to give way.
    return { notebook: (notebook ?? "").slice(0, limit), added: [] };
  }
  return { notebook: text, added };
}

/** The protocol, as the agent reads it at the end of a new session's prompt. */
export const REPORT_INSTRUCTIONS = [
  "Finish your final message with one line:",
  "Report: quiet|update|alert — <headline, under 12 words>",
  "The headline is shown above your message, so do not open the message by restating it: start with what follows from it.",
  "- quiet: nothing new that deserves the user's time; the run is filed silently.",
  "- update: a result worth reading.",
  "- alert: something needs the user's attention soon.",
  "For anything only the user can do (a decision, a review, a sign-in), add a line \"Needs you: <what> — <why or what to do> — <link>\" (the link is optional). It is shown as a to-do under your report.",
  "If you start background work and end your turn to wait for it, leave out the Report line until the final message: a message without it while that work runs is not your report.",
  "For anything later runs should know (a preference, a decision, a state to track), add a line \"Remember: <note>\". Keep notes short; they go into your notebook.",
].join("\n");

/** The same protocol, as a reminder in a continuing session. */
export const REPORT_REMINDER =
  "Finish with \"Report: quiet|update|alert — <headline>\" (shown above your message: do not restate it there; only in your final message, not while background work you wait for runs); add \"Remember: <note>\" lines for anything later runs should know and \"Needs you: <what> — <why> — <link>\" lines for what only the user can do.";
