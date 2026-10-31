// The new chat's edit state. Touch screens enter it with a long press on the
// screen (HeroEditMode.tsx): widgets wobble, reorder by their grip and hide
// with their badge, and the phone header's actions island turns into Done.
// The Customize panel's open state lives here too, so the edit toolbar can
// open it from outside its trigger. Pure UI state: never persisted or synced.
import { useSyncExternalStore } from "react";
import { useCustomizeActive } from "./useShiftArmed.ts";
import { useWorkspaceMode } from "./widgets/workspaceMode.ts";

/** Which part of the Customize panel opens first; `false` = closed. */
export type HeroPanelRequest = false | "all" | "add";

interface HeroEditState {
  editing: boolean;
  panel: HeroPanelRequest;
}

let state: HeroEditState = { editing: false, panel: false };
const listeners = new Set<() => void>();

function update(patch: Partial<HeroEditState>): void {
  const next = { ...state, ...patch };
  if (next.editing === state.editing && next.panel === state.panel) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getHeroEditing(): boolean {
  return state.editing;
}

export function setHeroEditing(editing: boolean): void {
  update({ editing });
}

export function openHeroPanel(request: Exclude<HeroPanelRequest, false> = "all"): void {
  update({ panel: request });
}

export function closeHeroPanel(): void {
  update({ panel: false });
}

export function useHeroEditing(): boolean {
  return useSyncExternalStore(subscribe, () => state.editing, () => false);
}

export function useHeroPanel(): HeroPanelRequest {
  return useSyncExternalStore(subscribe, () => state.panel, () => false);
}

/** The screen's widgets are being arranged: held Shift (desktop), the
 *  workspace Edit mode, or the touch edit mode. */
export function useHeroArranging(): boolean {
  const shift = useCustomizeActive();
  const workspaceEditing = useWorkspaceMode() === "edit";
  return useHeroEditing() || shift || workspaceEditing;
}
