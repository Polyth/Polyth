// The cheapest model a request can start a window with. Nothing is mapped from a
// static list of model ids: a price from the catalog decides when one exists,
// otherwise the words in the name do, so a harness update keeps working.
import { windowMetersModel, type LimitSourceRef } from "@polyth/usage/limit-sources";

export interface CatalogModel {
  harnessId?: string;
  providerID: string;
  modelID: string;
  resolvedModelID?: string;
  name: string;
  cost?: { input: number; output: number };
  capabilities?: string[];
  variants?: string[];
  connected?: boolean;
}

/** Not chat models, or not something a one-line request can run on. */
const NOT_CHAT = /\b(embed|embedding|image|imagen|tts|speech|audio|whisper|moderation|realtime|transcribe|video|veo)\b/i;
/** An alias that follows the account default says nothing about its price. */
const ACCOUNT_DEFAULT = /^(default|auto)$/i;
const TIERS: ReadonlyArray<readonly [RegExp, number]> = [
  // A free route may not count against the plan, so it may not start its window.
  [/\b(free)\b/i, 4],
  [/\b(nano|lite|mini|tiny|haiku|spark|small|micro|instant|gemma|luna)\b/i, 0],
  [/\b(flash|fast|turbo|speed|swift|air|oss)\b/i, 1],
  [/\b(pro|opus|max|ultra|plus|large|fable|mythos|thinking|deep|reasoner|sol)\b/i, 3],
];

const tierOf = (model: CatalogModel): number => {
  const text = `${model.modelID} ${model.resolvedModelID ?? ""} ${model.name}`.replace(/[-_./]/g, " ");
  return TIERS.find(([pattern]) => pattern.test(text))?.[1] ?? 2;
};

/** The version an id names: `gpt-5.6-luna` is [5, 6], `claude-haiku-4-5-20251001`
 *  [4, 5]. A date is not a version. */
const versionOf = (model: CatalogModel): number[] | undefined =>
  (model.resolvedModelID ?? model.modelID).match(/\d{1,2}(?:[.-]\d{1,2}(?!\d))*/)?.[0].split(/[.-]/).map(Number);

/** Within a tier an older model is the cheaper one. Unknown compares equal. */
const compareVersions = (a: CatalogModel, b: CatalogModel): number => {
  const left = versionOf(a);
  const right = versionOf(b);
  if (!left || !right) return 0;
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

/** A zero price may be a free route the plan does not meter, or just unreported,
 *  so only a positive one counts as a known price. Output weighs more in cost,
 *  but a window start is mostly input (the CLI's own system prompt). */
const priceOf = (model: CatalogModel): number | undefined => {
  const { input, output } = model.cost ?? {};
  return typeof input === "number" && typeof output === "number" && input + output > 0 ? input * 3 + output : undefined;
};

const usable = (model: CatalogModel): boolean =>
  model.connected !== false
  && !NOT_CHAT.test(`${model.modelID} ${model.name}`.replace(/[-_./]/g, " "))
  && !(model.capabilities?.includes("input:none") ?? false);

/** Candidates for a meter's window, cheapest first. */
export function rankModels(models: readonly CatalogModel[], source: LimitSourceRef, windowId: string): CatalogModel[] {
  const fit = models.filter((model) =>
    usable(model) && windowMetersModel(source, windowId, model.resolvedModelID ?? model.modelID));
  const named = fit.filter((model) => !ACCOUNT_DEFAULT.test(model.modelID));
  const rows = named.length ? named : fit;
  return rows
    .map((model, index) => ({ model, index, price: priceOf(model), tier: tierOf(model) }))
    .sort((a, b) =>
      (a.price ?? Infinity) - (b.price ?? Infinity)
      || a.tier - b.tier
      // An alias the harness keeps current stays valid when a dated id retires.
      || Number(Boolean(b.model.resolvedModelID)) - Number(Boolean(a.model.resolvedModelID))
      || compareVersions(a.model, b.model)
      || a.index - b.index)
    .map((row) => row.model);
}
