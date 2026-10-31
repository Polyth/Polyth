// `/compact` is a Polyth host action, not a model prompt. The active runtime's
// native compaction produces a durable `session/compacted` marker that the
// timeline renders as the context-compacted block. Sending the builtin prompt
// instead echoed the command, spent a thinking turn, and answered in prose.
import { commandPrecedence, type CatalogCommand } from "@polyth/commands/catalog";

export const COMPACT_COMMAND_NAME = "compact";

const isBuiltinCompact = (command: CatalogCommand | undefined): boolean =>
  !!command
  && !("invocation" in command)
  && command.name.toLowerCase() === COMPACT_COMMAND_NAME
  && command.scope === "builtin";

const commandNames = (command: CatalogCommand): string[] =>
  [command.name, ...("aliases" in command ? command.aliases ?? [] : [])];

/** Resolve the exact `/compact` builtin selected or typed. A project/user
 *  override or a native runtime command with the same name keeps its own
 *  transport; only the builtin host action is intercepted. Extra lines are
 *  real prompt text, never compaction arguments, so they keep the normal path. */
export function isCompactCommand(
  text: string,
  catalog: readonly CatalogCommand[],
  selected?: CatalogCommand,
): boolean {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^\/([A-Za-z0-9_-]+)[ \t]*$/);
  if (!match || match[1]!.toLowerCase() !== COMPACT_COMMAND_NAME) return false;
  if (text.slice(firstLine.length).trim() !== "") return false;
  const selectedMatches = selected
    && commandNames(selected).some((name) => name.toLowerCase() === COMPACT_COMMAND_NAME);
  return selectedMatches
    ? isBuiltinCompact(selected)
    : isBuiltinCompact(commandPrecedence(COMPACT_COMMAND_NAME, catalog));
}

export type CompactBlockReason = "new-chat" | "empty";

/** The chat holds nothing a runtime could compact: no active session, no native
 *  context binding, or no admitted conversation yet. */
export function compactBlockReason(input: {
  sessionId: string | null;
  backendSessionId?: string;
  hasConversation: boolean;
}): CompactBlockReason | null {
  if (!input.sessionId) return "new-chat";
  if (!input.backendSessionId || !input.hasConversation) return "empty";
  return null;
}

/** The server's refusal when a session never produced native context. */
export function isNothingToCompactError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  return /no native context to compact/i.test(message);
}
