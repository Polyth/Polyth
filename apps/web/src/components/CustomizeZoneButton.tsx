// The Customize pencil every icon rail and shell zone exposes. It opens the
// shared RailEditor: an anchored panel on desktop/tablet, a tall sheet on
// phones. Entries are built here once for every zone:
//   * capability launchers — in a tier rail (`tier`) from its tier placement,
//     everywhere else as the `capability:<id>` widget — each with ONE home
//     across all rails (railPlacement.ts), so adding moves instead of copying;
//   * the zone's other mini-widgets, from the shared widget layout.
import { useLayoutEffect, useRef, useState } from "react";
import type { UiSlot } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { useResolvedCapabilities } from "../capabilities.ts";
import { setPlacementOverride, useCapabilityPlacements, useRailOrders } from "../capabilityLayout.ts";
import {
  HEADER_RAIL_SLOTS,
  RAIL_TIER_SLOT,
  capabilityIdOfWidget,
  capabilityWidgetHomes,
  capabilityWidgetId,
  commitRailZoneOrder,
  orderRailItems,
  placeCapability,
  placeableCapabilities,
  railDestinationIds,
  railItemIdOfInstance,
  railPanelSurfaces,
  removeCapability,
  rightRailCapabilities,
  topRailCapabilities,
  useCapabilityHomes,
  type RailTier,
} from "../railPlacement.ts";
import { railIconFor } from "../railIcons.ts";
import type { RailEditorEntry } from "../railEditorModel.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useWidgetCatalog, type WidgetDef } from "../widgets/catalog.ts";
import { supportedWidgetSlots } from "../widgets/widgetLibrary.ts";
import {
  applyWidgetLayoutMutations,
  updateWidgetLayout,
  useWidgetLayout,
  widgetSlotOf,
} from "../widgets/widgetLayout.ts";
import { widgetsForZone } from "../widgets/zoneWidgets.ts";
import { EditIcon, Icon, IconButton, type LucideIcon } from "./ui/index.ts";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import WidgetGlyph from "./WidgetGlyph.tsx";
import RailEditor, { railZoneLabel, type RailEditorAction } from "./RailEditor.tsx";

export interface ZoneAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
}

interface ZoneSpec {
  slot: UiSlot;
  slots: readonly UiSlot[];
  tier: RailTier | undefined;
  placeIn: ((widget: WidgetDef) => UiSlot) | undefined;
}

function useZoneEntries({ slot, slots, tier, placeIn }: ZoneSpec): {
  entries: RailEditorEntry[];
  reorder: (keys: string[]) => void;
} {
  const resolved = useResolvedCapabilities();
  const placements = useCapabilityPlacements();
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const homes = useCapabilityHomes();
  const zoneSlots = new Set<UiSlot>(slots);
  const capabilityById = new Map(resolved.map((capability) => [capability.descriptor.id, capability]));
  const catalogById = new Map(widgets.map((widget) => [widget.id, widget]));
  const destinations = railDestinationIds();
  const landingSlot = (widgetId: string): UiSlot => {
    const widget = catalogById.get(widgetId);
    return (widget && placeIn?.(widget)) ?? slot;
  };

  // The tier rail's own launchers, in the order the rail renders them.
  const widgetHomes = capabilityWidgetHomes(layout);
  const top = topRailCapabilities(resolved, placements, widgetHomes);
  const tierShown = tier === "primary"
    ? top.map((capability) => capability.descriptor.id)
    : tier === "more"
      ? rightRailCapabilities(
        resolved,
        new Set(top.map((capability) => capability.descriptor.id)),
        (capability) => destinations.has(capability.descriptor.id),
        widgetHomes,
      ).map((capability) => capability.descriptor.id)
      : [];
  // The top-right header rail draws its two areas as one row, session
  // controls first; its editor lists and reorders them exactly that way.
  const headerRail = HEADER_RAIL_SLOTS.every((candidate) => zoneSlots.has(candidate));
  // Visible widget instances placed in this zone, in their slot order.
  const placedHere = (headerRail ? [...HEADER_RAIL_SLOTS] : [slot, ...slots.filter((other) => other !== slot)])
    .flatMap((zoneSlot) => layout.slotPlacements[zoneSlot] ?? [])
    .filter((instanceId) => layout.widgets[instanceId]?.visible === true);

  const toolEntry = (id: string): RailEditorEntry | null => {
    const capability = capabilityById.get(id);
    if (!capability) return null;
    const home = homes.get(id);
    const shown = home !== undefined && zoneSlots.has(home);
    const packageId = capability.descriptor.ownerPackageId;
    const RailIcon = railIconFor(id);
    return {
      key: `tool:${id}`,
      kind: "tool",
      label: capability.descriptor.label,
      description: capability.descriptor.plainDescription,
      ...(packageId ? { ownerPackageId: packageId } : {}),
      keywords: capability.descriptor.keywords,
      icon: <RailIcon />,
      shown,
      ...(!shown && home !== undefined ? { elsewhere: home } : {}),
      // Nothing in a rail is pinned: every launcher can be removed.
      locked: false,
      add: () => placeCapability(id, tier ? { tier } : { slot: landingSlot(capabilityWidgetId(id)) }),
      remove: () => removeCapability(id, home ?? slot),
    };
  };
  const widgetEntry = (widget: WidgetDef): RailEditorEntry => {
    const home = layout.widgets[widget.id]?.visible ? widgetSlotOf(layout, widget.id) : null;
    const shown = home !== null && zoneSlots.has(home);
    return {
      key: `widget:${widget.id}`,
      kind: "widget",
      label: widget.title,
      description: widget.description,
      ownerPackageId: widget.ownerPackageId ?? widget.pluginId,
      keywords: [...(widget.capabilities ?? []), widget.category ?? "", widget.pluginName ?? ""],
      icon: <WidgetGlyph widget={widget} />,
      shown,
      ...(!shown && home !== null ? { elsewhere: home } : {}),
      locked: shown && layout.widgets[widget.id]?.requiredVisible === true,
      add: () => updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
        { type: "visibility", id: widget.id, visible: true },
        { type: "place", id: widget.id, slot: landingSlot(widget.id) },
      ], widgets)),
      remove: () => updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current, [{ type: "visibility", id: widget.id, visible: false }], widgets)),
    };
  };

  // Right-rail panel buttons that are not capabilities: shown unless hidden.
  const panels = tier === "more" ? railPanelSurfaces(resolved) : [];
  const panelId = (surface: (typeof panels)[number]) => surface.capabilityId ?? surface.id;
  const panelEntry = (surface: (typeof panels)[number]): RailEditorEntry => {
    const id = panelId(surface);
    const PanelIcon = surface.icon ?? railIconFor(id);
    return {
      key: `panel:${id}`,
      kind: "tool",
      label: surface.title,
      ...(surface.description ? { description: surface.description } : {}),
      ...(surface.ownerPackageId ? { ownerPackageId: surface.ownerPackageId } : {}),
      keywords: [],
      icon: <PanelIcon />,
      shown: placements[id]?.tier !== "technical",
      locked: false,
      add: () => setPlacementOverride(id, { tier: "more", rank: Number.MAX_SAFE_INTEGER }),
      remove: () => removeCapability(id, slot),
    };
  };

  const entries: RailEditorEntry[] = [];
  const push = (entry: RailEditorEntry | null) => {
    if (entry && !entries.some((existing) => existing.key === entry.key)) entries.push(entry);
  };
  // Shown first, in the rail's own order: a tier rail mixes launchers,
  // panels and widgets in one order (railPlacement.ts orderRailItems).
  const zoneKey = tier === "primary" ? "top" : tier === "more" ? "right" : null;
  const railOrders = useRailOrders();
  const shownPanels = panels.filter((surface) => placements[panelId(surface)]?.tier !== "technical");
  const placedIds = placedHere.map((instanceId) => railItemIdOfInstance(layout, instanceId));
  const shownOrder = zoneKey
    ? orderRailItems([...tierShown, ...shownPanels.map(panelId), ...placedIds], railOrders[zoneKey])
    : placedIds;
  const panelById = new Map(panels.map((surface) => [panelId(surface), surface]));
  for (const railId of shownOrder) {
    const panel = panelById.get(railId);
    if (panel) { push(panelEntry(panel)); continue; }
    const instanceId = railId.startsWith("widget:") ? railId.slice("widget:".length) : null;
    if (instanceId === null) { push(toolEntry(railId)); continue; }
    const widget = catalogById.get(layout.widgets[instanceId]?.definitionId ?? instanceId);
    if (widget) push(widgetEntry(widget));
  }
  for (const surface of panels) push(panelEntry(surface));
  // Every other launcher this zone can hold, wherever it lives now. Outside
  // the tier rails a launcher is its generated widget, so it must fit here
  // (packages that ship their own launcher widget opt out of that path).
  for (const capability of placeableCapabilities(resolved)) {
    const id = capability.descriptor.id;
    if (tier === "more" && !destinations.has(id)) continue;
    if (tier === undefined) {
      const launcher = catalogById.get(capabilityWidgetId(id));
      if (!launcher || !supportedWidgetSlots(launcher).some((candidate) => zoneSlots.has(candidate))) continue;
    }
    push(toolEntry(id));
  }
  // The zone's remaining mini-widgets.
  const zone = widgetsForZone(widgets, layout, slots);
  for (const widget of [...zone.active, ...zone.inactive]) {
    if (capabilityIdOfWidget(widget.id) === null) push(widgetEntry(widget));
  }

  const reorder = (keys: string[]) => {
    const railZone = headerRail ? "header" as const : zoneKey;
    if (railZone) {
      // The same commit as a drag on the rail itself (railPlacement.ts): the
      // rail keeps exactly this mixed order.
      commitRailZoneOrder(railZone, keys.flatMap((key) => {
        const id = key.slice(key.indexOf(":") + 1);
        if (key.startsWith("tool:") || key.startsWith("panel:")) return [id];
        const instanceId = placedHere.find((candidate) => (layout.widgets[candidate]?.definitionId ?? candidate) === id);
        return instanceId ? [`widget:${instanceId}`] : [];
      }));
      return;
    }
    // Other zones: placed widgets (launcher widgets included) follow the
    // dragged order; re-placing each at its slot's end in sequence rebuilds it.
    const ordered = keys.flatMap((key) => {
      const id = key.slice(key.indexOf(":") + 1);
      const definitionId = key.startsWith("tool:") ? capabilityWidgetId(id) : id;
      const instanceId = placedHere.find((candidate) =>
        (layout.widgets[candidate]?.definitionId ?? candidate) === definitionId);
      return instanceId ? [instanceId] : [];
    });
    if (ordered.length < 2) return;
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, ordered.map((instanceId) => ({
      type: "place" as const,
      id: instanceId,
      slot: widgetSlotOf(current, instanceId) ?? slot,
    })), widgets));
  };

  return { entries, reorder };
}

function ZoneEditor({ spec, title, actions, close }: {
  spec: ZoneSpec;
  title: string;
  actions: readonly ZoneAction[];
  close: () => void;
}) {
  const { entries, reorder } = useZoneEntries(spec);
  // The phone sheet supplies its own title bar; the popover shows ours.
  const sheet = useShellMode() === "phone";
  const editorActions: RailEditorAction[] = actions.map((action) => ({
    id: action.id,
    label: action.label,
    ...(action.icon ? { icon: <Icon icon={action.icon} size="sm" /> } : {}),
    onSelect: () => {
      close();
      action.onSelect();
    },
  }));
  return <RailEditor slot={spec.slot} title={title} entries={entries} reorder={reorder} actions={editorActions} sheet={sheet} />;
}

export default function CustomizeZoneButton({
  slot,
  slots = [slot],
  className = "",
  align = "end",
  side = "down",
  tier,
  title,
  actions = [],
  placeIn,
  liveRegion = ".customize-zone",
}: {
  slot: UiSlot;
  slots?: readonly UiSlot[];
  className?: string;
  align?: "start" | "center" | "end";
  /** Opening side; vertical rails open beside themselves so the rail stays
   *  visible as a live preview (it flips when there is no room, e.g. RTL). */
  side?: "down" | "up" | "left" | "right";
  /** The tier rail this zone renders built-in launchers from. */
  tier?: RailTier;
  /** Editor title; defaults to the zone's short name. */
  title?: string;
  /** Plain zone actions (e.g. hide the status bar); they close the editor. */
  actions?: readonly ZoneAction[];
  /** Where an added widget lands when the zone spans several areas; defaults
   *  to `slot`. Lets a two-ended bar put each widget back at its own end. */
  placeIn?: (widget: WidgetDef) => UiSlot;
  /** Closest ancestor (selector) that stays live while the editor is open;
   *  defaults to the pencil's zone. A rail whose pencil sits in its footer
   *  names the whole rail. */
  liveRegion?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // The editor opens beside its zone; keep that zone live (the rail stays
  // draggable, the toolbar stays usable) instead of covering it with the
  // popover's backdrop.
  const zoneRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    zoneRef.current = open ? anchorRef.current?.closest<HTMLElement>(liveRegion) ?? null : null;
  }, [open, liveRegion]);
  const zoneTitle = title ?? railZoneLabel(tier ? RAIL_TIER_SLOT[tier] : slot);
  const label = tr("raileditor.customizeZone", { zone: zoneTitle });
  return (
    <>
      <IconButton
        ref={anchorRef}
        className={`zone-customize-trigger zone-edit-button${className ? ` ${className}` : ""}`}
        icon={EditIcon}
        size="sm"
        variant="ghost"
        label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      <ResponsiveOverlay
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        anchorRef={anchorRef}
        align={align}
        side={side}
        phone="sheet"
        sheetSize="tall"
        className="rail-editor-overlay"
        initialFocus=".rail-editor-search input"
        keepInteractiveRef={zoneRef}
      >
        <ZoneEditor
          spec={{ slot, slots, tier, placeIn }}
          title={zoneTitle}
          actions={actions}
          close={() => setOpen(false)}
        />
      </ResponsiveOverlay>
    </>
  );
}
