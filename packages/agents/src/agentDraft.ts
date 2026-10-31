// "Draft an agent" from a plain description: the prompt for the small model
// and a strict parser for its answer. Nothing here activates anything; the
// result only pre-fills the editor, which the user reviews.
import { validateCron } from "./cron.ts";
import { AGENT_ICON_IDS, type AgentIconId } from "./agentPrompt.ts";
import type { ScheduleCadence } from "./index.ts";

export interface AgentDraft {
  name: string;
  description: string;
  charter: string;
  icon: AgentIconId;
  /** Null = wakes only when started by hand. */
  schedule: ScheduleCadence | null;
  context: "fresh" | "rolling";
}

export const DRAFT_MAX_INPUT_CHARS = 6_000;

export const DRAFT_SYSTEM_PROMPT = [
  "You design a recurring AI coding agent from a user's description.",
  "Answer with one JSON object and nothing else:",
  '{"name": string (2-4 words, Title Case), "description": string (one sentence, what it does),',
  ' "charter": string (standing instructions in second person: role, steps, rules, report format; 60-250 words),',
  ` "icon": one of ${AGENT_ICON_IDS.map((id) => `"${id}"`).join(", ")},`,
  ' "cron": string or null (5-field cron for when it should wake; null if only on demand),',
  ' "context": "fresh" or "rolling" ("rolling" when each run builds on the previous ones)}',
  "Write in the language of the description. Never invent credentials, URLs or permissions.",
].join("\n");

export function draftPrompt(input: { description: string; conversation?: string }): string {
  const parts = [`Description:\n${input.description.trim().slice(0, DRAFT_MAX_INPUT_CHARS)}`];
  if (input.conversation?.trim()) {
    parts.push(`The agent should continue the work of this conversation (excerpt):\n${input.conversation.trim().slice(0, DRAFT_MAX_INPUT_CHARS)}`);
  }
  return parts.join("\n\n");
}

const firstJsonObject = (text: string): Record<string, unknown> | undefined => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+$/g, "").trim().slice(0, max) : "";

/** Undefined when the answer is unusable (no name or charter). An invalid
 *  cron or icon degrades to a safe default instead of failing the draft. */
export function parseAgentDraft(answer: string, timeZone: string): AgentDraft | undefined {
  const raw = firstJsonObject(answer);
  if (!raw) return undefined;
  const name = text(raw.name, 60).replace(/\s+/g, " ");
  const charter = text(raw.charter, 8_000);
  if (!name || charter.length < 20) return undefined;
  const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
  const schedule: ScheduleCadence | null = cron && validateCron(cron, timeZone, { minIntervalMinutes: 5 }).ok
    ? { kind: "cron", expression: cron, timeZone }
    : null;
  return {
    name,
    description: text(raw.description, 280).replace(/\s+/g, " "),
    charter,
    icon: (AGENT_ICON_IDS as readonly string[]).includes(String(raw.icon)) ? raw.icon as AgentIconId : "bot",
    schedule,
    context: raw.context === "rolling" ? "rolling" : "fresh",
  };
}
