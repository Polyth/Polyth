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
/** What the person said to a request: go ahead, or do not. */
export type NeedAnswer = "yes" | "no";

export interface AgentNeed {
  text: string;
  /** "decision": the agent waits for a yes or no and acts on it itself
   *  (`Needs your OK:`). Absent: something the person does themselves
   *  (`Needs you:`), which only they can call done. */
  kind?: "decision";
  /** Why, or what to do. */
  detail?: string;
  /** Where to do it (http/https only). */
  url?: string;
  /** Settled: the person marked it done or answered it (`answer`), or a
   *  later report of the agent said it no longer waits (`Resolved:`). */
  done?: { at: number; by: "user" | "agent"; answer?: NeedAnswer };
}

export interface AgentReport {
  /** Absent when the message carries no Report line. */
  signal?: AgentSignal;
  headline?: string;
  /** The message without its Report, Remember and Needs you / Needs your OK lines. */
  body: string;
  /** Durable notes, in the order written. */
  remember: string[];
  /** What waits for the person, in the order written. */
  needs: AgentNeed[];
  /** Earlier requests the agent says no longer wait, in the order written. */
  resolved: string[];
  /** What the person asked to have done at the agent's next wake rather than
   *  now, in the order written (`Next wake:` lines). */
  nextWake: string[];
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
// "Needs you: …" is the person's own to-do; "Needs your OK: …" asks for a yes
// or no the agent then acts on (group 1 says which).
const NEEDS_LINE = new RegExp(`^${DECOR}needs[ \\t]+you(r[ \\t]+(?:ok|okay|approval|decision))?${DECOR}:${DECOR}(.+)$`, "i");
const RESOLVED_LINE = new RegExp(`^${DECOR}resolved${DECOR}:${DECOR}(.+)$`, "i");
export const RESOLVED_PER_RUN = 6;
const NEXT_WAKE_LINE = new RegExp(`^${DECOR}next[ \\t]+wake${DECOR}:${DECOR}(.+)$`, "i");
export const NEXT_WAKE_LINE_LIMIT = 500;
export const NEXT_WAKE_PER_RUN = 3;
const FENCE = /^\s*(```|~~~)/;
const LINK = /<?\bhttps?:\/\/[^\s<>()]+>?/i;

const clean = (text: string, limit: number): string => {
  const plain = text.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= limit) return plain;
  // Cut between words, and never leave an operator or a dash hanging
  // ("… to parentId ===…").
  const cut = plain.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  const words = space >= limit * 0.7 ? cut.slice(0, space) : cut;
  return `${words.replace(/[\s,;:=<>!&|+([{–—-]+$/u, "") || words.trimEnd()}…`;
};

/** "<what> — <why> — <link>": the link may stand anywhere, or be a
 *  Markdown link around the words. */
function parseNeed(raw: string, decision = false): AgentNeed | undefined {
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
    ...(decision ? { kind: "decision" as const } : {}),
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
  const resolved: string[] = [];
  const nextWake: string[] = [];
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
      const value = parseNeed(need[2]!, Boolean(need[1]));
      if (value && needs.length < NEEDS_PER_RUN && !needs.some((known) => known.text === value.text)) needs.push(value);
      return;
    }
    const settled = RESOLVED_LINE.exec(line);
    if (settled) {
      protocolAt.add(index);
      // Only the request's own words: a reason after a dash is commentary.
      const value = clean(settled[1]!.split(/\s+[—–]\s+/)[0] ?? "", NEED_TEXT_LIMIT);
      if (value && resolved.length < RESOLVED_PER_RUN && !resolved.includes(value)) resolved.push(value);
      return;
    }
    const later = NEXT_WAKE_LINE.exec(line);
    if (later) {
      protocolAt.add(index);
      const value = clean(later[1]!, NEXT_WAKE_LINE_LIMIT);
      if (value && nextWake.length < NEXT_WAKE_PER_RUN && !nextWake.includes(value)) nextWake.push(value);
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
    resolved,
    nextWake,
  };
}

const needWords = (text: string): string => text.replace(/[*_`"'“”‘’.]+/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** Whether two requests ask for the same thing: the same words, or one
 *  opening with the other's (an agent rarely repeats itself to the letter). */
export function sameNeed(a: string, b: string): boolean {
  const left = needWords(a);
  const right = needWords(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= 12 && long.startsWith(short);
}

/** A request still waiting for the person, with where it was first asked. */
export interface OpenNeed extends AgentNeed {
  runId: string;
  /** Its position among that run's needs. */
  index: number;
  /** When it was first asked (the oldest report that asked the same). */
  since: number;
}

export const OPEN_NEEDS_SHOWN = 6;
/** A request nobody settled in this long is history, not a to-do. */
export const OPEN_NEED_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

interface NeedSource {
  runId: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  needs?: AgentNeed[];
}

/** What still waits for the person across an agent's reports, newest first.
 *  A request asked again in a later report is one request (its newest
 *  wording, its first date); one settled anywhere is settled. */
export function openNeeds(history: readonly NeedSource[] | undefined, now: number, limit = OPEN_NEEDS_SHOWN): OpenNeed[] {
  const open: OpenNeed[] = [];
  const settled: string[] = [];
  for (const run of history ?? []) {
    if (run.status !== "ok" || !run.needs?.length) continue;
    const at = run.finishedAt ?? run.startedAt;
    run.needs.forEach((need, index) => {
      if (need.done) {
        settled.push(need.text);
        return;
      }
      const known = open.find((item) => sameNeed(item.text, need.text));
      // History runs newest first: an older report that asked the same only
      // moves the date back.
      if (known) known.since = Math.min(known.since, at);
      else open.push({ ...need, runId: run.runId, index, since: at });
    });
  }
  return open
    .filter((need) => !settled.some((text) => sameNeed(text, need.text)) && now - need.since <= OPEN_NEED_MAX_AGE_MS)
    .slice(0, limit);
}

/** The text before a code block it opens and never closes: the opening half
 *  of a cut block ("```ts\nif (session.p") reads as garbage. */
export function withoutOpenFence(text: string): string {
  let open = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) open = open < 0 ? offset : -1;
    offset += line.length + 1;
  }
  return open < 0 ? text : text.slice(0, open).trimEnd();
}

/** A report body the record can keep: at most `limit` characters, cut at a
 *  paragraph (else a line, else a word) and never inside a code block, with
 *  "…" saying there was more. The whole message stays in the run's session. */
export function clipReport(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const room = body.slice(0, Math.max(0, limit - 3));
  const floor = room.length * 0.6;
  const at = [room.lastIndexOf("\n\n"), room.lastIndexOf("\n"), room.lastIndexOf(" ")].find((index) => index >= floor);
  const kept = withoutOpenFence((at === undefined ? room : room.slice(0, at)).trimEnd());
  return kept ? `${kept}\n\n…` : "…";
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

/** How the person's "do this next time" reaches the next wake: the server
 *  keeps the line and hands it to the next run that is not a conversation
 *  with the person, once. Only a run that carries the person's words may set
 *  one. */
export const NEXT_WAKE_INSTRUCTION =
  "When the user asks for something to be done at your next wake (next run, next time) rather than now, do not do it in this run: add a line \"Next wake: <what to do, complete and in your own words>\" and say it is set aside. Polyth hands it to your next wake once.";

/** The protocol, as the agent reads it at the end of a new session's prompt. */
export const REPORT_INSTRUCTIONS = [
  "Finish your final message with one line:",
  "Report: quiet|update|alert — <headline, under 12 words>",
  "The headline is shown above your message, so do not open the message by restating it: start with what follows from it.",
  "- quiet: nothing new that deserves the user's time; the run is filed silently.",
  "- update: a result worth reading.",
  "- alert: something needs the user's attention soon.",
  "For anything only the user can do themselves (a review, a sign-in, a test on a real device), add a line \"Needs you: <what> — <why or what to do> — <link>\" (the link is optional). It stays on your page as the user's to-do until they mark it done or you close it, so ask once, name the exact action, and never use it for something you can do yourself.",
  "When you only wait for the user's yes or no and will then do the work yourself (a risky upgrade, an irreversible or outward-facing step), write it as \"Needs your OK: <what you will do once they agree> — <why it needs them> — <link>\" instead: the user answers with one tap and you are woken with their answer. Never use it for something the user has to do themselves.",
  "When a request you made earlier no longer waits (the user did it, or it stopped mattering), close it with a line \"Resolved: <the same words>\".",
  "If you start background work and end your turn to wait for it, leave out the Report line until the final message: a message without it while that work runs is not your report.",
  "For anything later runs should know (a preference, a decision, a state to track), add a line \"Remember: <note>\". Keep notes short; they go into your notebook.",
  NEXT_WAKE_INSTRUCTION,
].join("\n");

/** The same protocol, as a reminder in a continuing session. */
export const REPORT_REMINDER =
  "Finish with \"Report: quiet|update|alert — <headline>\" (shown above your message: do not restate it there; only in your final message, not while background work you wait for runs); add \"Remember: <note>\" lines for anything later runs should know, \"Needs you: <what> — <why> — <link>\" lines for what only the user can do themselves, \"Needs your OK: <what you will do> — <why> — <link>\" lines for a yes or no you then act on, and \"Resolved: <the same words>\" for an earlier request that no longer waits; when the user asks for something at your next wake rather than now, do not do it now: add \"Next wake: <what to do>\".";
