// Polyth-owned conversation compaction, for runtimes without a native one.
// The session's own model condenses confirmed canonical history into a
// summary, the native context is replaced by a fresh leg on the same harness,
// and the first turn of that leg restores the summary first. The reader sees
// the same `session/compacted` marker a harness compaction leaves.
import type { ModelMessage, SessionEvent } from "@polyth/contracts";

/** `session/compacted.source` for a compaction Polyth performed itself. */
export const POLYTH_COMPACTION_SOURCE = "polyth";

/** Kept below the summary share of the epoch-recovery budget. */
export const COMPACTION_SUMMARY_MAX_CHARS = 7_000;
export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 2_400;

const TOOL_INPUT_CHARS = 240;
const TOOL_OUTPUT_CHARS = 600;
const FIRST_REQUEST_CHARS = 4_000;
const TRANSCRIPT_CLOSE = "</transcript>";

export const COMPACTION_SYSTEM_PROMPT = [
  "You compact a conversation between a person and a coding agent so the agent can continue in a fresh context window.",
  "The summary you write replaces the full history: the agent will see only it and the newest messages.",
  "Use only facts present in the transcript. Do not continue the task, call tools or address the person.",
].join("\n");

const COMPACTION_INSTRUCTIONS = [
  "Summarize the conversation in the transcript below. Use these Markdown sections and omit any that would be empty:",
  "## Goal — what the person asked for, including constraints and preferences they stated",
  "## Progress — what has been done, decisions made and why",
  "## Files and code — files read, created or changed, with the details needed to keep working on them",
  "## Errors and fixes — problems hit and how they were resolved",
  "## Open items — unfinished work, open questions and the agreed next step",
  "## Latest exchange — what was being worked on right before this summary",
  "Keep exact identifiers, paths, commands, numbers and quoted requirements. Stay under 900 words.",
].join("\n");

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One message as transcript text. Reasoning is private to its turn and is
 *  left out; tool traffic is clipped to what explains the work. */
export function compactionTranscriptLine(message: ModelMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim());
    else if (part.type === "file") chunks.push(`[attached ${part.name}]`);
    else if (part.type === "tool-call") {
      chunks.push(`[tool ${part.tool}] ${clip(oneLine(JSON.stringify(part.input)), TOOL_INPUT_CHARS)}`);
    } else if (part.type === "tool-result") {
      const output = clip(oneLine(part.output), TOOL_OUTPUT_CHARS);
      chunks.push(`[${part.isError ? "tool error" : "tool result"} ${part.tool}]${output ? ` ${output}` : ""}`);
    }
  }
  if (chunks.length === 0) return "";
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
  return `${role}: ${chunks.join("\n")}`;
}

/** Transcript within `maxChars`. An earlier summary leads; then the first
 *  request (it usually states the goal) and the newest messages that fit.
 *  Whatever is dropped from the middle is counted, never silently lost. */
export function compactionTranscript(
  messages: readonly ModelMessage[],
  options: { maxChars: number; previousSummary?: string },
): string {
  const head: string[] = [];
  const previous = options.previousSummary?.trim();
  if (previous) head.push(`Summary of the conversation before this transcript:\n${previous}`);
  const lines = messages.map(compactionTranscriptLine).filter(Boolean);
  const firstUser = lines.findIndex((line) => line.startsWith("User: "));
  const first = firstUser >= 0 ? clip(lines[firstUser]!, FIRST_REQUEST_CHARS) : undefined;
  const fixed = head.join("\n\n").length;
  let budget = Math.max(0, options.maxChars - fixed - 120);
  const kept: string[] = [];
  let index = lines.length - 1;
  for (; index >= 0; index--) {
    if (index === firstUser) break;
    const line = lines[index]!;
    if (line.length + 2 > budget) break;
    kept.unshift(line);
    budget -= line.length + 2;
  }
  const body: string[] = [];
  if (index >= 0 && first) {
    if (index === firstUser) {
      body.push(lines[firstUser]!.length + 2 <= budget ? lines[firstUser]! : first);
    } else {
      const omitted = index - firstUser;
      if (first.length + 2 <= budget) body.push(first);
      if (omitted > 0) body.push(`[… ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted …]`);
    }
  } else if (index >= 0) {
    body.push(`[… ${index + 1} earlier message${index === 0 ? "" : "s"} omitted …]`);
  }
  body.push(...kept);
  return [...head, ...body].join("\n\n").slice(0, Math.max(0, options.maxChars));
}

/** The summarizer request for a transcript. */
export function compactionPrompt(transcript: string): string {
  const safe = transcript.split(TRANSCRIPT_CLOSE).join("</ transcript>");
  return `${COMPACTION_INSTRUCTIONS}\n\n<transcript>\n${safe}\n${TRANSCRIPT_CLOSE}`;
}

/** Strip wrapper noise a model may add and bound the result. */
export function normalizeCompactionSummary(text: string): string {
  let summary = text.trim();
  const fenced = summary.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) summary = fenced[1]!.trim();
  const tagged = summary.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (tagged) summary = tagged[1]!.trim();
  return clip(summary, COMPACTION_SUMMARY_MAX_CHARS);
}

/** The latest summary-bearing compaction at or before `beforeSeq`, as the
 *  starting point of the next summary. */
export function latestCompactionSummary(
  events: readonly SessionEvent[],
  beforeSeq = Number.MAX_SAFE_INTEGER,
): { seq: number; summary: string } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.seq > beforeSeq || event.type !== "session/compacted") continue;
    const summary = (event.data as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) return { seq: event.seq, summary: summary.trim() };
  }
  return undefined;
}

/** The Polyth compaction that produced the runtime epoch at `markerSeq`. */
export function polythCompactionForEpoch(
  events: readonly SessionEvent[],
  markerSeq: number,
): { seq: number; summary: string } | undefined {
  for (const event of events) {
    if (event.type !== "session/compacted" || event.seq <= markerSeq) continue;
    const data = event.data as { source?: unknown; epochMarkerSeq?: unknown; summary?: unknown };
    if (data.source !== POLYTH_COMPACTION_SOURCE || Number(data.epochMarkerSeq) !== markerSeq) continue;
    if (typeof data.summary === "string" && data.summary.trim()) {
      return { seq: event.seq, summary: data.summary.trim() };
    }
  }
  return undefined;
}
