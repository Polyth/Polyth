import type { RuntimeCommandDescriptor } from "@polyth/contracts";

type PolythCatalogCommand = {
  name: string;
  scope: "user" | "project" | "builtin";
};

type CatalogEntry = PolythCatalogCommand | RuntimeCommandDescriptor;

export const mergeCommandCatalog = (
  polyth: readonly PolythCatalogCommand[],
  native: readonly RuntimeCommandDescriptor[],
): CatalogEntry[] => [...polyth, ...native];

const COMMAND_SCOPE_RANK: Record<PolythCatalogCommand["scope"] | "native", number> = {
  project: 0,
  user: 1,
  builtin: 2,
  native: 3,
};

/** Typed `/name` precedence when no explicit selection: project > user > builtin > native. */
export const commandPrecedence = (
  name: string,
  catalog: readonly CatalogEntry[],
): CatalogEntry | undefined => {
  const normalized = name.replace(/^\//, "").toLowerCase();
  let best: { item: CatalogEntry; rank: number } | undefined;
  for (const cmd of catalog) {
    if ("owner" in cmd && cmd.owner === "native") {
      const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
      if (!names.includes(normalized)) continue;
      const rank = COMMAND_SCOPE_RANK.native;
      if (!best || rank < best.rank) best = { item: cmd, rank };
      continue;
    }
    const polyth = cmd as PolythCatalogCommand;
    if (polyth.name.toLowerCase() !== normalized) continue;
    const rank = COMMAND_SCOPE_RANK[polyth.scope] ?? COMMAND_SCOPE_RANK.builtin;
    if (!best || rank < best.rank) best = { item: polyth, rank };
  }
  return best?.item;
};
