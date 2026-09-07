// Narrow owned slice for Polyth-managed custom providers. Unknown sibling
// providers and unowned fields on the target entry are preserved. API keys
// never land here — they go through OpenCode /auth.
//
// OpenCode v1 provider fields we may write: npm, name, options.{baseURL,headers},
// models. Polyth ownership/authMode live in Polyth persistence, not here.
//
// Boundary: OpenCode persists `options.headers` in plaintext in opencode.json.
// Polyth never returns those values on public DTOs, never logs them, and
// redacts them from errors. It does not invent a second secret store for
// header values; API keys use OpenCode /auth when the user chooses api-key mode.

import {
  CUSTOM_PROVIDER_ADAPTERS,
  type CustomProviderApply,
  type CustomProviderHeaderPatch,
  type CustomProviderModelApply,
  type CustomProviderProtocol,
  type ProviderInspect,
} from "@polyth/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringHeaders = (raw: unknown): Record<string, string> | undefined => {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
};

export function adapterForProtocol(protocol: CustomProviderProtocol): string {
  return CUSTOM_PROVIDER_ADAPTERS[protocol];
}

export function protocolFromNpm(npm: unknown): CustomProviderProtocol | undefined {
  if (npm === CUSTOM_PROVIDER_ADAPTERS["openai-responses"]) return "openai-responses";
  if (npm === CUSTOM_PROVIDER_ADAPTERS["openai-compatible"]) return "openai-compatible";
  return undefined;
}

/** True when the stanza uses a known custom adapter. This is NOT ownership. */
export function isCustomProviderEntry(entry: unknown): boolean {
  return protocolFromNpm(asRecord(entry)?.npm) !== undefined;
}

export function applyHeaderPatch(
  existing: Record<string, string> | undefined,
  patch: CustomProviderHeaderPatch | undefined,
): Record<string, string> | undefined {
  if (!patch) return existing && Object.keys(existing).length ? { ...existing } : undefined;
  let next: Record<string, string> = patch.clear ? {} : { ...(existing ?? {}) };
  const unset = new Set((patch.unset ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (unset.size) {
    next = Object.fromEntries(
      Object.entries(next).filter(([name]) => !unset.has(name.toLowerCase())),
    );
  }
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    const name = key.trim();
    if (!name) continue;
    next[name] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

function modelApplyToConfig(model: CustomProviderModelApply): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (model.name?.trim()) out.name = model.name.trim();
  const limit: Record<string, unknown> = {};
  if (typeof model.context === "number" && Number.isFinite(model.context) && model.context > 0) {
    limit.context = model.context;
  }
  if (typeof model.output === "number" && Number.isFinite(model.output) && model.output > 0) {
    limit.output = model.output;
  }
  if (Object.keys(limit).length) out.limit = limit;
  return out;
}

function mergeModels(
  existingRaw: unknown,
  desired: Record<string, CustomProviderModelApply> | undefined,
): Record<string, unknown> {
  const existing = asRecord(existingRaw) ?? {};
  const models: Record<string, unknown> = { ...existing };
  if (!desired) return models;
  for (const [id, spec] of Object.entries(desired)) {
    if (!id.trim()) continue;
    const prior = asRecord(models[id]) ?? {};
    const next = { ...prior, ...modelApplyToConfig(spec) };
    if (Object.keys(next).length === 0) next.name = id;
    models[id] = next;
  }
  return models;
}

/** Patch one provider id. Returns the next `provider` map (or undefined if empty). */
export function mergeCustomProvider(
  providerRaw: unknown,
  input: CustomProviderApply,
): Record<string, unknown> {
  const provider: Record<string, unknown> =
    asRecord(providerRaw) ? { ...asRecord(providerRaw)! } : {};
  const current = asRecord(provider[input.id]) ?? {};
  const optionsRaw = asRecord(current.options) ?? {};
  const options: Record<string, unknown> = { ...optionsRaw };
  options.baseURL = input.baseURL;
  const headers = applyHeaderPatch(stringHeaders(optionsRaw.headers), input.headerPatch);
  if (headers) options.headers = headers;
  else delete options.headers;

  const models = mergeModels(current.models, input.models);
  const next: Record<string, unknown> = {
    ...current,
    npm: adapterForProtocol(input.protocol),
    name: input.name,
    options,
  };
  // Never persist Polyth bookkeeping on the OpenCode stanza.
  delete next.polyth;
  if (Object.keys(models).length) next.models = models;
  provider[input.id] = next;
  return provider;
}

export function dropCustomProvider(
  providerRaw: unknown,
  id: string,
): Record<string, unknown> | undefined {
  const provider = asRecord(providerRaw);
  if (!provider || !(id in provider)) return provider ? { ...provider } : undefined;
  const next = { ...provider };
  delete next[id];
  return Object.keys(next).length ? next : undefined;
}

/** Merge-only: add/refresh discovered ids, never delete existing models. */
export function reconcileDiscoveredModels(
  existingRaw: unknown,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
): Record<string, unknown> {
  const existing = asRecord(existingRaw) ?? {};
  const models: Record<string, unknown> = { ...existing };
  for (const model of discovered) {
    const id = model.id.trim();
    if (!id) continue;
    const prior = asRecord(models[id]) ?? {};
    const next: Record<string, unknown> = { ...prior };
    if (model.name && !prior.name) next.name = model.name;
    if (Object.keys(next).length === 0 && model.name) next.name = model.name;
    models[id] = Object.keys(next).length ? next : (model.name ? { name: model.name } : {});
  }
  return models;
}

export function mergeDiscoveredIntoProvider(
  providerRaw: unknown,
  id: string,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
): Record<string, unknown> {
  const provider: Record<string, unknown> =
    asRecord(providerRaw) ? { ...asRecord(providerRaw)! } : {};
  const current = asRecord(provider[id]);
  if (!current) return provider;
  const models = reconcileDiscoveredModels(current.models, discovered);
  const next: Record<string, unknown> = { ...current, models };
  delete next.polyth;
  provider[id] = next;
  return provider;
}

export function addManualModelIntoProvider(
  providerRaw: unknown,
  id: string,
  model: CustomProviderModelApply & { id: string },
): Record<string, unknown> {
  const provider: Record<string, unknown> =
    asRecord(providerRaw) ? { ...asRecord(providerRaw)! } : {};
  const current = asRecord(provider[id]);
  if (!current) return provider;
  const modelId = model.id.trim();
  if (!modelId) return provider;
  const models = mergeModels(current.models, {
    [modelId]: {
      ...(model.name ? { name: model.name } : {}),
      ...(typeof model.context === "number" ? { context: model.context } : {}),
      ...(typeof model.output === "number" ? { output: model.output } : {}),
    },
  });
  const next: Record<string, unknown> = { ...current, models };
  delete next.polyth;
  provider[id] = next;
  return provider;
}

/** Remove one configured model id. Sibling models and unknown fields stay. */
export function dropConfiguredModelFromProvider(
  providerRaw: unknown,
  id: string,
  modelId: string,
): Record<string, unknown> {
  const provider: Record<string, unknown> =
    asRecord(providerRaw) ? { ...asRecord(providerRaw)! } : {};
  const current = asRecord(provider[id]);
  if (!current) return provider;
  const trimmed = modelId.trim();
  if (!trimmed) return provider;
  const existing = asRecord(current.models);
  if (!existing || !(trimmed in existing)) return provider;
  const models: Record<string, unknown> = { ...existing };
  delete models[trimmed];
  const next: Record<string, unknown> = { ...current };
  delete next.polyth;
  if (Object.keys(models).length) next.models = models;
  else delete next.models;
  provider[id] = next;
  return provider;
}

export type StagedProviderOp =
  | { kind: "upsert"; input: CustomProviderApply }
  | { kind: "remove"; id: string }
  | { kind: "mergeDiscovered"; id: string; discovered: ReadonlyArray<{ id: string; name?: string }> }
  | { kind: "addManual"; id: string; model: CustomProviderModelApply & { id: string } }
  | { kind: "dropModel"; id: string; modelId: string };

export function applyProviderOps(
  providerRaw: unknown,
  ops: readonly StagedProviderOp[],
): Record<string, unknown> | undefined {
  let provider: unknown = asRecord(providerRaw) ? { ...asRecord(providerRaw)! } : {};
  for (const op of ops) {
    if (op.kind === "upsert") provider = mergeCustomProvider(provider, op.input);
    else if (op.kind === "remove") provider = dropCustomProvider(provider, op.id);
    else if (op.kind === "mergeDiscovered") {
      provider = mergeDiscoveredIntoProvider(provider, op.id, op.discovered);
    } else if (op.kind === "addManual") {
      provider = addManualModelIntoProvider(provider, op.id, op.model);
    } else {
      provider = dropConfiguredModelFromProvider(provider, op.id, op.modelId);
    }
  }
  const rec = asRecord(provider);
  return rec && Object.keys(rec).length ? rec : undefined;
}

export function inspectProviderEntry(
  id: string,
  entry: unknown,
  overlay: { owned?: boolean; authMode?: ProviderInspect["authMode"] } = {},
): ProviderInspect | undefined {
  const rec = asRecord(entry);
  if (!rec) return undefined;
  const options = asRecord(rec.options) ?? {};
  const headers = stringHeaders(options.headers);
  const headerNames = headers ? Object.keys(headers) : [];
  const models = asRecord(rec.models);
  const modelIDs = models ? Object.keys(models) : [];
  const protocol = protocolFromNpm(rec.npm);
  return {
    id,
    name: typeof rec.name === "string" && rec.name ? rec.name : id,
    owned: overlay.owned === true,
    ...(protocol ? { protocol } : {}),
    ...(overlay.authMode ? { authMode: overlay.authMode } : {}),
    ...(typeof options.baseURL === "string" ? { baseURL: options.baseURL } : {}),
    ...(headers ? { headers } : {}),
    headerNames,
    modelIDs,
  };
}

export function projectConfig(
  physical: Record<string, unknown>,
  ops: readonly StagedProviderOp[],
): Record<string, unknown> {
  if (ops.length === 0) return physical;
  const provider = applyProviderOps(physical.provider, ops);
  const next: Record<string, unknown> = { ...physical };
  if (provider) next.provider = provider;
  else delete next.provider;
  return next;
}
