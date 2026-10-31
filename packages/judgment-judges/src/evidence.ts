// Bounded evidence about one completed turn, derived only from canonical
// session events. Agent and tool output is data: it is clipped, redacted and
// never interpreted as instructions. Browser-safe and pure.
import type { SessionEvent } from "@polyth/contracts";
import { KEEP_ALIVE_PROMPT, type EvidencePick } from "./types.ts";

export interface TurnEvidence {
  /** Sequence of the completed `turn/stopped` this evidence belongs to. */
  turnSeq: number;
  request: string;
  answer: string;
  commands: Array<{ command: string; status: "ok" | "error" | "unknown" }>;
  changedFiles: string[];
  openTodos: string[];
}

const SHELL_TOOLS = /^(bash|shell|sh|run_shell|runshell|shell_command|exec|execute|command|terminal|run_command|local_shell)$/i;
const EDIT_TOOLS = /(edit|write|patch|create_file|str_replace|multiedit|apply_diff|replace)/i;
const MAX_COMMANDS = 20, MAX_FILES = 30, MAX_TODOS = 20;

// Credentials never become evidence, even when an agent printed one.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const KEYED_SECRET = /\b([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z_]*)\s*[:=]\s*["']?[^\s"']{4,}/gi;
export function redact(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.replace(KEYED_SECRET, (_match, name: string) => `${name}=[redacted]`);
}
/** Keeps the start (requests state intent first). */
export const clipHead = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
/** Keeps the end (answers conclude last). */
export const clipTail = (value: string, max: number): string => value.length <= max ? value : `…${value.slice(value.length - Math.max(0, max - 1))}`;

const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const commandOf = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.script;
  return Array.isArray(command) ? command.filter((part) => typeof part === "string").join(" ") || undefined : str(command);
};
const filesOf = (tool: string, input: unknown): string[] => {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const direct = [record.filePath, record.file_path, record.path, record.filename, record.target_file].map(str).filter((v): v is string => !!v);
  const patch = str(record.patch) ?? str(record.input) ?? (/patch/i.test(tool) ? str(record.content) : undefined);
  const fromPatch = patch ? [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim()) : [];
  return [...direct, ...fromPatch];
};

/** A keep-alive Polyth sent to hold the prompt cache: not the person's request. */
export const isKeepAlive = (event: SessionEvent | undefined): boolean =>
  event?.type === "user/message" && (event.data as { hiddenUserMessage?: unknown }).hiddenUserMessage === true
    && (event.data as { text?: unknown }).text === KEEP_ALIVE_PROMPT;
/** A user message that opens a turn worth judging. */
const isRequest = (event: SessionEvent): boolean => event.type === "user/message" && !event.ignorable && !isKeepAlive(event);
/** A fixed message a judge sent for its owner. */
export const isJudgeMessage = (event: SessionEvent | undefined): boolean =>
  event?.type === "user/message" && (event.data as { author?: { via?: unknown } }).author?.via === "judge";
/** Something the person wrote: not a judge's message, a hidden wake or resend, or a keep-alive. */
export const isPersonRequest = (event: SessionEvent): boolean => isRequest(event) && !isJudgeMessage(event)
  && (event.data as { hiddenUserMessage?: unknown }).hiddenUserMessage !== true;

/** Judge messages since the person last wrote: the rounds an autopilot has already taken. */
export function judgeRounds(events: readonly SessionEvent[]): number {
  let rounds = 0;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (isJudgeMessage(event)) rounds++;
    else if (isPersonRequest(event)) break;
  }
  return rounds;
}

/** The request a turn works on: the person's latest message at or before it, never a judge's own nudge. */
const requestText = (events: readonly SessionEvent[], userIndex: number): string => {
  for (let index = userIndex; index >= 0; index--) {
    const event = events[index]!;
    if (!isPersonRequest(event)) continue;
    const data = event.data as { raw?: unknown; text?: unknown };
    return redact(str(data.raw) ?? str(data.text) ?? "");
  }
  const data = events[userIndex]?.data as { raw?: unknown; text?: unknown } | undefined;
  return redact(str(data?.raw) ?? str(data?.text) ?? "");
};

/**
 * Evidence of the latest turn when it completed normally; undefined when the
 * log does not end with a completed turn (aborted, failed, still running).
 */
export function latestTurnEvidence(events: readonly SessionEvent[]): TurnEvidence | undefined {
  const lastUser = events.findLastIndex(isRequest);
  if (lastUser < 0) return undefined;
  return turnEvidenceAt(events, lastUser);
}

/** Evidence of the turn opened by the user message at `userIndex`, if it completed. */
export function turnEvidenceAt(events: readonly SessionEvent[], userIndex: number): TurnEvidence | undefined {
  const user = events[userIndex];
  if (!user || user.type !== "user/message") return undefined;
  const nextUser = events.findIndex((event, index) => index > userIndex && event.type === "user/message" && !event.ignorable);
  const tail = events.slice(userIndex + 1, nextUser < 0 ? undefined : nextUser);
  const stopped = tail.findLast((event) => event.type === "turn/stopped");
  if (!stopped || (stopped.data as { reason?: unknown }).reason !== "completed") return undefined;
  return collectTurn(events, userIndex, nextUser, tail, stopped.seq);
}

/**
 * Evidence of the latest turn as it stands, finished or not: a permission
 * request arrives mid-turn and a usage limit ends one with an error.
 */
export function currentTurnEvidence(events: readonly SessionEvent[]): TurnEvidence | undefined {
  const userIndex = events.findLastIndex(isRequest);
  if (userIndex < 0) return undefined;
  const tail = events.slice(userIndex + 1);
  return collectTurn(events, userIndex, -1, tail, events.at(-1)!.seq);
}

function collectTurn(events: readonly SessionEvent[], userIndex: number, nextUser: number, tail: readonly SessionEvent[], turnSeq: number): TurnEvidence {
  const answer = tail.findLast((event) => event.type === "assistant/message" && !event.ignorable && str((event.data as { text?: unknown }).text));
  const outcome = new Map<string, "ok" | "error">();
  for (const event of tail) {
    const callId = str((event.data as { callId?: unknown }).callId);
    if (!callId) continue;
    if (event.type === "tool/result") outcome.set(callId, "ok");
    if (event.type === "tool/error") outcome.set(callId, "error");
  }
  const commands: TurnEvidence["commands"] = [];
  const files = new Set<string>();
  const seenCalls = new Set<string>();
  for (const event of tail) {
    if (event.type !== "tool/call" && event.type !== "tool/started" && event.type !== "tool/result" && event.type !== "tool/error") continue;
    const d = event.data as { callId?: unknown; tool?: unknown; input?: unknown };
    const callId = str(d.callId) ?? `seq-${event.seq}`;
    const tool = str(d.tool) ?? "";
    if (seenCalls.has(callId) || !d.input) continue;
    seenCalls.add(callId);
    const command = SHELL_TOOLS.test(tool) ? commandOf(d.input) : undefined;
    if (command && commands.length < MAX_COMMANDS) commands.push({ command: clipHead(redact(command), 300), status: outcome.get(callId) ?? "unknown" });
    if (EDIT_TOOLS.test(tool)) for (const file of filesOf(tool, d.input)) if (files.size < MAX_FILES) files.add(clipHead(file, 300));
  }
  // The latest todo snapshot up to the end of this turn is the current plan.
  const end = nextUser < 0 ? events.length : nextUser;
  const snapshot = events.slice(0, end).findLast((event) => event.type === "task/snapshot");
  const items = (snapshot?.data as { items?: unknown } | undefined)?.items;
  const openTodos = Array.isArray(items) ? items
    .filter((item): item is { text: string; status: string } => !!item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
      && ["pending", "active"].includes((item as { status?: unknown }).status as string))
    .slice(0, MAX_TODOS).map((item) => clipHead(redact(item.text), 200)) : [];
  return {
    turnSeq,
    request: requestText(events, userIndex),
    answer: redact(str((answer?.data as { text?: unknown } | undefined)?.text) ?? ""),
    commands, changedFiles: [...files], openTodos,
  };
}

/** Completed turns, newest first, at most `limit`. */
export function completedTurns(events: readonly SessionEvent[], limit: number): TurnEvidence[] {
  const out: TurnEvidence[] = [];
  for (let index = events.length - 1; index >= 0 && out.length < limit; index--) {
    const event = events[index]!;
    if (!isRequest(event)) continue;
    const turn = turnEvidenceAt(events, index);
    if (turn) out.push(turn);
  }
  return out;
}

/** The permission request a judge decides on, from its canonical event. */
export interface PermissionEvidence {
  requestId: string;
  permission: string;
  tool?: string;
  title: string;
  lines: string[];
  risk?: string;
  reasons: string[];
  /** No answer, expiry or cancellation follows it. */
  open: boolean;
}

const CLOSING = new Set(["permission/resolved", "permission/expired"]);
/** No answer, expiry or cancellation follows the request at `index`. */
const openAt = (events: readonly SessionEvent[], index: number, requestId: string): boolean =>
  !events.slice(index + 1).some((event) => CLOSING.has(event.type) && (event.data as { requestId?: unknown }).requestId === requestId);

/** A parent's still-open mirror of the request a delegated child is waiting on. */
export function mirroredRequestOpen(events: readonly SessionEvent[], requestId: string, childSessionId: string): boolean {
  const index = events.findLastIndex((event) => event.type === "permission/requested"
    && (event.data as { requestId?: unknown }).requestId === requestId
    && (event.data as { sourceSessionId?: unknown }).sourceSessionId === childSessionId);
  return index >= 0 && openAt(events, index, requestId);
}

/** The request with `requestId`, or undefined when the log does not hold it. Lines are the server's redacted preview. */
export function permissionEvidence(events: readonly SessionEvent[], requestId: string): PermissionEvidence | undefined {
  const index = events.findLastIndex((event) => event.type === "permission/requested"
    && (event.data as { requestId?: unknown }).requestId === requestId);
  if (index < 0) return undefined;
  const data = events[index]!.data as { permission?: unknown; tool?: unknown; preview?: { title?: unknown; lines?: unknown; risk?: unknown; reasons?: unknown } };
  const preview = data.preview ?? {};
  const permission = str(data.permission) ?? "unknown";
  const open = openAt(events, index, requestId);
  return {
    requestId, permission, ...(str(data.tool) ? { tool: clipHead(str(data.tool)!, 120) } : {}),
    title: clipHead(redact(str(preview.title) ?? permission), 200),
    lines: Array.isArray(preview.lines) ? preview.lines.filter((line): line is string => typeof line === "string").slice(0, 8).map((line) => clipHead(redact(line), 300)) : [],
    ...(typeof preview.risk === "string" ? { risk: preview.risk } : {}),
    reasons: Array.isArray(preview.reasons) ? preview.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 8) : [],
    open,
  };
}

const describePermission = (request: PermissionEvidence): string => [
  `Asks for: ${request.title}`,
  ...(request.risk ? [`Risk: ${request.risk}${request.reasons.length ? ` (${request.reasons.join(", ")})` : ""}`] : []),
  ...request.lines,
].join("\n");

const joinBounded = (lines: string[], max: number) => clipHead(lines.join("\n"), max);
/** The state a user-defined judge sends: only its picks, each within its own character cap. */
export function pickEvidence(turn: TurnEvidence, picks: ReadonlyArray<{ pick: EvidencePick; maxChars: number }>, request?: PermissionEvidence): Record<string, string> {
  const state: Record<string, string> = {};
  for (const { pick, maxChars } of picks) {
    if (pick === "permission-request") { if (request) state.permissionRequest = clipHead(describePermission(request), maxChars); continue; }
    if (pick === "last-request") state.lastRequest = clipHead(turn.request, maxChars);
    else if (pick === "last-answer") state.lastAnswer = clipTail(turn.answer, maxChars);
    else if (pick === "commands-run") state.commandsRun = joinBounded(turn.commands.map((entry) => `[${entry.status}] ${entry.command}`), maxChars) || "(none)";
    else if (pick === "changed-files") state.changedFiles = joinBounded(turn.changedFiles, maxChars) || "(none)";
    else if (pick === "open-todos") state.openTodos = joinBounded(turn.openTodos, maxChars) || "(none)";
  }
  return state;
}
