// The model each harness last ran from a chat's picker. Switching the picker to
// a harness offers that model first, so a route change comes back to what the
// person chose there instead of an arbitrary catalogue entry. Like the
// per-model thinking record, the local copy is a synchronous cache for the
// account settings sync, so the memory follows the person across clients.
import { useSyncExternalStore } from "react";
import type { ModelRef } from "@polyth/contracts";
import {
  accountStorageGet,
  accountStorageKey,
  accountStorageRemove,
  accountStorageSet,
} from "@polyth/web/account-storage";

export const LAST_HARNESS_MODELS_KEY = "polyth.lastHarnessModels.v1";

/** `name` is only a label for the moment before the harness's catalogue
 *  answers; the catalogue row stays the authority for what runs. */
export type LastHarnessModel = Pick<ModelRef, "providerID" | "modelID"> & { name?: string };
/** Harness id → the model last chosen there, in harness id order. */
export type LastHarnessModels = Record<string, LastHarnessModel>;
/** The stored and synced shape: one `[providerID, modelID, name?]` per
 *  harness. The settings merge reconciles concurrent edits field by field
 *  inside objects, which could splice one client's provider onto another's
 *  model; an array is replaced whole. Keys are kept in harness id order: the
 *  merge rebuilds objects in the base record's key order and compares JSON
 *  text, so an order that carried meaning would bounce between clients. */
export type LastHarnessModelsRecord = Record<string, [string, string] | [string, string, string]>;

/** Harness ids are few; the bound only keeps a corrupt record small. */
const MAX_HARNESSES = 64;
const MAX_ID = 256;

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

const byHarnessId = ([a]: [string, unknown], [b]: [string, unknown]): number => a < b ? -1 : a > b ? 1 : 0;

function fromRecord(value: unknown): LastHarnessModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, LastHarnessModel]> = [];
  for (const [harnessId, pick] of Object.entries(value)) {
    if (!validId(harnessId) || !Array.isArray(pick)) continue;
    const [providerID, modelID, name] = pick as unknown[];
    if (validId(providerID) && validId(modelID)) {
      entries.push([harnessId, { providerID, modelID, ...(validId(name) ? { name } : {}) }]);
    }
  }
  return Object.fromEntries(entries.sort(byHarnessId).slice(0, MAX_HARNESSES));
}

export function lastHarnessModelsRecord(value: LastHarnessModels): LastHarnessModelsRecord {
  return Object.fromEntries(Object.entries(value).map(([harnessId, model]) => [
    harnessId,
    model.name ? [model.providerID, model.modelID, model.name] : [model.providerID, model.modelID],
  ]));
}

export function parseLastHarnessModels(raw: string | null): LastHarnessModels {
  if (!raw) return {};
  try {
    return fromRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function serializeLastHarnessModels(value: LastHarnessModels): string {
  return JSON.stringify(lastHarnessModelsRecord(value));
}

let models = parseLastHarnessModels(accountStorageGet(LAST_HARNESS_MODELS_KEY));
let record = lastHarnessModelsRecord(models);
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

const commit = (next: LastHarnessModels): void => {
  models = next;
  record = lastHarnessModelsRecord(models);
  if (Object.keys(models).length === 0) accountStorageRemove(LAST_HARNESS_MODELS_KEY);
  else accountStorageSet(LAST_HARNESS_MODELS_KEY, JSON.stringify(record));
  emit();
};

// Other tabs of the same account follow along; settingsSync mirrors the same
// listener set to the server, so no tab becomes a second authority.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== accountStorageKey(LAST_HARNESS_MODELS_KEY)) return;
    models = parseLastHarnessModels(event.newValue);
    record = lastHarnessModelsRecord(models);
    emit();
  });
}

export function getLastHarnessModels(): LastHarnessModels {
  return models;
}

/** The synced shape of the same memory (see `LastHarnessModelsRecord`). */
export function getLastHarnessModelsRecord(): LastHarnessModelsRecord {
  return record;
}

/** Apply the account's synced record (or any JSON value) through the parser. */
export function replaceLastHarnessModels(value: unknown): void {
  commit(fromRecord(value));
}

export function subscribeLastHarnessModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLastHarnessModels(): LastHarnessModels {
  return useSyncExternalStore(subscribeLastHarnessModels, getLastHarnessModels);
}

/** Record the model just chosen in `harnessId`'s picker. Choosing the
 *  remembered model again changes nothing, so nothing is written or synced. */
export function rememberHarnessModel(harnessId: string, model: LastHarnessModel): void {
  if (!validId(harnessId) || !validId(model.providerID) || !validId(model.modelID)) return;
  const name = validId(model.name) ? model.name : undefined;
  const current = models[harnessId];
  if (current?.providerID === model.providerID && current.modelID === model.modelID
    && current.name === name) return;
  const next: LastHarnessModels = {
    ...models,
    [harnessId]: { providerID: model.providerID, modelID: model.modelID, ...(name ? { name } : {}) },
  };
  // A full record makes room for the new harness rather than dropping it.
  const overflow = Object.keys(next).length - MAX_HARNESSES;
  if (overflow > 0) {
    for (const key of Object.keys(next).sort().filter((key) => key !== harnessId).slice(0, overflow)) delete next[key];
  }
  commit(fromRecord(lastHarnessModelsRecord(next)));
}
