// Structured, bounded runtime-epoch recoveryContext.
// Hard caps stay 40 messages / 16k characters. Budget is character length:
// this repo has no tokenizer, and we do not add one (≈ chars/4 tokens).

import { redactContinuity, type ContinuityWorkspace } from "./continuity.ts";
import type { ModelMessage, SessionEvent } from "@polyth/contracts";

/** Do not raise these ceilings. */
export const EPOCH_RECOVERY_MAX_MESSAGES = 40;
export const EPOCH_RECOVERY_MAX_CHARS = 16_000;

export const EPOCH_RECOVERY_NOTE_LINES = [
  "The execution runtime was replaced.",
  "Conversation context was reconstructed from confirmed Polyth history.",
  "Do not assume unconfirmed operations from the previous runtime completed.",
] as const;

/** Reserved shares of the remaining content budget after the fixed wrapper. */
export const EPOCH_RECOVERY_BUDGET_SHARE = {
  intent: 0.18,
  durable: 0.22,
  summaries: 0.12,
  dialogue: 0.48,
} as const;

export interface RuntimeEpochRecoveryAttachment {
  name: string;
  mime?: string;
}

export interface RuntimeEpochRecoveryDialogueLine {
  role: "user" | "assistant";
  text: string;
  attachments?: readonly RuntimeEpochRecoveryAttachment[];
}

export interface RuntimeEpochRecoveryPin {
  sourceEventSeq: number;
  role: "user" | "assistant";
  text: string;
}

export interface RuntimeEpochRecoveryKnowledge {
  title: string;
  body?: string;
}

export interface RuntimeEpochRecoveryInput {
  reason?: "harness-switch" | "snapshot";
  workspace?: ContinuityWorkspace;
  epoch: number;
  markerSeq: number;
  /** Confirmed, effective, rewind-respecting user/assistant lines, oldest first. */
  dialogue: readonly RuntimeEpochRecoveryDialogueLine[];
  objective?: string;
  pinned?: readonly RuntimeEpochRecoveryPin[];
  behavior?: string;
  agent?: string;
  knowledge?: readonly RuntimeEpochRecoveryKnowledge[];
  /** Confirmed summary text only — never invented from a compaction marker. */
  summaries?: readonly string[];
}

export interface RuntimeEpochRecoverySectionChars {
  intent: number;
  durable: number;
  summaries: number;
  dialogue: number;
}

export interface RuntimeEpochRecoveryBuild {
  recoveryContext: string;
  omittedMessages: number;
  omittedPins: number;
  omittedKnowledge: number;
  omittedSummaries: number;
  sectionsCapped: string[];
  sectionChars: RuntimeEpochRecoverySectionChars;
  goalRestored: boolean;
  pinnedSourceSeqs: number[];
}

interface BudgetItem {
  text: string;
  /** Optional durable pin source, used only when the item is kept. */
  sourceEventSeq?: number;
}

const RECOVERY_CLOSE = "</polyth-runtime-epoch-recovery>";

/** User-controlled text must not emit a second valid closing wrapper. */
export function escapeRecoveryText(text: string): string {
  return redactContinuity(text).split(RECOVERY_CLOSE).join("</ polyth-runtime-epoch-recovery>");
}

const SECTION_INTENT = "Session intent / active instructions";
const SECTION_DURABLE = "Important durable context";
const SECTION_SUMMARIES = "Relevant summaries";
const SECTION_DIALOGUE = "Recent confirmed conversation";

export function dialogueFromMessages(
  messages: readonly ModelMessage[],
): RuntimeEpochRecoveryDialogueLine[] {
  const out: RuntimeEpochRecoveryDialogueLine[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    const attachments = message.parts
      .filter((part): part is { type: "file"; name: string; mime: string } => part.type === "file")
      .map((part) => ({ name: part.name, mime: part.mime }));
    out.push({
      role: message.role === "user" ? "user" : "assistant",
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return out;
}

export function formatRecoveryDialogueLine(line: RuntimeEpochRecoveryDialogueLine): string {
  const role = line.role === "user" ? "User" : "Assistant";
  const chunks = [`${role}: ${line.text}`];
  if (line.attachments?.length) {
    chunks.push(`Attachments: ${line.attachments.map(formatAttachmentRef).join("; ")}`);
  }
  return chunks.join("\n");
}

export function formatAttachmentRef(ref: RuntimeEpochRecoveryAttachment): string {
  return ref.mime ? `${ref.name} (${ref.mime})` : ref.name;
}

/** Latest active objective from confirmed goal events. Completed/stopped goals are omitted. */
export function activeObjectiveFromEvents(events: readonly SessionEvent[]): string | undefined {
  let objective: string | undefined;
  let status: string | undefined;
  for (const event of events) {
    if (!event.type.startsWith("goal/")) continue;
    if (event.type === "goal/context-restored") continue;
    const data = event.data as { objective?: unknown };
    if (event.type === "goal/attached") {
      objective = typeof data.objective === "string" ? data.objective : undefined;
      status = "active";
      continue;
    }
    if (event.type === "goal/paused") status = "paused";
    else if (event.type === "goal/resumed") status = "active";
    else if (event.type === "goal/completed") status = "completed";
    else if (event.type === "goal/stuck") status = "stuck";
    else if (event.type === "goal/stopped") {
      objective = undefined;
      status = undefined;
    }
  }
  const trimmed = objective?.trim();
  return status === "active" && trimmed ? trimmed : undefined;
}

/** Attached knowledge snapshots from the event log (title + body). */
export function attachedKnowledge(events: readonly SessionEvent[]): RuntimeEpochRecoveryKnowledge[] {
  const out: RuntimeEpochRecoveryKnowledge[] = [];
  for (const event of events) {
    if (event.type !== "knowledge/attached") continue;
    const data = event.data as { title?: unknown; body?: unknown };
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) continue;
    const body = typeof data.body === "string" ? data.body : "";
    out.push({ title, ...(body ? { body } : {}) });
  }
  return out;
}

/** Only include compaction rows that already carry summary text in Polyth state. */
export function compactionSummariesFromEvents(events: readonly SessionEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== "session/compacted" && event.type !== "compaction/part-recorded") {
      continue;
    }
    const data = event.data as { summary?: unknown; text?: unknown };
    const summary = typeof data.summary === "string"
      ? data.summary
      : typeof data.text === "string" ? data.text : "";
    if (summary.trim()) out.push(summary.trim());
  }
  return out;
}

export function buildRuntimeEpochRecoveryContext(
  input: RuntimeEpochRecoveryInput,
): RuntimeEpochRecoveryBuild {
  input = JSON.parse(JSON.stringify(input, (_key, value) => typeof value === "string" ? redactContinuity(value) : value)) as RuntimeEpochRecoveryInput;
  const prefix = [
    `<polyth-runtime-epoch-recovery epoch="${input.epoch}" marker-seq="${input.markerSeq}">`,
    "Recovery context",
  ].join("\n");
  const note = ["Recovery note:", ...(input.reason === "snapshot" ? ["This conversation was imported as a Snapshot. Polyth owns its future history.", "Only confirmed canonical dialogue was transferred."] : EPOCH_RECOVERY_NOTE_LINES),
    ...(input.reason ? ["The workspace is authoritative. Inspect files before relying on previous work."] : []),
    ...(input.workspace ? ["Current workspace: " + JSON.stringify(input.workspace)] : []),
  ].join("\n");
  const suffix = RECOVERY_CLOSE;
  const footerSlack = 220;
  const fixed = prefix.length + suffix.length + note.length + 8;
  const contentBudget = Math.max(0, EPOCH_RECOVERY_MAX_CHARS - fixed - footerSlack);

  const intentItems = intentSectionItems(input);
  const durable = durableSectionItems(input);
  const summaryItems = (input.summaries ?? [])
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  const dialogueSource = input.dialogue.slice(-EPOCH_RECOVERY_MAX_MESSAGES);
  const omittedByCount = Math.max(0, input.dialogue.length - dialogueSource.length);
  const dialogueItems = dialogueSource.map((line) => ({ text: formatRecoveryDialogueLine(line) }));

  const shares = EPOCH_RECOVERY_BUDGET_SHARE;
  const present = {
    intent: intentItems.length > 0,
    durable: durable.items.length > 0,
    summaries: summaryItems.length > 0,
    dialogue: dialogueItems.length > 0,
  };
  const activeShare = (present.intent ? shares.intent : 0)
    + (present.durable ? shares.durable : 0)
    + (present.summaries ? shares.summaries : 0)
    + (present.dialogue ? shares.dialogue : 0);
  const reserve = (share: number, hasContent: boolean): number => {
    if (!hasContent || activeShare <= 0) return 0;
    return Math.floor(contentBudget * (share / activeShare));
  };

  const intentFit = takeOldest(intentItems, reserve(shares.intent, present.intent));
  const durableFit = takeOldest(durable.items, reserve(shares.durable, present.durable));
  const summaryFit = takeOldest(summaryItems, reserve(shares.summaries, present.summaries));
  const dialogueFit = takeNewest(dialogueItems, reserve(shares.dialogue, present.dialogue));

  let leftover = contentBudget
    - usedLength(intentFit.kept)
    - usedLength(durableFit.kept)
    - usedLength(summaryFit.kept)
    - usedLength(dialogueFit.kept);

  leftover = fillNewest(dialogueFit, leftover);
  leftover = fillOldest(durableFit, leftover);
  leftover = fillOldest(summaryFit, leftover);
  leftover = fillOldest(intentFit, leftover);
  void leftover;

  const intentBody = joinItems(intentFit.kept);
  const durableBody = joinItems(durableFit.kept);
  const summaryBody = joinItems(summaryFit.kept);
  const dialogueBody = joinItems(dialogueFit.kept);

  const omittedMessages = omittedByCount + dialogueFit.omitted.length;
  const omittedPins = durable.pinItems - durableFit.kept.filter((item) => item.sourceEventSeq !== undefined).length;
  const omittedKnowledge = durable.knowledgeItems
    - durableFit.kept.filter((item) => item.text.startsWith("Attached knowledge:")).length;
  const omittedSummaries = summaryFit.omitted.length;
  const sectionsCapped: string[] = [];
  if (intentFit.omitted.length) sectionsCapped.push("intent");
  if (durableFit.omitted.length) sectionsCapped.push("durable");
  if (summaryFit.omitted.length) sectionsCapped.push("summaries");
  if (omittedMessages > 0) sectionsCapped.push("dialogue");

  const footer = omissionFooter({
    omittedMessages,
    omittedPins: Math.max(0, omittedPins),
    omittedKnowledge: Math.max(0, omittedKnowledge),
    omittedSummaries,
    sectionsCapped,
  });

  const pinnedSourceSeqs = durableFit.kept
    .map((item) => item.sourceEventSeq)
    .filter((seq): seq is number => seq !== undefined);

  const sections = [
    intentBody ? `${SECTION_INTENT}\n${intentBody}` : "",
    durableBody ? `${SECTION_DURABLE}\n${durableBody}` : "",
    summaryBody ? `${SECTION_SUMMARIES}\n${summaryBody}` : "",
    dialogueBody ? `${SECTION_DIALOGUE}\n${dialogueBody}` : "",
    footer,
    note,
  ].filter(Boolean);

  let recoveryContext = `${prefix}\n\n${escapeRecoveryText(sections.join("\n\n"))}\n${suffix}`;
  while (recoveryContext.length > EPOCH_RECOVERY_MAX_CHARS && dialogueFit.kept.length > 0) {
    const dropped = dialogueFit.kept.shift();
    if (dropped) dialogueFit.omitted.unshift(dropped);
    const nextFooter = omissionFooter({
      omittedMessages: omittedByCount + dialogueFit.omitted.length,
      omittedPins: Math.max(0, omittedPins),
      omittedKnowledge: Math.max(0, omittedKnowledge),
      omittedSummaries,
      sectionsCapped: sectionsCapped.includes("dialogue")
        ? sectionsCapped
        : [...sectionsCapped, "dialogue"],
    });
    const nextDialogue = joinItems(dialogueFit.kept);
    const nextSections = [
      intentBody ? `${SECTION_INTENT}\n${intentBody}` : "",
      durableBody ? `${SECTION_DURABLE}\n${durableBody}` : "",
      summaryBody ? `${SECTION_SUMMARIES}\n${summaryBody}` : "",
      nextDialogue ? `${SECTION_DIALOGUE}\n${nextDialogue}` : "",
      nextFooter,
      note,
    ].filter(Boolean);
    recoveryContext = `${prefix}\n\n${escapeRecoveryText(nextSections.join("\n\n"))}\n${suffix}`;
  }

  const omittedDialogue = omittedByCount + dialogueFit.omitted.length;
  const capped = omittedDialogue > 0 && !sectionsCapped.includes("dialogue")
    ? [...sectionsCapped, "dialogue"]
    : sectionsCapped;
  return {
    recoveryContext,
    omittedMessages: omittedDialogue,
    omittedPins: Math.max(0, omittedPins),
    omittedKnowledge: Math.max(0, omittedKnowledge),
    omittedSummaries,
    sectionsCapped: capped,
    sectionChars: {
      intent: intentBody.length,
      durable: durableBody.length,
      summaries: summaryBody.length,
      dialogue: joinItems(dialogueFit.kept).length,
    },
    goalRestored: Boolean(input.objective?.trim()) && durableFit.kept.some((item) =>
      item.text.startsWith("Active objective:")),
    pinnedSourceSeqs,
  };
}

function intentSectionItems(input: RuntimeEpochRecoveryInput): BudgetItem[] {
  const items: BudgetItem[] = [];
  const agent = input.agent?.trim();
  if (agent) items.push({ text: `Selected agent: ${agent}` });
  const behavior = input.behavior?.trim();
  if (behavior) items.push({ text: `Session instructions:\n${behavior}` });
  return items;
}

function durableSectionItems(input: RuntimeEpochRecoveryInput): {
  items: BudgetItem[];
  pinItems: number;
  knowledgeItems: number;
} {
  const items: BudgetItem[] = [];
  const objective = input.objective?.trim();
  if (objective) items.push({ text: `Active objective:\n${objective}` });
  const pins = input.pinned ?? [];
  for (const pin of pins) {
    const text = pin.text.trim();
    if (!text) continue;
    items.push({
      text: `[${pin.role} message]\n${text}`,
      sourceEventSeq: pin.sourceEventSeq,
    });
  }
  const knowledge = input.knowledge ?? [];
  for (const item of knowledge) {
    const title = item.title.trim();
    if (!title) continue;
    const body = item.body?.trim();
    items.push({
      text: body ? `Attached knowledge:\n${title}\n${body}` : `Attached knowledge:\n${title}`,
    });
  }
  return { items, pinItems: pins.length, knowledgeItems: knowledge.length };
}

function takeOldest(items: readonly BudgetItem[], budget: number): {
  kept: BudgetItem[];
  omitted: BudgetItem[];
} {
  const kept: BudgetItem[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const extra = kept.length > 0 ? 2 : 0;
    if (used + extra + item.text.length > budget) {
      return { kept, omitted: items.slice(i).slice() };
    }
    kept.push(item);
    used += extra + item.text.length;
  }
  return { kept, omitted: [] };
}

function takeNewest(items: readonly BudgetItem[], budget: number): {
  kept: BudgetItem[];
  omitted: BudgetItem[];
} {
  const keptRev: BudgetItem[] = [];
  let used = 0;
  let cut = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const extra = keptRev.length > 0 ? 2 : 0;
    if (used + extra + item.text.length > budget) {
      cut = i + 1;
      break;
    }
    keptRev.push(item);
    used += extra + item.text.length;
    cut = i;
  }
  return { kept: keptRev.reverse(), omitted: items.slice(0, cut) };
}

function fillOldest(
  fit: { kept: BudgetItem[]; omitted: BudgetItem[] },
  leftover: number,
): number {
  const still: BudgetItem[] = [];
  for (const item of fit.omitted) {
    const extra = fit.kept.length > 0 ? 2 : 0;
    if (extra + item.text.length > leftover) {
      still.push(item);
      continue;
    }
    fit.kept.push(item);
    leftover -= extra + item.text.length;
  }
  fit.omitted = still;
  return leftover;
}

function fillNewest(
  fit: { kept: BudgetItem[]; omitted: BudgetItem[] },
  leftover: number,
): number {
  const still: BudgetItem[] = [];
  for (let i = fit.omitted.length - 1; i >= 0; i--) {
    const item = fit.omitted[i]!;
    const extra = fit.kept.length > 0 ? 2 : 0;
    if (extra + item.text.length > leftover) {
      still.unshift(item);
      continue;
    }
    fit.kept.unshift(item);
    leftover -= extra + item.text.length;
  }
  fit.omitted = still;
  return leftover;
}

function usedLength(items: readonly BudgetItem[]): number {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item.text.length, 0) + 2 * (items.length - 1);
}

function joinItems(items: readonly BudgetItem[]): string {
  return items.map((item) => item.text).join("\n\n");
}

function omissionFooter(input: {
  omittedMessages: number;
  omittedPins: number;
  omittedKnowledge: number;
  omittedSummaries: number;
  sectionsCapped: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.omittedMessages > 0) {
    parts.push(
      input.omittedMessages === 1
        ? "1 older confirmed message"
        : `${input.omittedMessages} older confirmed messages`,
    );
  }
  if (input.omittedPins > 0) {
    parts.push(input.omittedPins === 1 ? "1 pinned item" : `${input.omittedPins} pinned items`);
  }
  if (input.omittedKnowledge > 0) {
    parts.push(
      input.omittedKnowledge === 1 ? "1 knowledge item" : `${input.omittedKnowledge} knowledge items`,
    );
  }
  if (input.omittedSummaries > 0) {
    parts.push(
      input.omittedSummaries === 1 ? "1 summary" : `${input.omittedSummaries} summaries`,
    );
  }
  if (input.sectionsCapped.includes("intent") && !parts.some((part) => part.includes("instructions"))) {
    parts.push("session instructions hit their budget");
  }
  if (input.sectionsCapped.includes("durable") && input.omittedPins === 0 && input.omittedKnowledge === 0) {
    parts.push("durable context hit its budget");
  }
  if (parts.length === 0) return "";
  return `Omitted: ${parts.join("; ")}.`;
}
