import { useSyncExternalStore } from "react";
import { UI_SLOTS, type UiSlot, type WidgetAudience, type WidgetKind, type WidgetScope, type WidgetSize } from "@polyth/contracts";
import { getState, subscribeStore } from "../store.ts";

export type WidgetZone = "header" | "left" | "main" | "right" | "bottom" | "floating";
export type { WidgetAudience, WidgetScope, WidgetSize } from "@polyth/contracts";
export type WidgetPlacementTarget = WidgetZone | UiSlot;
export type WidgetLayoutPresetId = "focused" | "balanced" | "manager" | "build-debug" | "custom";
export type WidgetSaveStatus = "saved" | "saving" | "error";

/** Zero-based coordinates on the single 12-column canvas. */
export interface WidgetPosition {
  x: number;
  y: number;
}

export interface WidgetLayoutDefinition {
  id: string;
  pluginId?: string;
  title?: string;
  description?: string;
  kind?: WidgetKind;
  defaultSlot?: UiSlot;
  supportedSlots?: readonly UiSlot[];
  defaultVisible?: boolean;
  order?: number;
  /** @deprecated Use defaultSlot. Kept for persisted v1/client compatibility. */
  zone?: WidgetZone;
  /** @deprecated Use supportedSlots. */
  supportedZones?: readonly WidgetZone[];
  defaultSize?: WidgetSize;
  minSize?: WidgetSize;
  maxSize?: WidgetSize;
  audience?: WidgetAudience;
  showIn?: readonly WidgetAudience[];
  scope?: WidgetScope;
  resizable?: boolean;
  duplicatable?: boolean;
  floating?: boolean;
}

export interface WidgetPlacement {
  visible: boolean;
  size: WidgetSize;
  position: WidgetPosition;
  definitionId?: string;
  pluginId?: string;
  kind?: WidgetKind;
  title?: string;
  description?: string;
  showIn?: WidgetAudience[];
  scope?: WidgetScope;
}

export interface WidgetLayout {
  version: 1;
  audience: WidgetAudience;
  zones: Record<WidgetZone, string[]>;
  /** Non-canvas placement uses the same durable layout. Canvas slots continue
   * to serialize through `zones` so existing layouts migrate without loss. */
  slotPlacements: Partial<Record<UiSlot, string[]>>;
  widgets: Record<string, WidgetPlacement>;
}

export const WIDGET_LAYOUT_KEY = "polyth.widgetLayout";
export const widgetLayoutStorageKey = (projectId: string): string => `${WIDGET_LAYOUT_KEY}.${projectId}`;
export const WIDGET_ZONES: readonly WidgetZone[] = ["header", "left", "main", "right", "bottom", "floating"];
export const MAX_GRID_ROWS = 50;
/** Removed shell actions stay retired even when an older persisted layout
 * still describes them as visible. This is a migration deny-list, not a
 * second placement system. */
const RETIRED_WIDGET_IDS = new Set(["shell.new-session"]);
export const WIDGET_ZONE_SLOTS: Record<WidgetZone, UiSlot> = {
  header: "workspace.header",
  left: "workspace.left",
  main: "workspace.main",
  right: "workspace.right",
  bottom: "workspace.bottom",
  floating: "workspace.floating",
};

const SLOT_WIDGET_ZONES = new Map<UiSlot, WidgetZone>(
  Object.entries(WIDGET_ZONE_SLOTS).map(([zone, slot]) => [slot, zone as WidgetZone]),
);

export function widgetSlotFromZone(zone: WidgetZone): UiSlot {
  return WIDGET_ZONE_SLOTS[zone];
}

export function widgetZoneFromSlot(slot: UiSlot): WidgetZone | null {
  return SLOT_WIDGET_ZONES.get(slot) ?? null;
}
export const BUILTIN_WIDGET_IDS = [
  "core.composer",
  "core.chat",
  "terminal.shell",
  "goals.current",
  "git.recent",
  "knowledge.notes",
  "core.quick-actions",
  "session.work-status",
  "session.activity",
  "preview.app",
  "files.explorer",
  "files.project-map",
  "github.overview",
  "schedule.tasks",
  "multirun.runs",
  "fusion.answers",
  "walkthrough.review",
  "usage.session",
  "usage.quotas",
  "usage.project",
  "usage.sessions-table",
  "usage.quota-summary",
] as const;

const DEFAULT_ZONE: Record<string, WidgetZone> = {
  "core.quick-actions": "header",
  "goals.current": "header",
  "usage.quota-summary": "header",
  "files.explorer": "left",
  "files.project-map": "left",
  "knowledge.notes": "left",
  "core.composer": "main",
  "core.chat": "main",
  "multirun.runs": "main",
  "fusion.answers": "main",
  "walkthrough.review": "main",
  "usage.quotas": "main",
  "usage.project": "main",
  "github.overview": "right",
  "git.recent": "right",
  "session.work-status": "right",
  "session.activity": "right",
  "usage.session": "right",
  "usage.sessions-table": "right",
  "schedule.tasks": "right",
  "terminal.shell": "bottom",
  "preview.app": "bottom",
};

const DEFAULT_SIZE: WidgetSize = { w: 6, h: 4 };
const DEFAULT_SIZE_BY_ID: Record<string, WidgetSize> = {
  "core.composer": { w: 12, h: 6 },
  "core.chat": { w: 12, h: 8 },
  "core.quick-actions": { w: 6, h: 2 },
  "goals.current": { w: 6, h: 4 },
  "files.explorer": { w: 6, h: 7 },
  "files.project-map": { w: 5, h: 4 },
  "git.recent": { w: 6, h: 6 },
  "terminal.shell": { w: 12, h: 5 },
  "knowledge.notes": { w: 6, h: 5 },
  "session.work-status": { w: 6, h: 4 },
  "session.activity": { w: 6, h: 4 },
  "preview.app": { w: 12, h: 6 },
  "github.overview": { w: 6, h: 6 },
  "schedule.tasks": { w: 6, h: 5 },
  "multirun.runs": { w: 12, h: 6 },
  "fusion.answers": { w: 12, h: 6 },
  "walkthrough.review": { w: 12, h: 6 },
  "usage.session": { w: 4, h: 3 },
  "usage.quotas": { w: 12, h: 7 },
  "usage.project": { w: 8, h: 6 },
  "usage.sessions-table": { w: 6, h: 5 },
  "usage.quota-summary": { w: 4, h: 2 },
};
const DEFAULT_VISIBLE = new Set<string>([
  "core.composer", "core.quick-actions", "goals.current", "files.project-map",
  "git.recent", "knowledge.notes", "session.work-status", "session.activity",
]);

const emptyZones = (): Record<WidgetZone, string[]> => ({
  header: [], left: [], main: [], right: [], bottom: [], floating: [],
});

const emptySlotPlacements = (): Partial<Record<UiSlot, string[]>> => ({});

function defaultSlotFor(definition: WidgetLayoutDefinition): UiSlot {
  if (definition.defaultSlot) return definition.defaultSlot;
  return widgetSlotFromZone(definition.zone ?? DEFAULT_ZONE[definition.id] ?? "main");
}

function supportedSlotsFor(definition: WidgetLayoutDefinition): readonly UiSlot[] {
  if (definition.supportedSlots && definition.supportedSlots.length > 0) return definition.supportedSlots;
  if (definition.supportedZones && definition.supportedZones.length > 0) {
    return definition.supportedZones.map(widgetSlotFromZone);
  }
  const slot = defaultSlotFor(definition);
  return definition.floating && !widgetZoneFromSlot(slot)
    ? [slot, "workspace.floating"]
    : definition.floating
      ? [slot, "workspace.floating"]
      : [slot];
}

const clampSize = (value: unknown): WidgetSize => {
  const size = value as Partial<WidgetSize> | undefined;
  const w = typeof size?.w === "number" && Number.isFinite(size.w)
    ? Math.min(12, Math.max(1, Math.round(size.w)))
    : DEFAULT_SIZE.w;
  const h = typeof size?.h === "number" && Number.isFinite(size.h)
    ? Math.min(MAX_GRID_ROWS, Math.max(1, Math.round(size.h)))
    : DEFAULT_SIZE.h;
  return { w, h };
};

const clampPosition = (value: unknown): WidgetPosition => {
  const position = value as Partial<WidgetPosition> | undefined;
  const x = typeof position?.x === "number" && Number.isFinite(position.x)
    ? Math.min(11, Math.max(0, Math.round(position.x)))
    : 0;
  const y = typeof position?.y === "number" && Number.isFinite(position.y)
    ? Math.min(999, Math.max(0, Math.round(position.y)))
    : 0;
  return { x, y };
};

function constrainedSize(value: unknown, definition?: WidgetLayoutDefinition): WidgetSize {
  const size = clampSize(value);
  const min = definition?.minSize ? clampSize(definition.minSize) : { w: 1, h: 1 };
  const max = definition?.maxSize ? clampSize(definition.maxSize) : { w: 12, h: MAX_GRID_ROWS };
  return {
    w: Math.max(min.w, Math.min(max.w, size.w)),
    h: Math.max(min.h, Math.min(max.h, size.h)),
  };
}

function showInFor(definition: WidgetLayoutDefinition): WidgetAudience[] | undefined {
  if (definition.showIn && definition.showIn.length > 0) return [...definition.showIn];
  if (!definition.audience) return undefined;
  const rank: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
  return (["simple", "standard", "power"] as const).filter(
    (audience) => rank[audience] >= rank[definition.audience!],
  );
}

function placementFor(
  definition: WidgetLayoutDefinition,
  visible: boolean,
  position: WidgetPosition = { x: 0, y: 0 },
): WidgetPlacement {
  return {
    visible,
    size: constrainedSize(
      definition.defaultSize ?? DEFAULT_SIZE_BY_ID[definition.id] ?? DEFAULT_SIZE,
      definition,
    ),
    position: clampPosition(position),
    definitionId: definition.id,
    ...(definition.pluginId ? { pluginId: definition.pluginId } : {}),
    ...(definition.kind ? { kind: definition.kind } : {}),
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(showInFor(definition) ? { showIn: showInFor(definition)! } : {}),
    ...(definition.scope ? { scope: definition.scope } : {}),
  };
}

export function createDefaultWidgetLayout(
  known: readonly (string | WidgetLayoutDefinition)[] = BUILTIN_WIDGET_IDS,
): WidgetLayout {
  const zones = emptyZones();
  const slotPlacements = emptySlotPlacements();
  const widgets: Record<string, WidgetPlacement> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const item of known) {
    const definition = typeof item === "string" ? { id: item } : item;
    const id = definition.id;
    if (RETIRED_WIDGET_IDS.has(id)) continue;
    const slot = defaultSlotFor(definition);
    const zone = widgetZoneFromSlot(slot);
    const visible = definition.defaultVisible ?? DEFAULT_VISIBLE.has(id);
    const size = constrainedSize(
      definition.defaultSize ?? DEFAULT_SIZE_BY_ID[id] ?? DEFAULT_SIZE,
      definition,
    );
    if (zone && visible && x > 0 && x + size.w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (zone) zones[zone].push(id);
    else slotPlacements[slot] = [...(slotPlacements[slot] ?? []), id];
    widgets[id] = placementFor(
      definition,
      visible,
      zone && visible ? { x, y } : { x: 0, y: 0 },
    );
    if (zone && visible) {
      x += size.w;
      rowHeight = Math.max(rowHeight, size.h);
    }
  }
  return { version: 1, audience: "standard", zones, slotPlacements, widgets };
}

const isAudience = (value: unknown): value is WidgetAudience =>
  value === "simple" || value === "standard" || value === "power";

/** Parse untrusted browser state against the live catalog. Unknown ids and
 * duplicate placements are ignored; missing catalog items remain available in
 * the library and receive their default placement. */
export function parseWidgetLayout(
  raw: string | null,
  knownItems: readonly (string | WidgetLayoutDefinition)[] = BUILTIN_WIDGET_IDS,
): WidgetLayout {
  const definitions = knownItems
    .map((item) => typeof item === "string" ? { id: item } : item)
    .filter((item) => !RETIRED_WIDGET_IDS.has(item.id));
  const knownIds = definitions.map((item) => item.id);
  const definitionById = new Map(definitions.map((item) => [item.id, item]));
  const fallback = createDefaultWidgetLayout(definitions);
  try {
    const data = JSON.parse(raw ?? "") as Partial<WidgetLayout> & {
      zones?: Partial<Record<WidgetZone | "top", unknown>>;
      slotPlacements?: Partial<Record<UiSlot, unknown>>;
    };
    if (!data || data.version !== 1 || typeof data.zones !== "object" || typeof data.widgets !== "object") {
      return fallback;
    }
    // A catalog contribution can disappear when its plugin is disabled or
    // uninstalled. Preserve only self-describing orphan placements so the UI
    // can offer Enable/Remove without ever attempting to render unknown code.
    const persistedInstanceIds = Object.entries(data.widgets).flatMap(([instanceId, rawPlacement]) => {
      const value = rawPlacement as Partial<WidgetPlacement> | undefined;
      return !RETIRED_WIDGET_IDS.has(instanceId)
        && !RETIRED_WIDGET_IDS.has(value?.definitionId ?? instanceId)
        && !knownIds.includes(instanceId) && definitionById.has(value?.definitionId ?? instanceId)
        ? [instanceId]
        : [];
    }).slice(0, 128);
    const orphanIds = Object.entries(data.widgets).flatMap(([instanceId, rawPlacement]) => {
      const value = rawPlacement as Partial<WidgetPlacement> | undefined;
      return !RETIRED_WIDGET_IDS.has(instanceId)
        && !RETIRED_WIDGET_IDS.has(value?.definitionId ?? instanceId)
        && !knownIds.includes(instanceId)
        && !persistedInstanceIds.includes(instanceId)
        && !definitionById.has(value?.definitionId ?? instanceId)
        && typeof value?.pluginId === "string"
        && typeof value?.title === "string"
        ? [instanceId]
        : [];
    }).slice(0, 128);
    const known = new Set([...knownIds, ...persistedInstanceIds, ...orphanIds]);
    const seen = new Set<string>();
    const zones = emptyZones();
    const slotPlacements = emptySlotPlacements();
    for (const zone of WIDGET_ZONES) {
      const values = zone === "header"
        ? data.zones?.header ?? data.zones?.top
        : data.zones?.[zone];
      if (!Array.isArray(values)) continue;
      for (const id of values) {
        if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
        seen.add(id);
        zones[zone].push(id);
      }
    }
    for (const slot of UI_SLOTS) {
      const values = data.slotPlacements?.[slot];
      if (!Array.isArray(values)) continue;
      for (const id of values) {
        if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
        seen.add(id);
        const zone = widgetZoneFromSlot(slot);
        if (zone) zones[zone].push(id);
        else slotPlacements[slot] = [...(slotPlacements[slot] ?? []), id];
      }
    }
    for (const id of knownIds) {
      if (seen.has(id)) continue;
      const definition = definitionById.get(id)!;
      const slot = defaultSlotFor(definition);
      const zone = widgetZoneFromSlot(slot);
      if (zone) zones[zone].push(id);
      else slotPlacements[slot] = [...(slotPlacements[slot] ?? []), id];
    }
    for (const id of [...persistedInstanceIds, ...orphanIds]) {
      if (!seen.has(id)) zones.main.push(id);
    }
    const widgets: Record<string, WidgetPlacement> = {};
    for (const id of [...knownIds, ...persistedInstanceIds, ...orphanIds]) {
      const value = data.widgets?.[id] as Partial<WidgetPlacement> | undefined;
      const definition = definitionById.get(value?.definitionId ?? id);
      const base = definition ? fallback.widgets[definition.id] : undefined;
      const definitionId = definition?.id ?? value?.definitionId ?? id;
      widgets[id] = {
        visible: typeof value?.visible === "boolean" ? value.visible : base?.visible ?? false,
        size: constrainedSize(value?.size ?? base?.size ?? DEFAULT_SIZE, definition),
        position: clampPosition(value?.position ?? base?.position),
        definitionId,
        ...(definition?.pluginId || value?.pluginId
          ? { pluginId: definition?.pluginId ?? value!.pluginId! }
          : {}),
        ...(definition?.kind || value?.kind ? { kind: definition?.kind ?? value!.kind! } : {}),
        ...(definition?.title || value?.title ? { title: definition?.title ?? value!.title! } : {}),
        ...(definition?.description || value?.description
          ? { description: definition?.description ?? value!.description! }
          : {}),
        ...(Array.isArray(value?.showIn)
          ? { showIn: value.showIn.filter(isAudience) }
          : base?.showIn ? { showIn: [...base.showIn] } : {}),
        ...(value?.scope === "global" || value?.scope === "workspace" || value?.scope === "plugin"
          ? { scope: value.scope }
          : base?.scope ? { scope: base.scope } : {}),
      };
    }
    return {
      version: 1,
      audience: isAudience(data.audience) ? data.audience : "standard",
      zones,
      slotPlacements,
      widgets,
    };
  } catch {
    return fallback;
  }
}

export function serializeWidgetLayout(layout: WidgetLayout): string {
  return JSON.stringify(layout);
}

export function widgetZoneOf(layout: WidgetLayout, id: string): WidgetZone | null {
  for (const zone of WIDGET_ZONES) if (layout.zones[zone].includes(id)) return zone;
  return null;
}

export function widgetSlotOf(layout: WidgetLayout, id: string): UiSlot | null {
  const zone = widgetZoneOf(layout, id);
  if (zone) return widgetSlotFromZone(zone);
  for (const slot of UI_SLOTS) {
    if (layout.slotPlacements[slot]?.includes(id)) return slot;
  }
  return null;
}

export function widgetDefinitionId(layout: WidgetLayout, instanceId: string): string {
  return layout.widgets[instanceId]?.definitionId ?? instanceId;
}

export interface WidgetPlacementCheck {
  ok: boolean;
  reason?: string;
}

export function canPlaceWidget(
  definition: WidgetLayoutDefinition | undefined,
  target: WidgetPlacementTarget,
): WidgetPlacementCheck {
  if (!definition) return { ok: false, reason: "This widget’s plugin is unavailable." };
  const slot = isWidgetZone(target) ? widgetSlotFromZone(target) : target;
  const supported = supportedSlotsFor(definition);
  if (!supported.includes(slot)) {
    const zone = widgetZoneFromSlot(slot);
    return {
      ok: false,
      reason: zone
        ? `${definition.title ?? "This widget"} doesn’t fit in ${zone === "header" ? "the header" : `the ${zone} zone`}.`
        : `${definition.title ?? "This widget"} can’t be placed in ${slot}.`,
    };
  }
  if (slot === "workspace.header" && (definition.minSize?.h ?? definition.defaultSize?.h ?? 1) > 3) {
    return { ok: false, reason: `${definition.title ?? "This widget"} needs more height than the header provides.` };
  }
  return { ok: true };
}

const isWidgetZone = (value: WidgetPlacementTarget): value is WidgetZone =>
  WIDGET_ZONES.includes(value as WidgetZone);

export function moveWidgetToSlot(
  layout: WidgetLayout,
  id: string,
  slot: UiSlot,
  index = (widgetZoneFromSlot(slot)
    ? layout.zones[widgetZoneFromSlot(slot)!]
    : layout.slotPlacements[slot] ?? []).length,
  definition?: WidgetLayoutDefinition,
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  if (definition && !canPlaceWidget(definition, slot).ok) return layout;
  const zones = Object.fromEntries(
    WIDGET_ZONES.map((name) => [name, layout.zones[name].filter((widgetId) => widgetId !== id)]),
  ) as Record<WidgetZone, string[]>;
  const slotPlacements = Object.fromEntries(
    Object.entries(layout.slotPlacements).map(([name, ids]) => [
      name,
      (ids ?? []).filter((widgetId) => widgetId !== id),
    ]),
  ) as Partial<Record<UiSlot, string[]>>;
  const zone = widgetZoneFromSlot(slot);
  const target = zone
    ? zones[zone]
    : (slotPlacements[slot] ??= []);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  if (current.visible) {
    const zonesUnchanged = WIDGET_ZONES.every((name) => {
      const before = layout.zones[name];
      const after = zones[name];
      return before.length === after.length && before.every((widgetId, i) => widgetId === after[i]);
    });
    const slotsUnchanged = UI_SLOTS.every((name) => {
      const before = layout.slotPlacements[name] ?? [];
      const after = slotPlacements[name] ?? [];
      return before.length === after.length && before.every((widgetId, i) => widgetId === after[i]);
    });
    if (zonesUnchanged && slotsUnchanged) return layout;
  }
  return {
    ...layout,
    zones,
    slotPlacements,
    widgets: { ...layout.widgets, [id]: { ...current, visible: true } },
  };
}

export function moveWidget(
  layout: WidgetLayout,
  id: string,
  zone: WidgetZone,
  index = layout.zones[zone].length,
  definition?: WidgetLayoutDefinition,
): WidgetLayout {
  return moveWidgetToSlot(layout, id, widgetSlotFromZone(zone), index, definition);
}

export function setWidgetVisible(layout: WidgetLayout, id: string, visible: boolean): WidgetLayout {
  const current = layout.widgets[id];
  if (!current || current.visible === visible) return layout;
  if (!visible) {
    return { ...layout, widgets: { ...layout.widgets, [id]: { ...current, visible: false } } };
  }
  const others = Object.entries(layout.widgets)
    .filter(([otherId, placement]) => otherId !== id && placement.visible);
  const collides = others.some(([, placement]) =>
    overlaps(current.position, current.size, placement.position, placement.size));
  const position = collides
    ? {
        x: 0,
        y: others.reduce(
          (bottom, [, placement]) => Math.max(bottom, placement.position.y + placement.size.h),
          0,
        ),
      }
    : current.position;
  return {
    ...layout,
    widgets: { ...layout.widgets, [id]: { ...current, visible: true, position } },
  };
}

export function setWidgetSize(
  layout: WidgetLayout,
  id: string,
  size: WidgetSize,
  definition?: WidgetLayoutDefinition,
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current || definition?.resizable === false) return layout;
  const next = constrainedSize(size, definition);
  if (next.w === current.size.w && next.h === current.size.h) return layout;
  const resized = {
    ...layout,
    widgets: { ...layout.widgets, [id]: { ...current, size: next } },
  };
  return setWidgetPosition(resized, id, current.position);
}

function overlaps(
  a: WidgetPosition,
  aSize: WidgetSize,
  b: WidgetPosition,
  bSize: WidgetSize,
): boolean {
  return a.x < b.x + bSize.w
    && a.x + aSize.w > b.x
    && a.y < b.y + bSize.h
    && a.y + aSize.h > b.y;
}

/** Move on the free-form canvas. Collisions are resolved downward so widgets
 * remain separated by the CSS grid gap instead of stacking over each other. */
export function setWidgetPosition(
  layout: WidgetLayout,
  id: string,
  position: WidgetPosition,
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  let next = clampPosition({ ...position, x: Math.min(position.x, 12 - current.size.w) });
  const others = Object.entries(layout.widgets)
    .filter(([otherId, placement]) => otherId !== id && placement.visible);
  for (let pass = 0; pass < others.length + 1; pass++) {
    const collision = others.find(([, placement]) =>
      overlaps(next, current.size, placement.position, placement.size));
    if (!collision) break;
    next = clampPosition({ x: next.x, y: collision[1].position.y + collision[1].size.h });
  }
  if (next.x === current.position.x && next.y === current.position.y) return layout;
  return {
    ...layout,
    widgets: { ...layout.widgets, [id]: { ...current, position: next } },
  };
}

export function setWidgetAudience(layout: WidgetLayout, audience: WidgetAudience): WidgetLayout {
  return layout.audience === audience ? layout : { ...layout, audience };
}

export function setWidgetShowIn(
  layout: WidgetLayout,
  id: string,
  showIn: readonly WidgetAudience[],
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  const next = [...new Set(showIn.filter(isAudience))];
  if (
    current.showIn?.length === next.length
    && current.showIn.every((audience, index) => audience === next[index])
  ) return layout;
  return { ...layout, widgets: { ...layout.widgets, [id]: { ...current, showIn: next } } };
}

export function setWidgetScope(layout: WidgetLayout, id: string, scope: WidgetScope): WidgetLayout {
  const current = layout.widgets[id];
  if (!current || current.scope === scope) return layout;
  return { ...layout, widgets: { ...layout.widgets, [id]: { ...current, scope } } };
}

export function setWidgetIdentity(
  layout: WidgetLayout,
  id: string,
  identity: { title?: string; description?: string },
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  const title = identity.title?.trim() || undefined;
  const description = identity.description?.trim() || undefined;
  if (current.title === title && current.description === description) return layout;
  return {
    ...layout,
    widgets: { ...layout.widgets, [id]: { ...current, title, description } },
  };
}

export function forgetWidget(layout: WidgetLayout, id: string): WidgetLayout {
  if (!layout.widgets[id]) return layout;
  const widgets = { ...layout.widgets };
  delete widgets[id];
  const zones = Object.fromEntries(
    WIDGET_ZONES.map((zone) => [zone, layout.zones[zone].filter((item) => item !== id)]),
  ) as Record<WidgetZone, string[]>;
  const slotPlacements = Object.fromEntries(
    Object.entries(layout.slotPlacements).map(([slot, ids]) => [
      slot,
      (ids ?? []).filter((item) => item !== id),
    ]),
  ) as Partial<Record<UiSlot, string[]>>;
  return { ...layout, widgets, zones, slotPlacements };
}

function nextInstanceId(layout: WidgetLayout, definitionId: string): string {
  let number = 2;
  while (`${definitionId}#${number}` in layout.widgets) number++;
  return `${definitionId}#${number}`;
}

export function duplicateWidget(
  layout: WidgetLayout,
  id: string,
  definition: WidgetLayoutDefinition | undefined,
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current || !definition?.duplicatable) return layout;
  const instanceId = nextInstanceId(layout, definition.id);
  const slot = widgetSlotOf(layout, id) ?? defaultSlotFor(definition);
  const widgets = {
    ...layout.widgets,
    [instanceId]: {
      ...current,
      definitionId: definition.id,
      position: { x: current.position.x, y: current.position.y + current.size.h },
      title: current.title ? `${current.title} copy` : definition.title ? `${definition.title} copy` : undefined,
    },
  };
  const zone = widgetZoneFromSlot(slot);
  if (zone) {
    const zones = { ...layout.zones, [zone]: [...layout.zones[zone], instanceId] };
    const duplicated = { ...layout, widgets, zones };
    return setWidgetPosition(duplicated, instanceId, widgets[instanceId]!.position);
  }
  const slotPlacements = {
    ...layout.slotPlacements,
    [slot]: [...(layout.slotPlacements[slot] ?? []), instanceId],
  };
  return { ...layout, widgets, slotPlacements };
}

export type WidgetLayoutMutation =
  | { type: "move"; id: string; zone: WidgetZone; index?: number }
  | { type: "place"; id: string; slot: UiSlot; index?: number }
  | { type: "visibility"; id: string; visible: boolean }
  | { type: "resize"; id: string; size: WidgetSize }
  | { type: "position"; id: string; position: WidgetPosition }
  | { type: "audience"; audience: WidgetAudience }
  | { type: "show-in"; id: string; showIn: WidgetAudience[] }
  | { type: "scope"; id: string; scope: WidgetScope }
  | { type: "identity"; id: string; title?: string; description?: string }
  | { type: "duplicate"; id: string }
  | { type: "forget"; id: string }
  | { type: "preset"; preset: WidgetLayoutPresetId };

function definitionsById(
  definitions: readonly WidgetLayoutDefinition[],
): Map<string, WidgetLayoutDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

/** One mutation engine for pointer/keyboard editing, quick add, guided setup,
 * and text customization. Unsupported placement/size requests are no-ops. */
export function applyWidgetLayoutMutations(
  layout: WidgetLayout,
  mutations: readonly WidgetLayoutMutation[],
  definitions: readonly WidgetLayoutDefinition[] = [],
): WidgetLayout {
  const byId = definitionsById(definitions);
  return mutations.reduce((current, mutation) => {
    const definition = "id" in mutation
      ? byId.get(widgetDefinitionId(current, mutation.id))
      : undefined;
    if ("id" in mutation && definitions.length > 0 && !definition && mutation.type !== "forget") {
      return current;
    }
    switch (mutation.type) {
      case "move":
        return moveWidget(
          current,
          mutation.id,
          mutation.zone,
          mutation.index ?? current.zones[mutation.zone].length,
          definition,
        );
      case "place":
        return moveWidgetToSlot(
          current,
          mutation.id,
          mutation.slot,
          mutation.index ?? (
            widgetZoneFromSlot(mutation.slot)
              ? current.zones[widgetZoneFromSlot(mutation.slot)!].length
              : current.slotPlacements[mutation.slot]?.length ?? 0
          ),
          definition,
        );
      case "visibility":
        return setWidgetVisible(current, mutation.id, mutation.visible);
      case "resize":
        return setWidgetSize(current, mutation.id, mutation.size, definition);
      case "position":
        return setWidgetPosition(current, mutation.id, mutation.position);
      case "audience":
        return setWidgetAudience(current, mutation.audience);
      case "show-in":
        return setWidgetShowIn(current, mutation.id, mutation.showIn);
      case "scope":
        return setWidgetScope(current, mutation.id, mutation.scope);
      case "identity":
        return setWidgetIdentity(current, mutation.id, mutation);
      case "duplicate":
        return duplicateWidget(current, mutation.id, definition);
      case "forget":
        return forgetWidget(current, mutation.id);
      case "preset":
        return applyWidgetLayoutPreset(current, mutation.preset);
    }
  }, layout);
}

const PRESET_VISIBLE: Record<Exclude<WidgetLayoutPresetId, "custom">, readonly string[]> = {
  focused: ["core.composer", "core.quick-actions", "goals.current"],
  balanced: ["core.composer", "core.quick-actions", "goals.current", "files.project-map", "git.recent", "knowledge.notes", "session.work-status", "session.activity"],
  manager: ["core.composer", "goals.current", "knowledge.notes", "schedule.tasks", "usage.session", "usage.quotas", "walkthrough.review"],
  "build-debug": ["core.composer", "files.explorer", "files.project-map", "git.recent", "terminal.shell", "preview.app", "session.activity", "session.work-status"],
};

export function applyWidgetLayoutPreset(
  layout: WidgetLayout,
  preset: WidgetLayoutPresetId,
): WidgetLayout {
  if (preset === "custom") return layout;
  const visible = new Set(PRESET_VISIBLE[preset]);
  const base = createDefaultWidgetLayout(Object.entries(layout.widgets).map(([id, placement]) => ({
    id,
    pluginId: placement.pluginId,
    title: placement.title,
    description: placement.description,
    kind: placement.kind,
    defaultSlot: widgetSlotOf(layout, id) ?? "workspace.main",
    defaultSize: placement.size,
    showIn: placement.showIn,
    scope: placement.scope,
  })));
  return {
    ...base,
    audience: preset === "focused" ? "simple" : preset === "manager" ? "standard" : layout.audience,
    widgets: Object.fromEntries(Object.entries(base.widgets).map(([id, placement]) => [
      id,
      { ...placement, visible: visible.has(id) },
    ])),
  };
}

const read = (projectId: string | null): string | null => {
  if (projectId === null) return null;
  try {
    const key = widgetLayoutStorageKey(projectId);
    const projectLayout = localStorage.getItem(key);
    if (projectLayout !== null) return projectLayout;

    const legacyLayout = localStorage.getItem(WIDGET_LAYOUT_KEY);
    if (legacyLayout === null) return null;
    localStorage.setItem(key, legacyLayout);
    localStorage.removeItem(WIDGET_LAYOUT_KEY);
    return legacyLayout;
  } catch {
    return null;
  }
};
const write = (layout: WidgetLayout, projectId: string | null): boolean => {
  if (projectId === null) return true;
  try {
    localStorage.setItem(widgetLayoutStorageKey(projectId), serializeWidgetLayout(layout));
    return true;
  } catch {
    return false;
  }
};

let activeProjectId = getState().activeProjectId;
let state = parseWidgetLayout(read(activeProjectId));
const listeners = new Set<() => void>();
const statusListeners = new Set<() => void>();
let history: WidgetLayout[] = [];
let saveStatus: WidgetSaveStatus = "saved";

// Drag-resize commits many layouts per second; a trailing timer batches them
// into one localStorage serialization per pause while listeners still see
// every state synchronously. pagehide flushes so nothing is lost on exit.
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushWrite(): void {
  if (writeTimer === null) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  saveStatus = write(state, activeProjectId) ? "saved" : "error";
  for (const listener of [...statusListeners]) listener();
}

function scheduleWrite(): void {
  if (writeTimer !== null) return;
  saveStatus = "saving";
  for (const listener of [...statusListeners]) listener();
  writeTimer = setTimeout(() => {
    writeTimer = null;
    saveStatus = write(state, activeProjectId) ? "saved" : "error";
    for (const listener of [...statusListeners]) listener();
  }, 150);
  // Node timers would keep the test process alive; browsers return a number.
  (writeTimer as unknown as { unref?: () => void }).unref?.();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushWrite);

subscribeStore(() => {
  const nextProjectId = getState().activeProjectId;
  if (nextProjectId === activeProjectId) return;
  flushWrite();
  activeProjectId = nextProjectId;
  state = parseWidgetLayout(read(activeProjectId));
  history = [];
  saveStatus = "saved";
  for (const listener of [...listeners]) listener();
  for (const listener of [...statusListeners]) listener();
});

function commit(next: WidgetLayout, recordHistory = true, immediate = false): void {
  if (next === state) return;
  if (recordHistory) history = [...history.slice(-39), state];
  state = next;
  if (immediate) {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
    saveStatus = write(state, activeProjectId) ? "saved" : "error";
  } else {
    scheduleWrite();
  }
  for (const listener of [...listeners]) listener();
  for (const listener of [...statusListeners]) listener();
}

export function getWidgetLayout(): WidgetLayout {
  return state;
}

export function updateWidgetLayout(
  update: WidgetLayout | ((current: WidgetLayout) => WidgetLayout),
  options: { immediate?: boolean } = {},
): void {
  commit(typeof update === "function" ? update(state) : update, true, options.immediate === true);
}

export function undoWidgetLayout(): void {
  const previous = history.at(-1);
  if (!previous) return;
  history = history.slice(0, -1);
  commit(previous, false);
}

export function canUndoWidgetLayout(): boolean {
  return history.length > 0;
}

export function getWidgetSaveStatus(): WidgetSaveStatus {
  return saveStatus;
}

export function retryWidgetSave(): void {
  if (writeTimer !== null) flushWrite();
  else {
    saveStatus = "saving";
    for (const listener of [...statusListeners]) listener();
    saveStatus = write(state, activeProjectId) ? "saved" : "error";
    for (const listener of [...statusListeners]) listener();
  }
}

export function ensureWidgetIds(ids: readonly string[]): void {
  ensureWidgets(ids.map((id) => ({ id })));
}

export function ensureWidgets(definitions: readonly WidgetLayoutDefinition[]): void {
  const missing = definitions.filter((definition) => !(definition.id in state.widgets));
  const defaults = createDefaultWidgetLayout(definitions);
  const zones = Object.fromEntries(WIDGET_ZONES.map((zone) => [
    zone,
    [...state.zones[zone], ...missing.flatMap((definition) =>
      defaults.zones[zone].includes(definition.id) ? [definition.id] : [])],
  ])) as Record<WidgetZone, string[]>;
  const slotPlacements = { ...state.slotPlacements };
  for (const slot of UI_SLOTS) {
    const added = missing.flatMap((definition) =>
      defaults.slotPlacements[slot]?.includes(definition.id) ? [definition.id] : []);
    if (added.length > 0) slotPlacements[slot] = [...(slotPlacements[slot] ?? []), ...added];
  }
  let changed = missing.length > 0;
  const widgets = { ...state.widgets };
  for (const definition of definitions) {
    const current = widgets[definition.id];
    if (!current) {
      widgets[definition.id] = defaults.widgets[definition.id]!;
      continue;
    }
    const metadata = placementFor(definition, current.visible);
    const next = {
      ...current,
      definitionId: definition.id,
      pluginId: metadata.pluginId,
      kind: metadata.kind,
      title: current.title ?? metadata.title,
      description: current.description ?? metadata.description,
      showIn: current.showIn ?? metadata.showIn,
      scope: current.scope ?? metadata.scope,
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      widgets[definition.id] = next;
      changed = true;
    }
  }
  if (changed) commit({ ...state, zones, slotPlacements, widgets }, false);
}

export function resetWidgetLayout(
  definitions: readonly (string | WidgetLayoutDefinition)[] = Object.keys(state.widgets),
): void {
  commit(createDefaultWidgetLayout(definitions));
}

export function useWidgetLayout(): WidgetLayout {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getWidgetLayout,
  );
}

export function useWidgetStoreStatus(): { saveStatus: WidgetSaveStatus; canUndo: boolean } {
  const snapshot = useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    () => `${saveStatus}:${history.length}`,
  );
  const [status, count] = snapshot.split(":");
  return {
    saveStatus: status as WidgetSaveStatus,
    canUndo: Number(count) > 0,
  };
}
