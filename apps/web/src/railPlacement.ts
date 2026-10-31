// One home per capability across every icon rail and shell zone.
//
// A capability launcher can live in exactly one place: the top rail (primary
// tier), the right rail (more tier), or one shell zone as its generated
// `capability:<id>` mini-widget. The rails read their membership from the pure
// functions here, and every editor mutation goes through `placeCapability` /
// `removeCapability`, which leave the old home before taking the new one —
// adding an icon somewhere else is a move, never a copy.
//
// Legacy layouts may still hold both a tier placement and a visible launcher
// widget for the same capability. The explicit widget placement wins (those
// widgets are hidden by default, so a visible one was the user's choice) and
// the tier rails skip that capability instead of drawing it twice.
//
// Nothing in a rail is pinned: every launcher, widget and panel button can be
// reordered, moved or hidden (Terminal and Workflow only *start* on the top
// rail). Each tier rail draws ONE order the person controls, mixing all three
// (`orderRailItems`, stored as `railOrder` in the capability layout).
import type { UiSlot } from "@polyth/contracts";
import {
  currentResolvedCapabilities,
  isCommandCapability,
  listCapabilities,
  subscribeCapabilities,
  useCapabilityVersion,
  type ResolvedCapability,
} from "./capabilities.ts";
import {
  getCapabilityPlacements,
  setCapabilityTierOrder,
  subscribeCapabilityLayout,
  setPlacementOverride,
  useCapabilityPlacements,
  type CapabilityTier,
  type PlacementOverride,
} from "./capabilityLayout.ts";
import { uniquePackageLaunchers } from "./packageLaunchers.ts";
import { listSurfaces, slotSurfaces, useSurfaceVersion, type RailSurface } from "./surfaces.ts";
import { listPages } from "./pages.ts";
import { listWidgets } from "./widgets/catalog.ts";
import { supportedWidgetSlots } from "./widgets/widgetLibrary.ts";
import {
  applyWidgetLayoutMutations,
  subscribeWidgetLayout,
  ensureWidgets,
  getWidgetLayout,
  updateWidgetLayout,
  useWidgetLayout,
  widgetSlotOf,
  type WidgetLayout,
  type WidgetLayoutMutation,
} from "./widgets/widgetLayout.ts";

export const TOP_RAIL_SLOT = "app.header.center" satisfies UiSlot;
export const RIGHT_RAIL_SLOT = "workspace.rail" satisfies UiSlot;
/** Where an item dropped onto the top-right header rail lands. */
export const HEADER_RAIL_SLOT = "app.header.actions" satisfies UiSlot;
/** The top-right header rail draws both areas as one row, session controls
 * first. */
export const HEADER_RAIL_SLOTS = [
  "session.header.actions",
  "app.header.actions",
] as const satisfies readonly UiSlot[];
/** The navigator's Project rail: launchers and icon widgets under the
 * project icons. */
export const SIDEBAR_RAIL_SLOT = "sidebar.rail" satisfies UiSlot;

/** Every icon row/column a capability launcher may live in. */
export const ICON_RAIL_SLOTS = [
  "app.header.center",
  "app.header.leading",
  "app.header.actions",
  "workspace.rail",
  "sidebar.toolbar",
  "sidebar.rail",
  "sidebar.footer",
  "composer.leading",
  "composer.trailing",
  "session.footer",
  "app.statusbar.leading",
  "app.statusbar.trailing",
] as const satisfies readonly UiSlot[];

const ICON_RAIL_SLOT_SET: ReadonlySet<string> = new Set(ICON_RAIL_SLOTS);

/** The tier a rail's built-in launchers come from, if any. */
export type RailTier = Extract<CapabilityTier, "primary" | "more">;
export const RAIL_TIER_SLOT: Record<RailTier, UiSlot> = {
  primary: TOP_RAIL_SLOT,
  more: RIGHT_RAIL_SLOT,
};

/** Chat is the main-surface switch, not a launcher. */
const NOT_A_LAUNCHER = new Set(["session"]);
export const isRailLauncherId = (id: string): boolean => !NOT_A_LAUNCHER.has(id);

const CAPABILITY_WIDGET_PREFIX = "capability:";
/** Capabilities launched by a dedicated widget instead of a generated
 * `capability:<id>` one. The header bell IS the Notifications launcher: the
 * bell and a Notifications rail icon are one item with one home. */
const DEDICATED_LAUNCHER_WIDGETS: Readonly<Record<string, string>> = {
  "notification-centre": "notification.bell",
};
const CAPABILITY_OF_DEDICATED_LAUNCHER = new Map(
  Object.entries(DEDICATED_LAUNCHER_WIDGETS).map(([capabilityId, widgetId]) => [widgetId, capabilityId]),
);
/** The widget that launches capability `id` outside the tier rails. */
export const capabilityWidgetId = (id: string): string =>
  DEDICATED_LAUNCHER_WIDGETS[id] ?? `${CAPABILITY_WIDGET_PREFIX}${id}`;
export function capabilityIdOfWidget(widgetId: string): string | null {
  const dedicated = CAPABILITY_OF_DEDICATED_LAUNCHER.get(widgetId);
  if (dedicated !== undefined) return dedicated;
  return widgetId.startsWith(CAPABILITY_WIDGET_PREFIX) ? widgetId.slice(CAPABILITY_WIDGET_PREFIX.length) : null;
}

/** Visible capability launcher widgets → the shell zone that holds them. */
export function capabilityWidgetHomes(layout: WidgetLayout): Map<string, UiSlot> {
  const homes = new Map<string, UiSlot>();
  for (const [instanceId, placement] of Object.entries(layout.widgets)) {
    if (!placement?.visible) continue;
    const capabilityId = capabilityIdOfWidget(placement.definitionId ?? instanceId);
    if (capabilityId === null || homes.has(capabilityId)) continue;
    const slot = widgetSlotOf(layout, instanceId);
    if (slot !== null && ICON_RAIL_SLOT_SET.has(slot)) homes.set(capabilityId, slot);
  }
  return homes;
}

/** Workflow and Terminal keep their discoverable top-rail default only until
 * the user explicitly places them (anywhere, hidden included). */
export function defaultPinnedTop(id: string, placements: Record<string, PlacementOverride>): boolean {
  return (id === "workflow" || id === "terminal") && placements[id] === undefined;
}

const launchable = (capability: ResolvedCapability): boolean =>
  capability.descriptor.rail !== false && capability.descriptor.available();

/** The top rail's launchers in visual order. */
export function topRailCapabilities(
  resolved: readonly ResolvedCapability[],
  placements: Record<string, PlacementOverride>,
  widgetHomes: ReadonlyMap<string, UiSlot> = new Map(),
): ResolvedCapability[] {
  let top = resolved.filter((capability) => launchable(capability)
    && !widgetHomes.has(capability.descriptor.id)
    && (capability.tier === "primary" || defaultPinnedTop(capability.descriptor.id, placements)));
  const moveAfter = (items: ResolvedCapability[], id: string, afterId: string): ResolvedCapability[] => {
    const item = items.find((candidate) => candidate.descriptor.id === id);
    if (!item) return items;
    const next = items.filter((candidate) => candidate !== item);
    const at = next.findIndex((candidate) => candidate.descriptor.id === afterId);
    next.splice(at < 0 ? next.length : at + 1, 0, item);
    return next;
  };
  if (placements.workflow === undefined) top = moveAfter(top, "workflow", "session");
  if (placements.terminal === undefined) top = moveAfter(top, "terminal", "files");
  top = top.filter((capability) => !NOT_A_LAUNCHER.has(capability.descriptor.id));
  return uniquePackageLaunchers(top, (capability) => capability.descriptor);
}

/** The right rail's capability launchers in tier order. Nothing falls back
 * here: a launcher the person hid stays hidden (Terminal included). */
export function rightRailCapabilities(
  resolved: readonly ResolvedCapability[],
  topIds: ReadonlySet<string>,
  hasDestination: (capability: ResolvedCapability) => boolean,
  widgetHomes: ReadonlyMap<string, UiSlot> = new Map(),
): ResolvedCapability[] {
  return resolved.filter((capability) => {
    const id = capability.descriptor.id;
    return capability.tier === "more"
      && !topIds.has(id)
      && !widgetHomes.has(id)
      && launchable(capability)
      && hasDestination(capability);
  });
}

/** Ids the right rail can draw: a right-pane destination (registered surface
 * or Edit mode), a launcher of its package's page in place of Chat (Agents),
 * or a command launcher, which needs none. */
export function railDestinationIds(): Set<string> {
  const ids = new Set<string>(["workspace-edit"]);
  const pageOwners = new Set(listPages().map((page) => page.ownerPackageId).filter(Boolean));
  for (const capability of listCapabilities()) {
    if (isCommandCapability(capability)) ids.add(capability.id);
    else if (capability.ownerPackageId && pageOwners.has(capability.ownerPackageId)) ids.add(capability.id);
  }
  const ctx = { changeCount: 0, eventCount: 0, totalTokens: 0, hasSession: false };
  for (const surface of [...listSurfaces(), ...slotSurfaces(ctx)]) ids.add(surface.capabilityId ?? surface.id);
  return ids;
}

/** Right-rail panel buttons that are not capabilities (slot-contributed
 * panels): they reorder in the right rail and hide through a Technical
 * placement under their id. */
export function railPanelSurfaces(resolved: readonly ResolvedCapability[]): RailSurface[] {
  const capabilityIds = new Set(resolved.map((capability) => capability.descriptor.id));
  const ctx = { changeCount: 0, eventCount: 0, totalTokens: 0, hasSession: false };
  const seen = new Set<string>();
  return [...listSurfaces(), ...slotSurfaces(ctx)].filter((surface) => {
    const id = surface.capabilityId ?? surface.id;
    if (capabilityIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Where every launchable capability currently lives (absent = nowhere). */
export function capabilityHomes(
  resolved: readonly ResolvedCapability[],
  placements: Record<string, PlacementOverride>,
  layout: WidgetLayout,
  destinations: ReadonlySet<string>,
): Map<string, UiSlot> {
  const widgetHomes = capabilityWidgetHomes(layout);
  const top = topRailCapabilities(resolved, placements, widgetHomes);
  const topIds = new Set(top.map((capability) => capability.descriptor.id));
  const right = rightRailCapabilities(resolved, topIds, (capability) => destinations.has(capability.descriptor.id), widgetHomes);
  const homes = new Map<string, UiSlot>(widgetHomes);
  for (const capability of top) homes.set(capability.descriptor.id, TOP_RAIL_SLOT);
  for (const capability of right) homes.set(capability.descriptor.id, RIGHT_RAIL_SLOT);
  return homes;
}

/** Capabilities a person may place as a launcher, in resolved order. */
export function placeableCapabilities(resolved: readonly ResolvedCapability[]): ResolvedCapability[] {
  return resolved.filter((capability) => launchable(capability) && !NOT_A_LAUNCHER.has(capability.descriptor.id));
}

/** React view of the shared placement state. */
export function useCapabilityHomes(): Map<string, UiSlot> {
  useCapabilityVersion();
  useSurfaceVersion();
  const placements = useCapabilityPlacements();
  const layout = useWidgetLayout();
  return capabilityHomes(currentResolvedCapabilities(), placements, layout, railDestinationIds());
}

// ---------------------------------------------------------------- mutations

function rankAfter(resolved: readonly ResolvedCapability[], tier: CapabilityTier): number {
  return Math.max(-1, ...resolved.filter((capability) => capability.tier === tier)
    .map((capability) => capability.rank)) + 1;
}

/** Hide every visible launcher widget of `id`, optionally keeping one slot. */
function hideLauncherWidgets(layout: WidgetLayout, id: string, keep?: UiSlot): WidgetLayoutMutation[] {
  const mutations: WidgetLayoutMutation[] = [];
  for (const [instanceId, placement] of Object.entries(layout.widgets)) {
    if (!placement?.visible) continue;
    if (capabilityIdOfWidget(placement.definitionId ?? instanceId) !== id) continue;
    const slot = widgetSlotOf(layout, instanceId);
    if (slot !== null && ICON_RAIL_SLOT_SET.has(slot) && slot !== keep) {
      mutations.push({ type: "visibility", id: instanceId, visible: false });
    }
  }
  return mutations;
}

export type RailTarget = { tier: RailTier } | { slot: UiSlot; index?: number };

/** A capability leaving the tier rails for a shell zone stops counting as a
 * top/right-rail launcher (its widget home would win anyway; this keeps the
 * tier record honest so removing the widget does not resurrect it there). */
function leaveTierRails(id: string): void {
  const resolved = currentResolvedCapabilities();
  const capability = resolved.find((candidate) => candidate.descriptor.id === id);
  if (capability && (capability.tier === "primary" || capability.tier === "more"
    || defaultPinnedTop(id, getCapabilityPlacements()))) {
    setPlacementOverride(id, { tier: "technical", rank: rankAfter(resolved, "technical") });
  }
}

/** A launcher registered after the project's layout was reconciled is not in
 * it yet; seed it (host-owned, so always allowed) or a move would no-op. */
function ensureLauncherWidget(id: string): string {
  const widgetId = capabilityWidgetId(id);
  const definition = listWidgets().find((widget) => widget.id === widgetId);
  if (definition && !(widgetId in getWidgetLayout().widgets)) ensureWidgets([definition]);
  return widgetId;
}

/** Move a capability launcher to `target`, leaving every other home. */
export function placeCapability(id: string, target: RailTarget): void {
  const resolved = currentResolvedCapabilities();
  const layout = getWidgetLayout();
  if ("tier" in target) {
    const hide = hideLauncherWidgets(layout, id);
    if (hide.length > 0) updateWidgetLayout((current) => applyWidgetLayoutMutations(current, hide, listWidgets()));
    setPlacementOverride(id, { tier: target.tier, rank: rankAfter(resolved, target.tier) });
    return;
  }
  leaveTierRails(id);
  const widgetId = ensureLauncherWidget(id);
  updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
    ...hideLauncherWidgets(current, id, target.slot),
    { type: "visibility", id: widgetId, visible: true },
    { type: "place", id: widgetId, slot: target.slot, ...(target.index !== undefined ? { index: target.index } : {}) },
  ], listWidgets()));
}

/** Take a launcher out of `slot`. In a tier rail it moves to Technical (still
 * searchable and one click away) — this also hides a right-rail panel button
 * that is not a capability; in a shell zone its launcher widget is hidden. */
export function removeCapability(id: string, slot: UiSlot): void {
  const layout = getWidgetLayout();
  const hide = hideLauncherWidgets(layout, id).filter((mutation) =>
    mutation.type === "visibility" && widgetSlotOf(layout, mutation.id) === slot);
  if (hide.length > 0) updateWidgetLayout((current) => applyWidgetLayoutMutations(current, hide, listWidgets()));
  if (slot === TOP_RAIL_SLOT || slot === RIGHT_RAIL_SLOT) {
    setPlacementOverride(id, { tier: "technical", rank: rankAfter(currentResolvedCapabilities(), "technical") });
  }
}

/** Package-facing view of one capability's placement in the active project:
 * its resolved tier and whether it currently has a rail home (top rail, right
 * rail or a shell zone). `null` when the capability is not registered or not
 * relevant to the project. */
export function capabilityRailState(id: string): { tier: CapabilityTier; onRail: boolean } | null {
  const resolved = currentResolvedCapabilities();
  const capability = resolved.find((candidate) => candidate.descriptor.id === id);
  if (!capability) return null;
  const homes = capabilityHomes(resolved, getCapabilityPlacements(), getWidgetLayout(), railDestinationIds());
  return { tier: capability.tier, onRail: homes.has(id) };
}

/** Take a launcher off every rail and shell zone; it keeps its Technical
 * entry (searchable, one click away in the rail editor). */
export function unplaceCapability(id: string): void {
  const hide = hideLauncherWidgets(getWidgetLayout(), id);
  if (hide.length > 0) updateWidgetLayout((current) => applyWidgetLayoutMutations(current, hide, listWidgets()));
  setPlacementOverride(id, { tier: "technical", rank: rankAfter(currentResolvedCapabilities(), "technical") });
}

/** Re-run when the placement of any capability may have changed. */
export function subscribeCapabilityPlacement(listener: () => void): () => void {
  const stops = [subscribeCapabilityLayout(listener), subscribeCapabilities(listener), subscribeWidgetLayout(listener)];
  return () => { for (const stop of stops) stop(); };
}

/** One rail's visual order: the person's stored order where it has one,
 * with items it does not mention yet (new arrivals, or every item of a rail
 * that was never rearranged) kept right after the item they follow in the
 * rail's natural order — tier launchers, then panels, then placed widgets,
 * which is how rails drew before they had one order. Stale ids are dropped.
 * Deterministic, so a never-rearranged rail looks exactly as before. */
export function orderRailItems(natural: readonly string[], stored: readonly string[] | undefined): string[] {
  const present = new Set(natural);
  const order = stored ? [...new Set(stored)].filter((id) => present.has(id)) : [];
  const placed = new Set(order);
  for (const [index, id] of natural.entries()) {
    if (placed.has(id)) continue;
    let at = 0;
    for (let back = index - 1; back >= 0; back -= 1) {
      const anchor = order.indexOf(natural[back]!);
      if (anchor >= 0) { at = anchor + 1; break; }
    }
    order.splice(at, 0, id);
    placed.add(id);
  }
  return order;
}

// ---------------------------------------------------------------- rail zones
//
// The four icon rails a launcher can be dragged between: the top rail (left
// of the header), the right rail, the top-right header rail and the
// navigator's Project rail. Each renders
// its items under one drag id per item:
//   * a capability launcher — tier icon or launcher widget alike — is its
//     capability id, so it moves between rails as that capability;
//   * any other placed widget is `widget:<instanceId>`.
// Dropping an item into a rail persists that rail's whole order through
// `commitRailZoneOrder`, which leaves the item's previous home first.

export type RailZoneKey = "top" | "right" | "header" | "sidebar";

export const RAIL_ZONE_SLOTS: Readonly<Record<RailZoneKey, readonly UiSlot[]>> = {
  top: [TOP_RAIL_SLOT],
  right: [RIGHT_RAIL_SLOT],
  header: HEADER_RAIL_SLOTS,
  sidebar: [SIDEBAR_RAIL_SLOT],
};

const WIDGET_ITEM_PREFIX = "widget:";

/** Drag id of a placed widget instance. */
export function railItemIdOfInstance(layout: WidgetLayout, instanceId: string): string {
  return capabilityIdOfWidget(layout.widgets[instanceId]?.definitionId ?? instanceId)
    ?? `${WIDGET_ITEM_PREFIX}${instanceId}`;
}

/** The widget instance behind a `widget:` drag id (null for capabilities). */
export function instanceOfRailItem(id: string): string | null {
  return id.startsWith(WIDGET_ITEM_PREFIX) ? id.slice(WIDGET_ITEM_PREFIX.length) : null;
}

function widgetSupports(definitionId: string, slots: readonly UiSlot[]): boolean {
  const definition = listWidgets().find((widget) => widget.id === definitionId);
  return definition !== undefined && supportedWidgetSlots(definition).some((slot) => slots.includes(slot));
}

/** May a placed (non-launcher) widget land in `zone`? Only where its
 * definition supports one of the zone's areas. */
export function railWidgetFits(zone: RailZoneKey, id: string, layout: WidgetLayout = getWidgetLayout()): boolean {
  const instanceId = instanceOfRailItem(id);
  if (instanceId === null || !(instanceId in layout.widgets)) return false;
  const definitionId = layout.widgets[instanceId]?.definitionId ?? instanceId;
  return widgetSupports(definitionId, RAIL_ZONE_SLOTS[zone]);
}

/** May capability `id` live in a widget rail (the header or Project rail)?
 * Its launcher widget must exist and fit there. (The tier rails decide
 * capabilities themselves.) */
function widgetRailAcceptsCapability(id: string, slot: UiSlot): boolean {
  if (NOT_A_LAUNCHER.has(id)) return false;
  const capability = currentResolvedCapabilities().find((candidate) => candidate.descriptor.id === id);
  return capability !== undefined && launchable(capability) && widgetSupports(capabilityWidgetId(id), [slot]);
}
export const headerAcceptsCapability = (id: string): boolean => widgetRailAcceptsCapability(id, HEADER_RAIL_SLOT);
export const sidebarRailAcceptsCapability = (id: string): boolean => widgetRailAcceptsCapability(id, SIDEBAR_RAIL_SLOT);

/** Which header area each item of a header order lives in. The row draws
 * `session.header.actions` before `app.header.actions`, so a valid order is a
 * split: a prefix every item of which may be a session control, then the
 * rest. The split moving the fewest existing items wins; arrivals prefer the
 * application area. When no split fits, every item keeps its area (and the
 * row redraws grouped). */
export function headerRailSlots(
  items: readonly { slot: UiSlot | null; supports: readonly UiSlot[] }[],
): UiSlot[] {
  const [session, app] = HEADER_RAIL_SLOTS;
  let best: { split: number; cost: number } | null = null;
  for (let split = 0; split <= items.length; split += 1) {
    let cost = 0;
    let valid = true;
    for (const [index, item] of items.entries()) {
      const slot = index < split ? session : app;
      if (!item.supports.includes(slot)) { valid = false; break; }
      if (item.slot === null) cost += slot === session ? 1 : 0;
      else if (item.slot !== slot) cost += 2;
    }
    if (valid && (best === null || cost < best.cost)) best = { split, cost };
  }
  if (best !== null) {
    const split = best.split;
    return items.map((_, index) => index < split ? session : app);
  }
  return items.map((item) => item.slot
    ?? (item.supports.includes(app) ? app : item.supports.includes(session) ? session : app));
}

/** The visible launcher widget instance of `id` in one of `slots`, if any. */
function launcherInstanceIn(layout: WidgetLayout, id: string, slots: readonly UiSlot[]): string | null {
  for (const slot of slots) {
    for (const instanceId of layout.slotPlacements[slot] ?? []) {
      const placement = layout.widgets[instanceId];
      if (placement?.visible && capabilityIdOfWidget(placement.definitionId ?? instanceId) === id) return instanceId;
    }
  }
  return null;
}

/** May `id` be taken off its rail? Everything can, bar a widget its package
 * marks `requiredVisible` (the rail editor locks the same ones). */
export function railItemRemovable(id: string, layout: WidgetLayout = getWidgetLayout()): boolean {
  const instanceId = instanceOfRailItem(id);
  return instanceId === null || layout.widgets[instanceId]?.requiredVisible !== true;
}

/** Take one item off `zone` for good (a drag pulled far from every rail and
 * released): the same outcome as the rail editor's minus. A placed widget is
 * hidden; a launcher leaves through `removeCapability`, so it stays one click
 * away under Technical. */
export function removeRailItem(zone: RailZoneKey, id: string): void {
  if (!railItemRemovable(id)) return;
  const instanceId = instanceOfRailItem(id);
  if (instanceId !== null) {
    updateWidgetLayout((current) => applyWidgetLayoutMutations(
      current, [{ type: "visibility", id: instanceId, visible: false }], listWidgets()));
    return;
  }
  // A launcher living in this zone as its widget leaves from the slot that
  // holds it; a tier icon (or a panel button) leaves from the zone's own slot.
  const slots = RAIL_ZONE_SLOTS[zone];
  const layout = getWidgetLayout();
  const launcher = launcherInstanceIn(layout, id, slots);
  removeCapability(id, (launcher === null ? null : widgetSlotOf(layout, launcher)) ?? slots[0]!);
}

/** Persist `zone`'s complete visual order after a drag or Alt+Arrow. Items
 * may come from another rail: landing here removes them from their old home,
 * so the same item is never drawn twice. Ids the zone cannot hold are
 * ignored. */
export function commitRailZoneOrder(zone: RailZoneKey, order: readonly string[]): void {
  const ids = [...new Set(order)];
  const widgets = listWidgets();
  if (zone === "sidebar") {
    commitWidgetRailOrder(SIDEBAR_RAIL_SLOT, ids, widgets);
    return;
  }
  if (zone !== "header") {
    const tier: RailTier = zone === "top" ? "primary" : "more";
    const slot = RAIL_TIER_SLOT[tier];
    const layout = getWidgetLayout();
    // A launcher already living here as its widget stays that widget and is
    // only reordered: converting it to a tier icon would drop launchers this
    // rail cannot draw as tier icons (no right-pane destination).
    const placedHere = (id: string) => instanceOfRailItem(id) === null ? launcherInstanceIn(layout, id, [slot]) : null;
    const capabilities = ids.filter((id) => instanceOfRailItem(id) === null && placedHere(id) === null);
    const instances = ids.flatMap((id) => {
      const launcher = placedHere(id);
      if (launcher !== null) return [launcher];
      const instanceId = instanceOfRailItem(id);
      return instanceId !== null && railWidgetFits(zone, id) ? [instanceId] : [];
    });
    const mutations: WidgetLayoutMutation[] = [
      // A launcher widget arriving from another area becomes this rail's
      // tier icon.
      ...capabilities.flatMap((id) => hideLauncherWidgets(layout, id)),
      // Re-placing each widget at the slot's end in sequence rebuilds the order.
      ...instances.map((instanceId) => ({ type: "place" as const, id: instanceId, slot })),
    ];
    if (mutations.length > 0) updateWidgetLayout((current) => applyWidgetLayoutMutations(current, mutations, widgets));
    // The rail's one mixed order, exactly as dropped.
    const fits = new Set([...capabilities, ...ids.filter((id) => placedHere(id) !== null),
      ...instances.map((instanceId) => `${WIDGET_ITEM_PREFIX}${instanceId}`)]);
    setCapabilityTierOrder(tier, capabilities, { zone, order: ids.filter((id) => fits.has(id)) });
    return;
  }

  // Header: every item is a widget instance placed in one of its two areas.
  const rows = ids.flatMap((id) => {
    const instanceId = instanceOfRailItem(id);
    if (instanceId !== null) {
      if (!railWidgetFits("header", id)) return [];
      return [{ id, instanceId, capabilityId: null as string | null }];
    }
    if (!headerAcceptsCapability(id)) return [];
    const placed = launcherInstanceIn(getWidgetLayout(), id, HEADER_RAIL_SLOTS);
    if (placed === null) leaveTierRails(id);
    return [{ id, instanceId: placed ?? ensureLauncherWidget(id), capabilityId: id }];
  });
  if (rows.length === 0) return;
  updateWidgetLayout((current) => {
    const header = new Set<UiSlot>(HEADER_RAIL_SLOTS);
    const slots = headerRailSlots(rows.map((row) => {
      const slot = current.widgets[row.instanceId]?.visible ? widgetSlotOf(current, row.instanceId) : null;
      const definitionId = current.widgets[row.instanceId]?.definitionId ?? row.instanceId;
      const definition = widgets.find((widget) => widget.id === definitionId);
      return {
        slot: slot !== null && header.has(slot) ? slot : null,
        supports: definition ? supportedWidgetSlots(definition).filter((candidate) => header.has(candidate)) : [],
      };
    }));
    return applyWidgetLayoutMutations(current, [
      ...rows.flatMap((row) => row.capabilityId === null ? [] : hideLauncherWidgets(current, row.capabilityId)
        .filter((mutation) => mutation.type !== "visibility" || mutation.id !== row.instanceId)),
      ...rows.map((row, index) => ({ type: "place" as const, id: row.instanceId, slot: slots[index]! })),
    ], widgets);
  });
}

/** A one-area widget rail (the Project rail): every item is a widget instance
 * placed in `slot`, in exactly the dropped order. A launcher arriving from
 * another rail becomes its launcher widget here and leaves its old home. */
function commitWidgetRailOrder(slot: UiSlot, ids: readonly string[], widgets: ReturnType<typeof listWidgets>): void {
  const layout = getWidgetLayout();
  const rows = ids.flatMap((id) => {
    const instanceId = instanceOfRailItem(id);
    if (instanceId !== null) {
      return instanceId in layout.widgets && widgetSupports(layout.widgets[instanceId]?.definitionId ?? instanceId, [slot])
        ? [{ instanceId, capabilityId: null as string | null }]
        : [];
    }
    if (!widgetRailAcceptsCapability(id, slot)) return [];
    const placed = launcherInstanceIn(layout, id, [slot]);
    if (placed === null) leaveTierRails(id);
    return [{ instanceId: placed ?? ensureLauncherWidget(id), capabilityId: id }];
  });
  if (rows.length === 0) return;
  updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
    ...rows.flatMap((row) => row.capabilityId === null ? [] : hideLauncherWidgets(current, row.capabilityId, slot)),
    ...rows.map((row) => ({ type: "visibility" as const, id: row.instanceId, visible: true })),
    // Re-placing each widget at the slot's end in sequence rebuilds the order.
    ...rows.map((row) => ({ type: "place" as const, id: row.instanceId, slot })),
  ], widgets));
}
