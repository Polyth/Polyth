// ACP session configuration, parsed truthfully from whatever the agent
// actually returned. Two protocol generations exist and neither is
// vendor-specific:
//
//  - current: `session/new` / `session/load` return `configOptions`, a list of
//    `{ id, name, category?, type: "select" | "boolean", ... }`. The optional
//    category or the exact well-known ids `model` / `thought_level` identify
//    the two controls. Changes go through
//    `session/set_config_option`.
//  - legacy (still shipped by some agents): `session/new` returns
//    `models: { availableModels, currentModelId }` and changes go through
//    `session/set_model`.
//
// Anything else the agent sends is ignored rather than guessed at, and an agent
// that advertises nothing yields an empty catalog — never an invented one.
import type { ModelDescriptor } from "@polyth/contracts";

export interface AcpSelectOption { value: string; name: string; description?: string }

export interface AcpConfigSelect {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options: AcpSelectOption[];
}

export interface AcpSessionConfig {
  /** The model select identified by category or exact well-known id. */
  model?: AcpConfigSelect;
  /** The thinking select identified by category or exact well-known id. */
  thoughtLevel?: AcpConfigSelect;
  /** Legacy `models` block from `session/new`. */
  legacyModels?: { available: AcpSelectOption[]; current?: string };
  /** Session modes, kept for `current_mode_update` bookkeeping. */
  currentModeId?: string;
}

const classified = (option: AcpConfigSelect, kind: "model" | "thought_level"): boolean =>
  option.category === kind || (option.category === undefined && option.id === kind);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Options are either a flat list or grouped; both flatten to the same rows. */
const selectOptions = (value: unknown): AcpSelectOption[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row) return [];
    if (Array.isArray(row.options)) return selectOptions(row.options);
    const id = str(row.value);
    if (!id) return [];
    return [{
      value: id,
      name: str(row.name) ?? id,
      ...(str(row.description) ? { description: str(row.description)! } : {}),
    }];
  });
};

const parseSelect = (value: unknown): AcpConfigSelect | undefined => {
  const row = asRecord(value);
  if (!row) return undefined;
  const id = str(row.id);
  if (!id || row.type !== "select") return undefined;
  const options = selectOptions(row.options);
  if (options.length === 0) return undefined;
  return {
    id,
    name: str(row.name) ?? id,
    ...(str(row.category) ? { category: str(row.category)! } : {}),
    ...(str(row.currentValue) ? { currentValue: str(row.currentValue)! } : {}),
    options,
  };
};

const parseLegacyModels = (value: unknown): AcpSessionConfig["legacyModels"] => {
  const row = asRecord(value);
  if (!row) return undefined;
  const available = (Array.isArray(row.availableModels) ? row.availableModels : []).flatMap((entry) => {
    const model = asRecord(entry);
    const id = model && str(model.modelId);
    if (!id) return [];
    return [{
      value: id,
      name: str(model!.name) ?? id,
      ...(str(model!.description) ? { description: str(model!.description)! } : {}),
    }];
  });
  if (available.length === 0) return undefined;
  return { available, ...(str(row.currentModelId) ? { current: str(row.currentModelId)! } : {}) };
};

/** Parse a `session/new` / `session/load` result into the session's controls. */
export function parseSessionConfig(result: unknown): AcpSessionConfig {
  const row = asRecord(result) ?? {};
  const options = (Array.isArray(row.configOptions) ? row.configOptions : [])
    .flatMap((entry) => { const parsed = parseSelect(entry); return parsed ? [parsed] : []; });
  const modes = asRecord(row.modes);
  return {
    ...(options.find((option) => classified(option, "model"))
      ? { model: options.find((option) => classified(option, "model"))! }
      : {}),
    ...(options.find((option) => classified(option, "thought_level"))
      ? { thoughtLevel: options.find((option) => classified(option, "thought_level"))! }
      : {}),
    ...(parseLegacyModels(row.models) ? { legacyModels: parseLegacyModels(row.models)! } : {}),
    ...(modes && str(modes.currentModeId) ? { currentModeId: str(modes.currentModeId)! } : {}),
  };
}

/** A config update carries the complete option state. Replace recognized
 * controls so a removed option cannot remain available from stale state. */
export function applyConfigOptionUpdate(
  config: AcpSessionConfig,
  update: unknown,
): AcpSessionConfig {
  const row = asRecord(update);
  if (!row) return config;
  const options = (Array.isArray(row.configOptions) ? row.configOptions : [])
    .flatMap((entry) => { const parsed = parseSelect(entry); return parsed ? [parsed] : []; });
  if (options.length === 0) return config;
  const model = options.find((option) => classified(option, "model"));
  const thoughtLevel = options.find((option) => classified(option, "thought_level"));
  const { model: _oldModel, thoughtLevel: _oldThought, ...rest } = config;
  return {
    ...rest,
    ...(model ? { model } : {}),
    ...(thoughtLevel ? { thoughtLevel } : {}),
  };
}

/** How the agent's currently selected model is identified, if at all. */
export const currentModelId = (config: AcpSessionConfig): string | undefined =>
  config.model?.currentValue ?? config.legacyModels?.current;

/** Which protocol call changes the model — or none, truthfully. */
export type AcpModelControl =
  | { kind: "config-option"; configId: string }
  | { kind: "legacy-set-model" }
  | { kind: "none" };

export const modelControl = (config: AcpSessionConfig): AcpModelControl => {
  if (config.model) return { kind: "config-option", configId: config.model.id };
  if (config.legacyModels) return { kind: "legacy-set-model" };
  return { kind: "none" };
};

/**
 * The canonical catalog for this session. `providerID` is the harness id
 * because ACP models carry no provider identity of their own; variants exist
 * only when the agent exposes a `thought_level` select.
 */
export function acpModelDescriptors(
  config: AcpSessionConfig,
  harnessId: string,
): ModelDescriptor[] {
  const rows = config.model?.options ?? config.legacyModels?.available ?? [];
  const variants = config.thoughtLevel?.options
    .map((option) => option.value)
    .filter((value) => value !== "auto" && value !== "default") ?? [];
  return rows.map((row) => ({
    providerID: harnessId,
    modelID: row.value,
    name: row.name,
    connected: true,
    ...(variants.length ? { variants } : {}),
  } satisfies ModelDescriptor));
}

/** Only an explicit protocol value is a portable reset target. Mutable
 * `currentValue` is intentionally not treated as a static default. */
export function explicitThoughtLevelReset(config: AcpSessionConfig): string | undefined {
  return config.thoughtLevel?.options
    .find((option) => option.value === "auto" || option.value === "default")?.value;
}
