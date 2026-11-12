// Package sections at the top of a project's list (`sidebar.project.leading`
// contributions that carry `meta.navigatorSection`, NavigatorSectionSlotMeta in
// @polyth/web-sdk). The host never names the package: the label and the owning
// capability come from the contribution, the hidden/folded choices from
// navigatorState.ts. Kept free of JSX so node:test can import it.
import { useSyncExternalStore } from "react";
import { listSlots, type SlotItem } from "../../slots.ts";
import { useSlotVersion } from "../slots/SlotHost.ts";
import {
  readNavigatorSections,
  subscribeNavigatorSections,
  type NavigatorSectionsState,
} from "../../navigatorState.ts";

export const NAVIGATOR_SECTION_SLOT = "sidebar.project.leading" as const;

export interface NavigatorSection {
  /** The contribution id. */
  id: string;
  label: string;
  /** Capability whose action row the section unfolds from. */
  capability?: string;
  item: SlotItem;
}

/** Pure: the contributions that describe themselves as sections. */
export function navigatorSectionsOf(items: readonly SlotItem[]): NavigatorSection[] {
  return items.flatMap((item) => {
    const meta = item.meta?.navigatorSection as { label?: unknown; capability?: unknown } | undefined;
    if (!meta || typeof meta !== "object") return [];
    const label = typeof meta.label === "function" ? (meta.label as () => unknown)() : meta.label;
    if (typeof label !== "string" || label.trim() === "") return [];
    const capability = typeof meta.capability === "string" && meta.capability ? meta.capability : undefined;
    return [{ id: item.id, label, ...(capability ? { capability } : {}), item }];
  });
}

/** Pure: contribution ids a project's list leaves out — the hidden sections,
 *  and the ones that unfold from an action row shown above that list. */
export function excludedSections(
  sections: readonly NavigatorSection[],
  state: NavigatorSectionsState,
  attachedCapabilities: readonly string[],
): string[] {
  return sections
    .filter((section) => state.hidden.includes(section.id)
      || (section.capability !== undefined && attachedCapabilities.includes(section.capability)))
    .map((section) => section.id);
}

export interface NavigatorSectionsModel {
  sections: readonly NavigatorSection[];
  state: NavigatorSectionsState;
}

export function useNavigatorSections(): NavigatorSectionsModel {
  useSlotVersion();
  const state = useSyncExternalStore(subscribeNavigatorSections, readNavigatorSections, readNavigatorSections);
  // Read on every render: a label can follow the locale.
  return { sections: navigatorSectionsOf(listSlots(NAVIGATOR_SECTION_SLOT)), state };
}
