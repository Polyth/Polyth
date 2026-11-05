// Structured, bounded runtime-epoch recoveryContext.
// Hard caps stay 40 messages / 16k characters. Budget is character length:
// this repo has no tokenizer, and we do not add one (≈ chars/4 tokens).

import { redactContinuity, type ContinuityWorkspace } from "./continuity.ts";
import { extractChangedFiles, isFileMutatingTool } from "@polyth/contracts/tool-edits";
import type { JsonObject, ModelMessage, SessionEvent } from "@polyth/contracts";

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
  intent: 0.14,
  durable: 0.18,
  summaries: 0.1,
  work: 0.18,
  dialogue: 0.4,
} as const;

/** After a Polyth compaction the summary stands in for the older dialogue, so
 *  it takes the largest share and only a short verbatim tail follows it. */
export const COMPACTION_RECOVERY_BUDGET_SHARE = {
  intent: 0.1,
  durable: 0.14,
  summaries: 0.44,
  work: 0.12,
  dialogue: 0.2,
} as const;

export const COMPACTION_RECOVERY_NOTE_LINES = [
  "The conversation was compacted to free context.",
  "The summary replaces the earlier history; the most recent messages follow it verbatim.",
] as const;

/** Read only what the next step needs: a fresh runtime that re-reads everything
 *  repeats work the state above already records, and pays for it in context. */
export const WORKSPACE_AUTHORITY_NOTE = "The workspace is authoritative. Check a file before relying on it, and read only what the next step needs; the work state above says where to look.";
export const HARNESS_SWITCH_NOTE = "This conversation continues from another agent harness; tool names in its history may differ from yours.";

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

/** What the session did, beyond what was said. Facts from confirmed history;
 *  no file contents and no tool output except a failure's own message. */
export interface RuntimeEpochRecoveryWork {
  /** The session's first request, kept when it has left the recent dialogue. */
  firstRequest?: string;
  plan?: ReadonlyArray<{ text: string; status: string }>;
  /** Newest first, with how many older ones did not fit. */
  changedFiles?: readonly string[];
  omittedChangedFiles?: number;
  readFiles?: readonly string[];
  commands?: ReadonlyArray<{ command: string; error?: string }>;
  failures?: ReadonlyArray<{ tool: string; error: string }>;
  subagents?: ReadonlyArray<{ label: string; status: string }>;
  /** How the last turn ended, when it did not simply complete. */
  lastTurn?: { outcome: "stopped" | "failed" | "unfinished"; reason?: string; unresolvedTools?: readonly string[] };
}

export interface RuntimeEpochRecoveryInput {
  reason?: "harness-switch" | "snapshot" | "compaction";
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
  work?: RuntimeEpochRecoveryWork;
}

export interface RuntimeEpochRecoveryOptions {
  /** Removes secrets the host knows about, applied to all that can reach the
   *  output. Runs here, on the small selected input, not on the whole log. */
  sanitize?: (text: string) => string;
}

export interface RuntimeEpochRecoverySectionChars {
  intent: number;
  durable: number;
  summaries: number;
  work: number;
  dialogue: number;
}

export interface RuntimeEpochRecoveryBuild {
  recoveryContext: string;
  omittedMessages: number;
  /** Long messages kept with their middle cut out. */
  shortenedMessages: number;
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
const SECTION_WORK = "Work state (from confirmed history; verify before relying on it)";
const SECTION_DIALOGUE = "Recent confirmed conversation";

const ROOMY_NEWEST_LINES = 2;
const ROOMY_LINE_SHARE = 0.35;
const PLAIN_LINE_SHARE = 0.14;
const MIN_LINE_CHARS = 300;
const WORK_MAX_CHANGED_FILES = 40;
const WORK_MAX_READ_FILES = 15;
const WORK_MAX_COMMANDS = 8;
const WORK_MAX_FAILURES = 3;
const WORK_MAX_PLAN = 20;
const WORK_MAX_SUBAGENTS = 8;
const WORK_COMMAND_CHARS = 200;
const WORK_ERROR_CHARS = 240;
const WORK_REQUEST_CHARS = 1_500;
const READ_TOOL = /(?:^|[._:-])(?:read|view|open|cat)(?:[._:-]|$)|^read/i;
const READ_PATH_KEYS = ["file_path", "filePath", "path", "target_file", "targetFile", "absolute_path", "absolutePath"];

/** Keep both ends: a long message opens with its point and ends with its result.
 *  Runs after redaction, so a cut cannot leave part of a credential behind. */
function shortenMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 40);
  const head = Math.ceil(room * 0.65);
  const tail = room - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head).trimEnd()}\n[… ${omitted} characters omitted …]\n${tail > 0 ? text.slice(-tail).trimStart() : ""}`;
}

const shortLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const commandOf = (input: JsonObject): string | undefined => {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) {
    const words = command.filter((word): word is string => typeof word === "string");
    return words.length > 0 ? words.join(" ") : undefined;
  }
  return stringField(command);
};

const pushNewest = (list: string[], value: string): void => {
  const existing = list.indexOf(value);
  if (existing >= 0) list.splice(existing, 1);
  list.push(value);
};

/** Reads confirmed, effective events only (the caller's selection), oldest
 *  first. Text stays unredacted here; the builder redacts before it clips. */
export function workStateFromEvents(events: readonly SessionEvent[]): RuntimeEpochRecoveryWork {
  const calls = new Map<string, { tool: string; input: JsonObject }>();
  const changed: string[] = [];
  const read: string[] = [];
  const commands: Array<{ callId: string; command: string; error?: string }> = [];
  const failures: Array<{ tool: string; error: string }> = [];
  let firstRequest: string | undefined;
  let lastTurnEvent: SessionEvent | undefined;
  let turnOpen = false;
  let lastPrompt = 0;
  let plan: RuntimeEpochRecoveryWork["plan"];
  let subagents: RuntimeEpochRecoveryWork["subagents"];
  const running = new Map<string, { tool: string; seq: number }>();

  for (const event of events) {
    const data = event.data as JsonObject;
    switch (event.type) {
      case "user/message":
        if (data.hiddenUserMessage !== true) firstRequest ??= stringField(data.text);
        lastPrompt = event.seq;
        break;
      case "turn/started":
        turnOpen = true;
        lastTurnEvent = event;
        break;
      case "turn/stopped":
        turnOpen = false;
        lastTurnEvent = event;
        running.clear();
        break;
      case "tool/call":
      case "tool/started": {
        const callId = stringField(data.callId);
        const tool = stringField(data.tool);
        if (!callId || !tool) break;
        const input = data.input && typeof data.input === "object" && !Array.isArray(data.input) ? data.input as JsonObject : {};
        calls.set(callId, { tool, input });
        running.set(callId, { tool, seq: event.seq });
        break;
      }
      case "tool/result":
      case "tool/error": {
        const callId = stringField(data.callId) ?? "";
        running.delete(callId);
        const known = calls.get(callId);
        // The call names the tool: some adapters (Claude) report results as "tool".
        const tool = known?.tool ?? stringField(data.tool) ?? "tool";
        const input = data.input && typeof data.input === "object" && !Array.isArray(data.input)
          ? data.input as JsonObject
          : known?.input ?? {};
        const error = event.type === "tool/error" ? stringField(data.error) ?? "failed" : undefined;
        const command = commandOf(input);
        if (command && !isFileMutatingTool(tool)) {
          commands.push({ callId, command, ...(error ? { error } : {}) });
          if (commands.length > WORK_MAX_COMMANDS) commands.shift();
        } else if (error) {
          failures.push({ tool, error });
          if (failures.length > WORK_MAX_FAILURES) failures.shift();
        }
        if (event.type === "tool/result") {
          const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
            ? data.metadata as JsonObject
            : undefined;
          for (const path of extractChangedFiles(tool, input, metadata)) pushNewest(changed, path);
          if (READ_TOOL.test(tool) && !isFileMutatingTool(tool)) {
            const path = READ_PATH_KEYS.map((key) => stringField(input[key])).find(Boolean);
            if (path) {
              pushNewest(read, path);
              if (read.length > WORK_MAX_READ_FILES) read.shift();
            }
          }
        }
        break;
      }
      case "task/snapshot":
        plan = Array.isArray(data.items)
          ? (data.items as JsonObject[]).flatMap((item) => {
            const text = stringField(item?.text);
            return text ? [{ text, status: stringField(item.status) ?? "pending" }] : [];
          })
          : undefined;
        break;
      case "subagent/snapshot":
        subagents = Array.isArray(data.agents)
          ? (data.agents as JsonObject[]).flatMap((agent) => {
            const label = stringField(agent?.label);
            const status = stringField(agent?.status) ?? "";
            return label && !/^(?:done|completed|failed|cancell?ed)$/i.test(status) ? [{ label, status }] : [];
          })
          : undefined;
        break;
      default:
        break;
    }
  }

  const stop = lastTurnEvent?.type === "turn/stopped" ? lastTurnEvent.data as JsonObject : undefined;
  const stopReason = stringField(stop?.reason);
  const unresolvedTools = [...running.values()]
    .filter((call) => call.seq > lastPrompt)
    .map((call) => call.tool);
  const lastTurn: RuntimeEpochRecoveryWork["lastTurn"] = turnOpen
    ? { outcome: "unfinished", ...(unresolvedTools.length ? { unresolvedTools } : {}) }
    : stopReason === "aborted"
      ? { outcome: "stopped", ...(stringField(stop?.error) ? { reason: stringField(stop?.error)! } : {}) }
      : stopReason === "error"
        ? { outcome: "failed", ...(stringField(stop?.error) ? { reason: stringField(stop?.error)! } : {}) }
        : undefined;
  const openPlan = plan?.filter((item) => !/^(?:done|completed|cancell?ed)$/i.test(item.status));
  const recentChanged = changed.slice(-WORK_MAX_CHANGED_FILES).reverse();
  return {
    ...(firstRequest ? { firstRequest } : {}),
    ...(openPlan?.length ? { plan: openPlan.slice(0, WORK_MAX_PLAN) } : {}),
    ...(recentChanged.length ? { changedFiles: recentChanged } : {}),
    ...(changed.length > recentChanged.length ? { omittedChangedFiles: changed.length - recentChanged.length } : {}),
    ...(read.length ? { readFiles: read.toReversed() } : {}),
    ...(commands.length ? { commands: commands.map(({ command, error }) => ({ command, ...(error ? { error } : {}) })) } : {}),
    ...(failures.length ? { failures } : {}),
    ...(subagents?.length ? { subagents: subagents.slice(0, WORK_MAX_SUBAGENTS) } : {}),
    ...(lastTurn ? { lastTurn } : {}),
  };
}

function workSectionItems(input: RuntimeEpochRecoveryInput, dialogueKeepsFirstRequest: boolean): BudgetItem[] {
  const work = input.work;
  if (!work) return [];
  const items: BudgetItem[] = [];
  const turn = work.lastTurn;
  if (turn) {
    const said = turn.outcome === "unfinished"
      ? "Last turn: the previous runtime ended before this turn finished."
      : turn.outcome === "failed"
        ? `Last turn: failed${turn.reason ? ` (${shortLine(turn.reason, WORK_ERROR_CHARS)})` : ""}.`
        : `Last turn: stopped before it finished${turn.reason ? ` (${shortLine(turn.reason, WORK_ERROR_CHARS)})` : ""}.`;
    const tools = turn.unresolvedTools?.length
      ? ` Outcome unknown for: ${[...new Set(turn.unresolvedTools)].map((tool) => shortLine(tool, 80)).join(", ")}.`
      : "";
    items.push({ text: said + tools });
  }
  if (work.plan?.length) {
    items.push({ text: `Open plan:\n${work.plan.map((item) => `- [${shortLine(item.status, 20)}] ${shortLine(item.text, 200)}`).join("\n")}` });
  }
  if (work.subagents?.length) {
    items.push({ text: `Subagents not finished:\n${work.subagents.map((agent) => `- ${shortLine(agent.label, 120)}${agent.status ? ` (${shortLine(agent.status, 20)})` : ""}`).join("\n")}` });
  }
  if (work.failures?.length) {
    items.push({ text: `Recent tool failures:\n${work.failures.map((failure) => `- ${shortLine(failure.tool, 80)}: ${shortLine(failure.error, WORK_ERROR_CHARS)}`).join("\n")}` });
  }
  if (work.commands?.length) {
    items.push({ text: `Recent commands, oldest first:\n${work.commands.map((item) => `- ${shortLine(item.command, WORK_COMMAND_CHARS)}${item.error ? ` → failed: ${shortLine(item.error, WORK_ERROR_CHARS)}` : ""}`).join("\n")}` });
  }
  if (work.changedFiles?.length) {
    const more = work.omittedChangedFiles ? `\n(and ${work.omittedChangedFiles} older)` : "";
    items.push({ text: `Files changed in this session, newest first:\n${work.changedFiles.join("\n")}${more}` });
  }
  if (work.readFiles?.length) {
    items.push({ text: `Files read recently, newest first:\n${work.readFiles.join("\n")}` });
  }
  if (work.firstRequest && !dialogueKeepsFirstRequest) {
    items.push({ text: `The session's first request:\n${shortenMiddle(work.firstRequest.trim(), WORK_REQUEST_CHARS)}` });
  }
  return items;
}

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
  options: RuntimeEpochRecoveryOptions = {},
): RuntimeEpochRecoveryBuild {
  // Only what can reach the output is copied and redacted: the whole history of
  // a long session would hold the server's single thread for no benefit.
  const omittedByCount = Math.max(0, input.dialogue.length - EPOCH_RECOVERY_MAX_MESSAGES);
  const firstDialogue = input.dialogue[0]?.text.trim();
  const keptFirst = omittedByCount === 0
    && firstDialogue !== undefined
    && input.work?.firstRequest?.trim() === firstDialogue;
  const sanitize = options.sanitize;
  input = JSON.parse(JSON.stringify(
    { ...input, dialogue: input.dialogue.slice(-EPOCH_RECOVERY_MAX_MESSAGES) },
    (_key, value) => typeof value === "string" ? redactContinuity(sanitize ? sanitize(value) : value) : value,
  )) as RuntimeEpochRecoveryInput;
  const prefix = [
    `<polyth-runtime-epoch-recovery epoch="${input.epoch}" marker-seq="${input.markerSeq}">`,
    "Recovery context",
  ].join("\n");
  const note = ["Recovery note:", ...(input.reason === "snapshot"
    ? ["This conversation was imported as a Snapshot. Polyth owns its future history.", "Only confirmed canonical dialogue was transferred."]
    : input.reason === "compaction" ? COMPACTION_RECOVERY_NOTE_LINES : EPOCH_RECOVERY_NOTE_LINES),
    ...(input.reason === "harness-switch" ? [HARNESS_SWITCH_NOTE] : []),
    ...(input.reason ? [WORKSPACE_AUTHORITY_NOTE] : []),
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
  const workItems = workSectionItems(input, keptFirst);
  const dialogueSource = input.dialogue;

  const shares = input.reason === "compaction" ? COMPACTION_RECOVERY_BUDGET_SHARE : EPOCH_RECOVERY_BUDGET_SHARE;
  const present = {
    intent: intentItems.length > 0,
    durable: durable.items.length > 0,
    summaries: summaryItems.length > 0,
    work: workItems.length > 0,
    dialogue: dialogueSource.length > 0,
  };
  const activeShare = (present.intent ? shares.intent : 0)
    + (present.durable ? shares.durable : 0)
    + (present.summaries ? shares.summaries : 0)
    + (present.work ? shares.work : 0)
    + (present.dialogue ? shares.dialogue : 0);
  const reserve = (share: number, hasContent: boolean): number => {
    if (!hasContent || activeShare <= 0) return 0;
    return Math.floor(contentBudget * (share / activeShare));
  };

  const intentFit = takeOldest(intentItems, reserve(shares.intent, present.intent));
  const durableFit = takeOldest(durable.items, reserve(shares.durable, present.durable));
  const summaryReserve = reserve(shares.summaries, present.summaries);
  // A compaction summary is the conversation itself: clip it to its share
  // rather than drop it whole for being a few characters long.
  const summaryFit = takeOldest(
    input.reason === "compaction"
      ? summaryItems.map((item) => item.text.length > summaryReserve
        ? { text: `${item.text.slice(0, Math.max(0, summaryReserve - 1)).trimEnd()}…` }
        : item)
      : summaryItems,
    summaryReserve,
  );
  const workFit = takeOldest(workItems, reserve(shares.work, present.work));
  const dialogueReserve = reserve(shares.dialogue, present.dialogue);
  // One long message must not push out the rest of the conversation, least of
  // all the newest ones. The person's words and the last replies get more room.
  const roomyLine = Math.max(MIN_LINE_CHARS, Math.floor(dialogueReserve * ROOMY_LINE_SHARE));
  const plainLine = Math.max(MIN_LINE_CHARS, Math.floor(dialogueReserve * PLAIN_LINE_SHARE));
  let shortenedMessages = 0;
  const dialogueItems = dialogueSource.map((line, index) => {
    const room = line.role === "user" || index >= dialogueSource.length - ROOMY_NEWEST_LINES ? roomyLine : plainLine;
    const text = shortenMiddle(line.text, room);
    if (text.length < line.text.length) shortenedMessages += 1;
    return { text: formatRecoveryDialogueLine({ ...line, text }) };
  });
  const dialogueFit = takeNewest(dialogueItems, dialogueReserve);

  let leftover = contentBudget
    - usedLength(intentFit.kept)
    - usedLength(durableFit.kept)
    - usedLength(summaryFit.kept)
    - usedLength(workFit.kept)
    - usedLength(dialogueFit.kept);

  leftover = fillNewest(dialogueFit, leftover);
  leftover = fillOldest(workFit, leftover);
  leftover = fillOldest(durableFit, leftover);
  leftover = fillOldest(summaryFit, leftover);
  leftover = fillOldest(intentFit, leftover);
  void leftover;

  const intentBody = joinItems(intentFit.kept);
  const durableBody = joinItems(durableFit.kept);
  const summaryBody = joinItems(summaryFit.kept);
  const workBody = joinItems(workFit.kept);
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
  if (workFit.omitted.length) sectionsCapped.push("work");
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
    workBody ? `${SECTION_WORK}\n${workBody}` : "",
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
      workBody ? `${SECTION_WORK}\n${workBody}` : "",
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
    shortenedMessages,
    sectionsCapped: capped,
    sectionChars: {
      intent: intentBody.length,
      durable: durableBody.length,
      summaries: summaryBody.length,
      work: workBody.length,
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
