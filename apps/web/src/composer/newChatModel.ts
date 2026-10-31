// The model a fresh chat's composer would start on, as its picker shows it.
// The composer publishes it; the new-chat screen hands it to its widgets as
// `composerModel` (limits for the model about to be used, peak pricing…).
// Presentation only: never persisted, never model-visible.
import { useSyncExternalStore } from "react";

export interface NewChatModel {
  harnessId: string;
  providerID: string;
  modelID: string;
}

let current: NewChatModel | null = null;
const listeners = new Set<() => void>();

export function setNewChatModel(next: NewChatModel | null): void {
  if (current === next || (current && next && current.harnessId === next.harnessId
    && current.providerID === next.providerID && current.modelID === next.modelID)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function getNewChatModel(): NewChatModel | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useNewChatModel(): NewChatModel | null {
  return useSyncExternalStore(subscribe, getNewChatModel, () => null);
}
