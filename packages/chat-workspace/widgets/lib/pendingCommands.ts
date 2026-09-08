import type { ContextBundleDto } from "@polyth/contracts";

export type ChatWorkspacePendingCommand =
  | {
    kind: "show-prepared-bundle";
    bundle: ContextBundleDto;
    presetId: string;
    presetLabel: string;
    instruction: string;
    presetSourceIds: string[];
  }
  | { kind: "set-bundle"; bundle: ContextBundleDto }
  | { kind: "open-drawer"; presetId: string; presetLabel: string; instruction: string; presetSourceIds: string[] }
  | { kind: "open-paste" }
  | { kind: "copy-bundle" }
  | { kind: "notify"; message: string };

export type ChatWorkspaceCommandContext = {
  projectId: string | null;
  sessionId: string | null;
};

/** Result of offering a command to the live consumer or the queue. */
export type ChatWorkspaceCommandDelivery = "executed" | "queued";
export type CopyContextResult = ChatWorkspaceCommandDelivery | "unavailable";

type QueuedCommand = ChatWorkspacePendingCommand & ChatWorkspaceCommandContext & { queuedAt: number };

type CommandConsumer = {
  projectId: string;
  sessionId: string | null;
  apply(command: ChatWorkspacePendingCommand): void;
};

const MAX_QUEUED_COMMANDS = 16;
const QUEUED_COMMAND_TTL_MS = 10 * 60_000;

const queue: QueuedCommand[] = [];
let consumer: CommandConsumer | null = null;

function commandSessionId(command: ChatWorkspacePendingCommand): string | null {
  if (command.kind === "show-prepared-bundle" || command.kind === "set-bundle") {
    return command.bundle.sessionId;
  }
  return null;
}

function sessionScoped(command: ChatWorkspacePendingCommand): boolean {
  return command.kind === "show-prepared-bundle"
    || command.kind === "set-bundle"
    || command.kind === "open-drawer"
    || command.kind === "copy-bundle"
    || command.kind === "open-paste";
}

function pruneQueue(now = Date.now()): void {
  const kept = queue.filter((item) => now - item.queuedAt < QUEUED_COMMAND_TTL_MS);
  const overflow = Math.max(0, kept.length - MAX_QUEUED_COMMANDS);
  if (overflow > 0) kept.splice(0, overflow);
  queue.length = 0;
  queue.push(...kept);
}

function matchesContext(
  item: ChatWorkspaceCommandContext,
  target: CommandConsumer,
  command: ChatWorkspacePendingCommand,
): boolean {
  if (item.projectId !== target.projectId) return false;
  if (!sessionScoped(command)) return true;
  const expected = item.sessionId ?? commandSessionId(command);
  if (!expected) return target.sessionId === null;
  return expected === target.sessionId;
}

function drainForConsumer(target: CommandConsumer): void {
  pruneQueue();
  if (queue.length === 0) return;
  const kept: QueuedCommand[] = [];
  for (const item of queue) {
    const { projectId, sessionId, queuedAt: _queuedAt, ...command } = item;
    if (matchesContext({ projectId, sessionId }, target, command)) {
      target.apply(command);
    } else {
      kept.push(item);
    }
  }
  queue.length = 0;
  queue.push(...kept);
}

export function registerChatWorkspaceCommandConsumer(next: CommandConsumer | null): void {
  consumer = next;
  if (next) drainForConsumer(next);
}

export function enqueueChatWorkspaceCommand(
  command: ChatWorkspacePendingCommand,
  context: ChatWorkspaceCommandContext,
): ChatWorkspaceCommandDelivery {
  pruneQueue();
  if (consumer && context.projectId === consumer.projectId && matchesContext(context, consumer, command)) {
    consumer.apply(command);
    return "executed";
  }
  queue.push({ ...command, ...context, queuedAt: Date.now() });
  pruneQueue();
  return "queued";
}

/** Test helper — clears module state between cases. */
export function resetChatWorkspaceCommands(): void {
  queue.length = 0;
  consumer = null;
}
