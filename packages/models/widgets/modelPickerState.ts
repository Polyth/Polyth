import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { presentModelDescriptor } from "../src/presentation.ts";

export interface ModelPickerState {
  query: string;
  /** Explicit choices made during this picker session, including collapses. */
  expansion: Readonly<Record<string, boolean>>;
}

export type ModelPickerAction =
  | { type: "search"; query: string }
  | { type: "set-expanded"; providerId: string; expanded: boolean }
  | { type: "reset" };

export const initialModelPickerState = (): ModelPickerState => ({ query: "", expansion: {} });

export function modelPickerReducer(state: ModelPickerState, action: ModelPickerAction): ModelPickerState {
  if (action.type === "reset") return initialModelPickerState();
  if (action.type === "search") return { ...state, query: action.query };
  return { ...state, expansion: { ...state.expansion, [action.providerId]: action.expanded } };
}

export interface ProviderExpansionInputs {
  query: string;
  sessionOverride?: boolean;
  persistedExpanded: boolean;
  selectedProvider: boolean;
}

export function providerIsExpanded(inputs: ProviderExpansionInputs): boolean {
  if (inputs.query.trim() !== "") return true;
  if (inputs.sessionOverride !== undefined) return inputs.sessionOverride;
  if (inputs.persistedExpanded) return true;
  return inputs.selectedProvider;
}

export function pickerModelMatches(model: ModelDescriptor, ref: ModelRef & { harnessId?: string }): boolean {
  return model.providerID === ref.providerID && model.modelID === ref.modelID
    && (!ref.harnessId || (model.harnessId ?? "opencode") === ref.harnessId);
}

/** Routing truth stays untouched; the picker consumes presentation copies. */
export function pickerCatalogModels(models: readonly ModelDescriptor[], harnessId?: string): ModelDescriptor[] {
  return models
    .filter((model) => (!harnessId || (model.harnessId ?? "opencode") === harnessId)
      && ((model.harnessId ?? harnessId ?? "opencode") !== "opencode" || model.connected !== false))
    .map(presentModelDescriptor);
}

export function flatModelCatalog(models: readonly ModelDescriptor[], harnessId?: string): boolean {
  const owner = harnessId ?? models[0]?.harnessId;
  return Boolean(owner && owner !== "opencode" && models.every((model) => model.harnessId === owner));
}
