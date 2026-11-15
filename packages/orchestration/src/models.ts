// Model picker options: the live catalog joined with favorites, use and
// harness availability. Pure and browser-safe.
import { modelKey, type ModelOption, type ModelOptionsResponse } from "./contracts.ts";
import { tierOf } from "./recommend.ts";

export { tierOf };

/** The fields of a catalog row this package reads (a `ModelDescriptor` subset). */
export interface CatalogRow {
  harnessId?: string;
  providerID: string;
  modelID: string;
  name: string;
  providerName?: string;
  context?: number;
  capabilities?: string[];
  connected?: boolean;
}

export interface UsedRow {
  harnessId: string;
  providerID: string;
  modelID: string;
  turns: number;
  runs?: string;
}

export function buildModelOptions(input: {
  catalog: readonly CatalogRow[] | undefined;
  favorites: readonly string[];
  used: readonly UsedRow[];
  available: (harnessId: string) => boolean;
}): ModelOptionsResponse {
  if (!input.catalog) return { models: [], catalogUnavailable: true };
  const favoriteIndex = new Map<string, number>();
  input.favorites.forEach((key, index) => { if (!favoriteIndex.has(key)) favoriteIndex.set(key, index); });
  const used = new Map<string, UsedRow>();
  for (const row of input.used) used.set(modelKey(row), row);

  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const row of input.catalog) {
    if (!row.harnessId || row.connected === false) continue;
    const key = modelKey({ harnessId: row.harnessId, providerID: row.providerID, modelID: row.modelID });
    if (seen.has(key)) continue;
    seen.add(key);
    const index = favoriteIndex.get(key);
    const usage = used.get(key);
    models.push({
      key,
      harnessId: row.harnessId,
      providerID: row.providerID,
      modelID: row.modelID,
      name: row.name || row.modelID,
      ...(row.providerName ? { providerName: row.providerName } : {}),
      ...(usage?.runs ? { runs: usage.runs } : {}),
      favorite: index !== undefined,
      ...(index !== undefined ? { favoriteIndex: index } : {}),
      turns: usage?.turns ?? 0,
      vision: row.capabilities?.includes("input:image") ?? false,
      ...(row.context ? { context: row.context } : {}),
      tier: tierOf(row.name ?? "", row.modelID),
      available: input.available(row.harnessId),
    });
  }
  const group = (option: ModelOption): number => (option.favorite ? 0 : option.turns > 0 ? 1 : 2);
  models.sort((a, b) =>
    group(a) - group(b)
    || (group(a) === 0 ? (a.favoriteIndex ?? 0) - (b.favoriteIndex ?? 0) : 0)
    || (group(a) === 1 ? b.turns - a.turns : 0)
    || a.harnessId.localeCompare(b.harnessId)
    || a.name.localeCompare(b.name));
  return { models };
}
