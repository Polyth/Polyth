// The pure part of the command catalog: types plus the merge and precedence
// rules. The browser needs these to render and resolve `/name`, while the rest
// of this package reads the filesystem and shells out. Keeping them apart is
// what lets the web bundle import the rules without pulling `node:*` in.
import type { RuntimeCommandDescriptor } from "@polyth/contracts";

export type CommandScope = "user" | "project" | "builtin";

export interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
  agent?: string;
  model?: string;
  scope: CommandScope;
  id?: string;
  owner?: "builtin" | "user" | "project";
}

export type CatalogCommand = SlashCommand | RuntimeCommandDescriptor;

export interface Snippet {
  alias: string;
  text: string;
  scope: CommandScope;
}

export interface CommandList {
  commands: SlashCommand[];
  snippets: Snippet[];
}

export const mergeCommandCatalog = (
  polyth: readonly SlashCommand[],
  native: readonly RuntimeCommandDescriptor[],
): CatalogCommand[] => [...polyth, ...native];

const COMMAND_SCOPE_RANK: Record<CommandScope | "native", number> = {
  project: 0,
  user: 1,
  builtin: 2,
  native: 3,
};

/** Typed `/name` precedence when no explicit selection: project > user > builtin > native. */
export const commandPrecedence = (
  name: string,
  catalog: readonly CatalogCommand[],
): CatalogCommand | undefined => {
  const normalized = name.replace(/^\//, "").toLowerCase();
  let best: { item: CatalogCommand; rank: number } | undefined;
  for (const cmd of catalog) {
    if ("owner" in cmd && cmd.owner === "native") {
      const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
      if (!names.includes(normalized)) continue;
      const rank = COMMAND_SCOPE_RANK.native;
      if (!best || rank < best.rank) best = { item: cmd, rank };
      continue;
    }
    const polyth = cmd as SlashCommand;
    if (polyth.name.toLowerCase() !== normalized) continue;
    const rank = COMMAND_SCOPE_RANK[polyth.scope] ?? COMMAND_SCOPE_RANK.builtin;
    if (!best || rank < best.rank) best = { item: polyth, rank };
  }
  return best?.item;
};
