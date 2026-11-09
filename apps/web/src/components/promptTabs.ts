// Package tabs beside the prompt list in the chat's bookmark popover
// (`session.prompt.tabs` contributions, described by `meta.promptTab`). A tab
// with content for the chat also fills the icon and shows it though its setting
// is off, so the Timeline reads this too. No contribution, no change: the popover
// is the prompt list it always was.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PromptTabSlotMeta } from "@polyth/web-sdk";
import { listSlots, type SlotItem } from "../slots.ts";
import { useSlotVersion } from "./slots/SlotHost.ts";

export const PROMPT_TABS_SLOT = "session.prompt.tabs";
export const PROMPTS_TAB_ID = "prompts";
const TAB_CHOICE_KEY = "polyth.promptBookmark.tab.v1";

export interface PromptTab {
  id: string;
  item: SlotItem;
  label(): string;
  hasContent(sessionId: string): boolean;
  subscribe(listener: () => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function promptTabContribution(item: SlotItem): PromptTab | null {
  const meta = isRecord(item.meta?.promptTab) ? item.meta.promptTab as Partial<PromptTabSlotMeta> : null;
  if (!meta || typeof meta.hasContent !== "function" || typeof meta.subscribe !== "function") return null;
  const { label, hasContent, subscribe } = meta;
  return {
    id: item.id,
    item,
    label: () => (typeof label === "function" ? label() : label ?? item.id),
    hasContent,
    subscribe,
  };
}

export function listPromptTabs(): PromptTab[] {
  return listSlots(PROMPT_TABS_SLOT)
    .map(promptTabContribution)
    .filter((tab): tab is PromptTab => tab !== null);
}

/** Reactive list: re-reads when a package registers, replaces or disposes. */
export function usePromptTabs(): PromptTab[] {
  const version = useSlotVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(listPromptTabs, [version]);
}

/** The ids of the tabs with content for this chat, comma-joined so a change
 *  elsewhere in a package's data never re-renders the transcript. */
export function usePromptTabContent(sessionId: string | null): string {
  const tabs = usePromptTabs();
  const subscribe = useCallback((listener: () => void) => {
    const off = tabs.map((tab) => tab.subscribe(listener));
    return () => { for (const dispose of off) dispose(); };
  }, [tabs]);
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? tabs.filter((tab) => tab.hasContent(sessionId)).map((tab) => tab.id).join(",") : ""),
    () => "",
  );
}

/** The last tab used on this device; prompts stay one tap away for a person who
 *  mostly navigates by them. */
export function readPromptTabChoice(): string {
  try {
    return localStorage.getItem(TAB_CHOICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writePromptTabChoice(id: string): void {
  try {
    localStorage.setItem(TAB_CHOICE_KEY, id);
  } catch {
    // Private mode: the choice simply lasts this visit.
  }
}
