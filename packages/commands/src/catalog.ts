// The pure part of the command catalog: types plus the merge and precedence
// rules. The browser needs these to render and resolve `/name`, while the rest
// of this package reads the filesystem and shells out. Keeping them apart is
// what lets the web bundle import the rules without pulling `node:*` in.
import type { RuntimeCommandDescriptor } from "@polyth/contracts";
import type { SkillScope } from "@polyth/contracts/capability-installations";

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
  owner?: "builtin" | "user" | "project";
  /** Presentation identity for commands that invoke a managed/discovered skill. */
  kind?: "command" | "skill";
  /** Original skill installation scope; command scope remains invocation precedence. */
  skillScope?: SkillScope;
}

export type CatalogCommand = SlashCommand | (RuntimeCommandDescriptor & {
  /** Copied from a portable skill fallback when a native alias replaces it. */
  kind?: "command" | "skill";
  skillScope?: SkillScope;
});

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

export const extensionCommandBinding = (
  command: Pick<SlashCommand, "id">,
): ExtensionCommandBinding | null => parseExtensionCommandId(command.id ?? "");

const SKILL_COMMAND_PREFIX = "skill:";
export const skillCommandId = (name: string): string =>
  `${SKILL_COMMAND_PREFIX}${encodeURIComponent(name)}`;
export const isSkillCommand = (command: Pick<SlashCommand, "id">): boolean =>
  command.id?.startsWith(SKILL_COMMAND_PREFIX) === true;

export const mergeCommandCatalog = (
  polyth: readonly SlashCommand[],
  native: readonly RuntimeCommandDescriptor[],
): CatalogCommand[] => {
  const nativeNames = new Set(native.flatMap((command) =>
    [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase())));
  const portableSkills = new Map(polyth.flatMap((command) =>
    isSkillCommand(command)
      ? [[command.name.toLowerCase(), command] as const]
      : []));
  return [
    ...polyth.filter((command) =>
      !isSkillCommand(command) || !nativeNames.has(command.name.toLowerCase())),
    ...native.map((command) => {
      const fallback = [command.name, ...(command.aliases ?? [])]
        .map((name) => portableSkills.get(name.toLowerCase()))
        .find((candidate) => candidate !== undefined);
      return fallback
        ? { ...command, kind: "skill" as const, ...(fallback.skillScope ? { skillScope: fallback.skillScope } : {}) }
        : command;
    }),
  ];
};

const COMMAND_SCOPE_RANK: Record<CommandScope | "extension" | "native" | "skill", number> = {
  user: 0,
  project: 1,
  builtin: 2,
  extension: 3,
  native: 4,
  skill: 5,
};

/** Typed `/name` precedence when no explicit selection:
 * user (mine) > project (shared) > builtin > extension > native > portable skill fallback.
 * Extension and skill transports stay normal SlashCommand DTOs; host-reserved
 * ids carry invocation identity without widening legacy owner vocabularies. */
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
    const rank = extensionCommandBinding(polyth)
      ? COMMAND_SCOPE_RANK.extension
      : isSkillCommand(polyth)
        ? COMMAND_SCOPE_RANK.skill
        : COMMAND_SCOPE_RANK[polyth.scope] ?? COMMAND_SCOPE_RANK.builtin;
    if (!best || rank < best.rank) best = { item: polyth, rank };
  }
  return best?.item;
};
