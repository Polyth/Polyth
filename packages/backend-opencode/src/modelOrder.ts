import type { ModelDescriptor } from "@polyth/contracts";

/** The key OpenCode serves its own zero-cost models with when nobody signed
 *  in (V2 `settings.apiKey`, 1.x `options.apiKey`). A real credential is
 *  never this literal, and Polyth only compares against it — it never keeps
 *  or forwards whatever else a provider reports there. */
export const OPENCODE_PUBLIC_API_KEY = "public";

/** OpenCode's own provider. Its zero-cost models stay "free tier" even when
 *  the account is signed in, so a paid model is still offered first. */
const OPENCODE_PROVIDER_ID = "opencode";

const isZeroCost = (model: ModelDescriptor): boolean =>
  model.cost !== undefined && model.cost.input === 0 && model.cost.output === 0;

/**
 * Order the catalog the way a default should be picked: models from a provider
 * the user configured with real credentials first, then OpenCode's free
 * no-registration models, then anything not connected. Ties keep OpenCode's
 * own order. Consumers that fall back to "the first available model" (the
 * composer, the global default) therefore choose a paid model whenever one is
 * configured and a free one only when nothing else is. An explicit user or
 * project default is applied before that fallback and is unaffected.
 */
export const orderOpenCodeModels = <T extends ModelDescriptor>(
  models: readonly T[],
  publicProviders: ReadonlySet<string>,
): T[] => {
  const rank = (model: T): number => {
    if (model.connected === false) return 2;
    if (publicProviders.has(model.providerID)) return 1;
    if (model.providerID === OPENCODE_PROVIDER_ID && isZeroCost(model)) return 1;
    return 0;
  };
  return models
    .map((model, index) => ({ model, index, rank: rank(model) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
};
