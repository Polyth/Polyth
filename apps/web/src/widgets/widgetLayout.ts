import { useSyncExternalStore } from "react";

export type WidgetZone = "header" | "left" | "main" | "right" | "bottom" | "floating";
export type WidgetAudience = "simple" | "standard" | "power";
export type WidgetScope = "global" | "workspace" | "plugin";
export type WidgetLayoutPresetId = "focused" | "balanced" | "manager" | "build-debug" | "custom";
export type WidgetSaveStatus = "saved" | "saving" | "error";

export interface WidgetSize {
  w: number;
  h: number;
}

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
  zone?: WidgetZone;
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
  title?: string;
  description?: string;
  showIn?: WidgetAudience[];
  scope?: WidgetScope;
}

export interface WidgetLayout {
  version: 1;
  audience: WidgetAudience;
  zones: Record<WidgetZone, string[]>;
  widgets: Record<string, WidgetPlacement>;
}

export const WIDGET_LAYOUT_KEY = "polyth.widgetLayout";
export const WIDGET_ZONES: readonly WidgetZone[] = ["header", "left", "main", "right", "bottom", "floating"];
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
] as const;

const DEFAULT_ZONE: Record<string, WidgetZone> = {
  "core.quick-actions": "header",
  "goals.current": "header",
  "files.explorer": "left",
  "files.project-map": "left",
  "knowledge.notes": "left",
  "core.composer": "main",
  "core.chat": "main",
  "multirun.runs": "main",
  "fusion.answers": "main",
  "walkthrough.review": "main",
  "github.overview": "right",
  "git.recent": "right",
  "session.work-status": "right",
  "session.activity": "right",
  "usage.session": "right",
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
};
const DEFAULT_VISIBLE = new Set<string>([
  "core.composer", "core.quick-actions", "goals.current", "files.project-map",
  "git.recent", "knowledge.notes", "session.work-status", "session.activity",
]);

const emptyZones = (): Record<WidgetZone, string[]> => ({
  header: [], left: [], main: [], right: [], bottom: [], floating: [],
});

const clampSize = (value: unknown): WidgetSize => {
  const size = value as Partial<WidgetSize> | undefined;
  const w = typeof size?.w === "number" && Number.isFinite(size.w)
    ? Math.min(12, Math.max(1, Math.round(size.w)))
    : DEFAULT_SIZE.w;
  const h = typeof size?.h === "number" && Number.isFinite(size.h)
    ? Math.min(12, Math.max(1, Math.round(size.h)))
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
  const max = definition?.maxSize ? clampSize(definition.maxSize) : { w: 12, h: 12 };
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
  const widgets: Record<string, WidgetPlacement> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const item of known) {
    const definition = typeof item === "string" ? { id: item } : item;
    const id = definition.id;
    const zone = definition.zone ?? DEFAULT_ZONE[id] ?? "main";
    const visible = DEFAULT_VISIBLE.has(id);
    const size = constrainedSize(
      definition.defaultSize ?? DEFAULT_SIZE_BY_ID[id] ?? DEFAULT_SIZE,
      definition,
    );
    if (visible && x > 0 && x + size.w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    zones[zone].push(id);
    widgets[id] = placementFor(definition, visible, visible ? { x, y } : { x: 0, y: 0 });
    if (visible) {
      x += size.w;
      rowHeight = Math.max(rowHeight, size.h);
    }
  }
  return { version: 1, audience: "standard", zones, widgets };
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
  const definitions = knownItems.map((item) => typeof item === "string" ? { id: item } : item);
  const knownIds = definitions.map((item) => item.id);
  const definitionById = new Map(definitions.map((item) => [item.id, item]));
  const fallback = createDefaultWidgetLayout(definitions);
  try {
    const data = JSON.parse(raw ?? "") as Partial<WidgetLayout> & {
      zones?: Partial<Record<WidgetZone | "top", unknown>>;
    };
    if (!data || data.version !== 1 || typeof data.zones !== "object" || typeof data.widgets !== "object") {
      return fallback;
    }
    // A catalog contribution can disappear when its plugin is disabled or
    // uninstalled. Preserve only self-describing orphan placements so the UI
    // can offer Enable/Remove without ever attempting to render unknown code.
    const persistedInstanceIds = Object.entries(data.widgets).flatMap(([instanceId, rawPlacement]) => {
      const value = rawPlacement as Partial<WidgetPlacement> | undefined;
      return !knownIds.includes(instanceId) && definitionById.has(value?.definitionId ?? instanceId)
        ? [instanceId]
        : [];
    }).slice(0, 128);
    const orphanIds = Object.entries(data.widgets).flatMap(([instanceId, rawPlacement]) => {
      const value = rawPlacement as Partial<WidgetPlacement> | undefined;
      return !knownIds.includes(instanceId)
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
    for (const id of knownIds) {
      if (!seen.has(id)) zones[DEFAULT_ZONE[id] ?? "main"].push(id);
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

export function widgetDefinitionId(layout: WidgetLayout, instanceId: string): string {
  return layout.widgets[instanceId]?.definitionId ?? instanceId;
}

export interface WidgetPlacementCheck {
  ok: boolean;
  reason?: string;
}

export function canPlaceWidget(
  definition: WidgetLayoutDefinition | undefined,
  zone: WidgetZone,
): WidgetPlacementCheck {
  if (!definition) return { ok: false, reason: "This widget’s plugin is unavailable." };
  const supported = definition.supportedZones
    ?? (definition.floating
      ? [definition.zone ?? "main", "floating"]
      : [definition.zone ?? "main"]);
  if (!supported.includes(zone)) {
    return {
      ok: false,
      reason: `${definition.title ?? "This widget"} doesn’t fit in ${zone === "header" ? "the header" : `the ${zone} zone`}.`,
    };
  }
  if (zone === "header" && (definition.minSize?.h ?? definition.defaultSize?.h ?? 1) > 3) {
    return { ok: false, reason: `${definition.title ?? "This widget"} needs more height than the header provides.` };
  }
  return { ok: true };
}

export function moveWidget(
  layout: WidgetLayout,
  id: string,
  zone: WidgetZone,
  index = layout.zones[zone].length,
  definition?: WidgetLayoutDefinition,
): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  if (definition && !canPlaceWidget(definition, zone).ok) return layout;
  const zones = Object.fromEntries(
    WIDGET_ZONES.map((name) => [name, layout.zones[name].filter((widgetId) => widgetId !== id)]),
  ) as Record<WidgetZone, string[]>;
  const target = zones[zone];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  // No-op moves (already visible at that exact position) return the same
  // layout so commit() can skip the persist + listener fanout.
  if (current.visible) {
    const unchanged = WIDGET_ZONES.every((name) => {
      const before = layout.zones[name];
      const after = zones[name];
      return before.length === after.length && before.every((widgetId, i) => widgetId === after[i]);
    });
    if (unchanged) return layout;
  }
  return {
    ...layout,
    zones,
    widgets: { ...layout.widgets, [id]: { ...current, visible: true } },
  };
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
  return { ...layout, widgets, zones };
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
  const zone = widgetZoneOf(layout, id) ?? definition.zone ?? "main";
  const widgets = {
    ...layout.widgets,
    [instanceId]: {
      ...current,
      definitionId: definition.id,
      position: { x: current.position.x, y: current.position.y + current.size.h },
      title: current.title ? `${current.title} copy` : definition.title ? `${definition.title} copy` : undefined,
    },
  };
  const zones = { ...layout.zones, [zone]: [...layout.zones[zone], instanceId] };
  const duplicated = { ...layout, widgets, zones };
  return setWidgetPosition(duplicated, instanceId, widgets[instanceId]!.position);
}

export type WidgetLayoutMutation =
  | { type: "move"; id: string; zone: WidgetZone; index?: number }
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
  manager: ["core.composer", "goals.current", "knowledge.notes", "schedule.tasks", "usage.session", "walkthrough.review"],
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

const read = (): string | null => {
  try { return localStorage.getItem(WIDGET_LAYOUT_KEY); } catch { return null; }
};
const write = (layout: WidgetLayout): boolean => {
  try {
    localStorage.setItem(WIDGET_LAYOUT_KEY, serializeWidgetLayout(layout));
    return true;
  } catch {
    return false;
  }
};

let state = parseWidgetLayout(read());
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
  saveStatus = write(state) ? "saved" : "error";
  for (const listener of [...statusListeners]) listener();
}

function scheduleWrite(): void {
  if (writeTimer !== null) return;
  saveStatus = "saving";
  for (const listener of [...statusListeners]) listener();
  writeTimer = setTimeout(() => {
    writeTimer = null;
    saveStatus = write(state) ? "saved" : "error";
    for (const listener of [...statusListeners]) listener();
  }, 150);
  // Node timers would keep the test process alive; browsers return a number.
  (writeTimer as unknown as { unref?: () => void }).unref?.();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushWrite);

function commit(next: WidgetLayout, recordHistory = true, immediate = false): void {
  if (next === state) return;
  if (recordHistory) history = [...history.slice(-39), state];
  state = next;
  if (immediate) {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
    saveStatus = write(state) ? "saved" : "error";
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
    saveStatus = write(state) ? "saved" : "error";
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
  if (changed) commit({ ...state, zones, widgets }, false);
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
