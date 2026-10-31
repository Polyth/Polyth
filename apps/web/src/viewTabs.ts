// The header's view tabs — Chat, Canvas and every primary workbench profile
// (Tasks, Creative Studio…) — as ONE list the person customizes: reorder them
// and show or hide each one. Visibility keeps its existing owners: Canvas is
// the project's `canvasEnabled`, an optional profile its project offer
// (profileOffers.ts); Chat and the always-offered profiles are hidden through
// `viewTabs.hidden` in the capability layout record, which also holds the
// order. The tab this device is showing is always drawn, so the person can
// switch away from a tab they just hid.
import { setViewTabLayout, useViewTabLayout, type ViewTabLayout } from "./capabilityLayout.ts";
import { orderRailItems } from "./railPlacement.ts";
import { tr } from "./i18n/index.ts";
import { CONVERSATION_PROFILE_ID } from "./workbench/profiles.ts";
import {
  setWorkbenchProfileOfferedForProject,
  switchWorkbenchNavigation,
  switchWorkspaceMode,
  useOptionalWorkbenchProfiles,
  useWorkbenchNavigation,
} from "./workbench/profileNavigation.ts";
import { getWorkbenchProjectId } from "./workbench/store.ts";
import {
  setWorkspaceCanvasEnabled,
  useWorkspaceCanvasEnabled,
  useWorkspaceContentMode,
} from "./widgets/workspaceMode.ts";
import type { WorkbenchProfileSummary } from "@polyth/web-sdk";

export const CHAT_TAB_ID = "chat";
export const CANVAS_TAB_ID = "canvas";

/** Where a tab's visibility is stored. */
export type ViewTabVisibility = "layout" | "canvas" | "offer";

export interface ViewTabCandidate {
  id: string;
  label: string;
  visibility: ViewTabVisibility;
  /** Offered by its own owner (Canvas enabled, optional profile offered). */
  offered: boolean;
  focused: boolean;
}

export interface ResolvedViewTab extends ViewTabCandidate {
  /** The person wants it in the header. */
  shown: boolean;
  active: boolean;
  /** Drawn in the header: shown, or the tab this device is on. */
  drawn: boolean;
}

/** Pure: order the candidates by the saved order (new tabs keep their
 *  natural place) and decide what each one shows. */
export function resolveViewTabs(
  candidates: readonly ViewTabCandidate[],
  layout: ViewTabLayout,
  activeId: string,
): ResolvedViewTab[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const hidden = new Set(layout.hidden ?? []);
  return orderRailItems(candidates.map((candidate) => candidate.id), layout.order).flatMap((id) => {
    const candidate = byId.get(id);
    if (!candidate) return [];
    const shown = candidate.visibility === "layout" ? !hidden.has(id) : candidate.offered;
    const active = id === activeId;
    return [{ ...candidate, shown, active, drawn: shown || active }];
  });
}

/** Pure: the layout after showing or hiding one always-offered tab. */
export function viewTabLayoutWithHidden(layout: ViewTabLayout, id: string, hide: boolean): ViewTabLayout {
  const hidden = new Set(layout.hidden ?? []);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  return { ...(layout.order ? { order: layout.order } : {}), hidden: [...hidden] };
}

const profileCandidate = (profile: WorkbenchProfileSummary, optional: boolean, offered: boolean): ViewTabCandidate => ({
  id: profile.id,
  label: profile.label,
  visibility: optional ? "offer" : "layout",
  offered,
  focused: profile.presentation.focused === true,
});

export interface ViewTabsModel {
  tabs: readonly ResolvedViewTab[];
  select: (id: string) => void;
  setShown: (id: string, shown: boolean) => void;
  reorder: (ids: readonly string[]) => void;
}

export function useViewTabs(): ViewTabsModel {
  const layout = useViewTabLayout();
  const canvasEnabled = useWorkspaceCanvasEnabled();
  const contentMode = useWorkspaceContentMode();
  const navigation = useWorkbenchNavigation();
  const optional = useOptionalWorkbenchProfiles();
  const offeredById = new Map(optional.map(({ profile, offered }) => [profile.id, offered]));

  const candidates: ViewTabCandidate[] = [
    { id: CHAT_TAB_ID, label: tr("header.chat"), visibility: "layout", offered: true, focused: false },
    { id: CANVAS_TAB_ID, label: tr("header.canvas"), visibility: "canvas", offered: canvasEnabled, focused: false },
  ];
  // Navigation profiles already carry every offered optional profile (and the
  // one this device sits in); unoffered optional ones join as hidden tabs.
  const profiles = [
    ...navigation.profiles.map((profile) => profileCandidate(
      profile,
      offeredById.has(profile.id),
      offeredById.get(profile.id) ?? true,
    )),
    ...optional
      .filter(({ profile }) => !navigation.profiles.some((candidate) => candidate.id === profile.id))
      .map(({ profile, offered }) => profileCandidate(profile, true, offered)),
  ];
  candidates.push(...profiles);

  const conversation = navigation.activeProfileId === CONVERSATION_PROFILE_ID;
  const activeId = conversation
    ? contentMode === "widgets" ? CANVAS_TAB_ID : CHAT_TAB_ID
    : navigation.activeProfileId;
  const tabs = resolveViewTabs(candidates, layout, activeId);
  const visibilityOf = new Map(candidates.map((candidate) => [candidate.id, candidate.visibility]));

  return {
    tabs,
    select: (id) => {
      if (id === CHAT_TAB_ID) switchWorkspaceMode("chat");
      else if (id === CANVAS_TAB_ID) switchWorkspaceMode("widgets");
      else switchWorkbenchNavigation({ profileId: id });
    },
    setShown: (id, shown) => {
      const visibility = visibilityOf.get(id);
      if (visibility === "canvas") setWorkspaceCanvasEnabled(shown);
      else if (visibility === "offer") setWorkbenchProfileOfferedForProject(id, getWorkbenchProjectId(), shown);
      else if (visibility === "layout") setViewTabLayout(viewTabLayoutWithHidden(layout, id, !shown));
    },
    // `ids` may be only the drawn tabs; the hidden ones follow in their order.
    reorder: (ids) => setViewTabLayout({
      ...layout,
      order: [...ids, ...tabs.map((tab) => tab.id).filter((id) => !ids.includes(id))],
    }),
  };
}
