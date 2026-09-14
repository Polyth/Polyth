// The pure part of the command catalog: types plus the merge and precedence
// rules. The browser needs these to render and resolve `/name`, while the rest
// of this package reads the filesystem and shells out. Keeping them apart is
// what lets the web bundle import the rules without pulling `node:*` in.
import type { RuntimeCommandDescriptor } from "@polyth/contracts";

export type CommandScope = "user" | "project" | "builtin";

export interface ExtensionCommandBinding {
  packageId: string;
  contributionId: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
  agent?: string;
  model?: string;
  scope: CommandScope;
  id?: string;
  owner?: "builtin" | "user" | "project" | "extension";
  /** Host-owned invocation identity. Never contains executable extension code. */
  extension?: ExtensionCommandBinding;
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

export const extensionCommandId = (binding: ExtensionCommandBinding): string =>
  `extension:${encodeURIComponent(binding.packageId)}:${encodeURIComponent(binding.contributionId)}`;

export function parseExtensionCommandId(id: string): ExtensionCommandBinding | null {
  if (!id.startsWith("extension:")) return null;
  const parts = id.slice("extension:".length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const packageId = decodeURIComponent(parts[0]);
    const contributionId = decodeURIComponent(parts[1]);
    if (!packageId || !contributionId) return null;
    return { packageId, contributionId };
  } catch {
    return null;
  }
}

export const mergeCommandCatalog = (
  polyth: readonly SlashCommand[],
  native: readonly RuntimeCommandDescriptor[],
): CatalogCommand[] => [...polyth, ...native];

const COMMAND_SCOPE_RANK: Record<CommandScope | "extension" | "native", number> = {
  project: 0,
  user: 1,
  builtin: 2,
  extension: 3,
  native: 4,
};

/** Typed `/name` precedence when no explicit selection:
 * project > user > builtin > extension > native. Extensions never shadow
 * user/project files or Polyth built-ins merely by being installed. */
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
    const rank = polyth.owner === "extension"
      ? COMMAND_SCOPE_RANK.extension
      : COMMAND_SCOPE_RANK[polyth.scope] ?? COMMAND_SCOPE_RANK.builtin;
    if (!best || rank < best.rank) best = { item: polyth, rank };
  }
  return best?.item;
};
