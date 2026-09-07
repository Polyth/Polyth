// Host-owned placement menu for one surface: every drag action has an entry
// here (Move to Start / Make Primary / Move to End / Move to Bottom / Swap
// with… / Float / Full screen / Collapse / Reset position / Close). Packages
// never see it — the region host renders it in the shared window chrome.
import type { WorkbenchRegion } from "@polyth/web-sdk";
import { IconButton, Menu, MoreIcon, type MenuEntry } from "../ui/index.ts";
import { tr } from "../../i18n/index.ts";
import {
  CHAT_SURFACE_ID,
  WORKBENCH_REGIONS,
  placementOf,
  type WorkbenchLayout,
} from "../../workbench/layout.ts";
import {
  surfaceAllowsRegion,
  workbenchCloseSurface,
  workbenchMakePrimary,
  workbenchMoveSurface,
  workbenchResetSurfacePosition,
  workbenchSetCollapsed,
  workbenchSetPresentation,
  workbenchSwapSurfaces,
} from "../../workbench/store.ts";
import type { WorkbenchSurfaceInfo } from "./workbenchModel.ts";

export const REGION_LABEL_KEYS = {
  start: "workbench.region.start",
  primary: "workbench.region.primary",
  end: "workbench.region.end",
  bottom: "workbench.region.bottom",
} as const;

export function regionLabel(region: WorkbenchRegion): string {
  return tr(REGION_LABEL_KEYS[region]);
}

const MOVE_LABEL_KEYS = {
  start: "workbench.moveToStart",
  primary: "workbench.makePrimary",
  end: "workbench.moveToEnd",
  bottom: "workbench.moveToBottom",
} as const;

export interface SurfaceMenuProps {
  surfaceId: string;
  layout: WorkbenchLayout;
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
  /** Hide entries that need a pointer-sized desktop workbench. */
  compact?: boolean;
  /** Called after any entry ran so the host can restore focus sensibly. */
  onAction?: () => void;
}

/** Pure entry model — exported so tests can assert the vocabulary without a DOM. */
export function surfaceMenuEntries({ surfaceId, layout, surfaces, compact = false, onAction }: SurfaceMenuProps): MenuEntry[] {
  const placement = placementOf(layout, surfaceId);
  if (placement === null) return [];
  const currentRegion = placement.presentation === "docked" ? placement.region : null;
  const run = (fn: () => unknown) => () => { fn(); onAction?.(); };
  const entries: MenuEntry[] = [{ heading: tr("workbench.placeIn") }];
  for (const region of WORKBENCH_REGIONS) {
    entries.push({
      id: `move:${region}`,
      label: tr(MOVE_LABEL_KEYS[region]),
      kind: "radio",
      checked: currentRegion === region,
      disabled: currentRegion === region || !surfaceAllowsRegion(surfaceId, region),
      onSelect: run(() => region === "primary" ? workbenchMakePrimary(surfaceId) : workbenchMoveSurface(surfaceId, region)),
    });
  }
  const swapCandidates = WORKBENCH_REGIONS
    .flatMap((region) => layout.regions[region].surfaces)
    .filter((id) => id !== surfaceId && surfaces.has(id))
    .filter((id) => {
      const other = placementOf(layout, id);
      return other?.presentation === "docked"
        && surfaceAllowsRegion(surfaceId, other.region)
        && (currentRegion === null || surfaceAllowsRegion(id, currentRegion));
    });
  if (swapCandidates.length > 0 && placement.presentation !== "fullscreen") {
    entries.push("separator", { heading: tr("workbench.swapWith") });
    for (const id of swapCandidates.slice(0, 8)) {
      entries.push({
        id: `swap:${id}`,
        label: surfaces.get(id)!.title,
        onSelect: run(() => workbenchSwapSurfaces(surfaceId, id)),
      });
    }
  }
  if (!compact) {
    entries.push("separator", {
      id: "float",
      label: tr("workbench.float"),
      kind: "checkbox",
      checked: placement.presentation === "floating",
      onSelect: run(() => workbenchSetPresentation(surfaceId, placement.presentation === "floating" ? "docked" : "floating")),
    });
  }
  entries.push({
    id: "fullscreen",
    label: tr("workbench.fullscreen"),
    kind: "checkbox",
    checked: placement.presentation === "fullscreen",
    onSelect: run(() => workbenchSetPresentation(surfaceId, placement.presentation === "fullscreen" ? "docked" : "fullscreen")),
  });
  if (currentRegion !== null) {
    entries.push({
      id: "collapse",
      label: tr("workbench.collapseRegion"),
      kind: "checkbox",
      checked: layout.collapsed[currentRegion],
      onSelect: run(() => workbenchSetCollapsed(currentRegion, !layout.collapsed[currentRegion])),
    });
  }
  entries.push("separator", {
    id: "reset",
    label: tr("workbench.resetPosition"),
    onSelect: run(() => workbenchResetSurfacePosition(surfaceId)),
  });
  if (surfaceId !== CHAT_SURFACE_ID) {
    entries.push({
      id: "close",
      label: tr("workbench.closePanel"),
      onSelect: run(() => workbenchCloseSurface(surfaceId)),
    });
  }
  return entries;
}

export default function SurfaceMenu(props: SurfaceMenuProps) {
  const surface = props.surfaces.get(props.surfaceId);
  const entries = surfaceMenuEntries(props);
  if (!surface || entries.length === 0) return null;
  const label = tr("workbench.layoutActionsFor", { title: surface.title });
  return (
    <Menu label={label} title={tr("workbench.layout")} align="end" entries={entries}>
      {(trigger) => (
        <IconButton {...trigger} icon={MoreIcon} size="sm" className="wb-surface-menu" label={label} title={label} />
      )}
    </Menu>
  );
}
