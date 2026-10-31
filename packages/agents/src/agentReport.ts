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

export interface AgentReport {
  /** Absent when the message carries no Report line. */
  signal?: AgentSignal;
  headline?: string;
  /** The message without its Report and Remember lines. */
  body: string;
  /** Durable notes, in the order written. */
  remember: string[];
}

export const HEADLINE_LIMIT = 160;
export const REMEMBER_LINE_LIMIT = 300;
export const REMEMBER_PER_RUN = 5;
/** The notebook a person and an agent share; every run reads it. */
export const NOTEBOOK_LIMIT = 6_000;

// Markdown decoration a model may wrap around the keyword: "**Report:** …",
// "> Report: …", "- Report: …".
const DECOR = "[\\s>*_`~-]*";
const REPORT_LINE = new RegExp(`^${DECOR}report${DECOR}:${DECOR}(quiet|update|alert)\\b${DECOR}(?:[—–:|·-]+\\s*)?(.*)$`, "i");
const REMEMBER_LINE = new RegExp(`^${DECOR}remember${DECOR}:${DECOR}(.+)$`, "i");
const FENCE = /^\s*(```|~~~)/;

const clean = (text: string, limit: number): string => {
  const plain = text.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
};

/** Split a run's final message into its report parts. Lines inside code
 *  fences are content, never protocol. */
export function parseAgentReport(text: string | undefined): AgentReport {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  let fenced = false;
  let reportAt = -1;
  let signal: AgentSignal | undefined;
  let headline: string | undefined;
  const rememberAt = new Set<number>();
  const remember: string[] = [];
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
      rememberAt.add(index);
      const value = clean(note[1]!, REMEMBER_LINE_LIMIT);
      if (value && remember.length < REMEMBER_PER_RUN && !remember.includes(value)) remember.push(value);
    }
  });
  const body = lines
    .filter((_, index) => index !== reportAt && !rememberAt.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    ...(signal ? { signal } : {}),
    ...(headline ? { headline } : {}),
    body,
    remember,
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
  "- quiet: nothing new that deserves the user's time; the run is filed silently.",
  "- update: a result worth reading.",
  "- alert: something needs the user's attention soon.",
  "For anything later runs should know (a preference, a decision, a state to track), add a line \"Remember: <note>\". Keep notes short; they go into your notebook.",
].join("\n");

/** The same protocol, as a reminder in a continuing session. */
export const REPORT_REMINDER =
  "Finish with \"Report: quiet|update|alert — <headline>\"; add \"Remember: <note>\" lines for anything later runs should know.";
