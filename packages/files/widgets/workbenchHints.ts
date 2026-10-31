/** Files reads its typed profile hints (`WorkbenchFilesHints`) through the
 *  public workbench API: the active profile, not a package id, decides. */
import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";

type Workbench = Pick<WebPackageHost["workbench"], "getActiveProfile" | "subscribe">;

let workbench: Workbench | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

export function bindFilesWorkbench(next: Workbench): () => void {
  workbench = next;
  notify();
  return () => {
    if (workbench !== next) return;
    workbench = null;
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const off = workbench?.subscribe(listener);
  return () => {
    listeners.delete(listener);
    off?.();
  };
}

// Following a chat's edits is how Files works in every profile (Chat, Canvas,
// IDE); a profile can opt out with `openSessionEdits: false`.
export function openSessionEdits(): boolean {
  if (!workbench) return false;
  try {
    return workbench.getActiveProfile().presentation.openSessionEdits !== false;
  } catch {
    return false;
  }
}

/** True while Files keeps each chat's edited files open (unless the active
 *  profile opted out). */
export function useOpenSessionEdits(): boolean {
  return useSyncExternalStore(subscribe, openSessionEdits, () => false);
}
