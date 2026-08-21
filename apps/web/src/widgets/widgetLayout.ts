import { useSyncExternalStore } from "react";

export type WidgetZone = "main" | "left" | "right" | "top" | "bottom";
export type WidgetAudience = "simple" | "standard" | "power";
export type WidgetLayoutPresetId = "focused" | "balanced" | "manager" | "build-debug" | "custom";

export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetLayoutDefinition {
  id: string;
  zone?: WidgetZone;
  defaultSize?: WidgetSize;
}

export interface WidgetPlacement {
  visible: boolean;
  size: WidgetSize;
}

export interface WidgetLayout {
  version: 1;
  audience: WidgetAudience;
  zones: Record<WidgetZone, string[]>;
  widgets: Record<string, WidgetPlacement>;
}

export const WIDGET_LAYOUT_KEY = "polyth.widgetLayout";
export const WIDGET_ZONES: readonly WidgetZone[] = ["top", "left", "main", "right", "bottom"];
export const BUILTIN_WIDGET_IDS = [
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
  "github.overview",
  "schedule.tasks",
  "multirun.runs",
  "fusion.answers",
  "walkthrough.review",
  "usage.session",
] as const;

const DEFAULT_ZONE: Record<string, WidgetZone> = {
  "core.quick-actions": "top",
  "goals.current": "top",
  "files.explorer": "left",
  "knowledge.notes": "left",
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
  "core.chat": { w: 12, h: 8 },
  "core.quick-actions": { w: 6, h: 2 },
  "goals.current": { w: 6, h: 4 },
  "files.explorer": { w: 6, h: 7 },
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
  "core.chat", "core.quick-actions", "goals.current", "git.recent", "terminal.shell",
]);

const emptyZones = (): Record<WidgetZone, string[]> => ({
  top: [], left: [], main: [], right: [], bottom: [],
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

export function createDefaultWidgetLayout(
  known: readonly (string | WidgetLayoutDefinition)[] = BUILTIN_WIDGET_IDS,
): WidgetLayout {
  const zones = emptyZones();
  const widgets: Record<string, WidgetPlacement> = {};
  for (const item of known) {
    const id = typeof item === "string" ? item : item.id;
    const zone = typeof item === "string" ? DEFAULT_ZONE[id] ?? "main" : item.zone ?? DEFAULT_ZONE[id] ?? "main";
    const size = typeof item === "string"
      ? DEFAULT_SIZE_BY_ID[id] ?? DEFAULT_SIZE
      : clampSize(item.defaultSize ?? DEFAULT_SIZE_BY_ID[id] ?? DEFAULT_SIZE);
    zones[zone].push(id);
    widgets[id] = {
      visible: DEFAULT_VISIBLE.has(id),
      size: { ...size },
    };
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
  knownIds: readonly string[] = BUILTIN_WIDGET_IDS,
): WidgetLayout {
  const fallback = createDefaultWidgetLayout(knownIds);
  try {
    const data = JSON.parse(raw ?? "") as Partial<WidgetLayout>;
    if (!data || data.version !== 1 || typeof data.zones !== "object" || typeof data.widgets !== "object") {
      return fallback;
    }
    const known = new Set(knownIds);
    const seen = new Set<string>();
    const zones = emptyZones();
    for (const zone of WIDGET_ZONES) {
      const values = data.zones?.[zone];
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
    const widgets: Record<string, WidgetPlacement> = {};
    for (const id of knownIds) {
      const value = data.widgets?.[id] as Partial<WidgetPlacement> | undefined;
      widgets[id] = {
        visible: typeof value?.visible === "boolean" ? value.visible : fallback.widgets[id]!.visible,
        size: clampSize(value?.size ?? fallback.widgets[id]!.size),
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

export function moveWidget(
  layout: WidgetLayout,
  id: string,
  zone: WidgetZone,
  index = layout.zones[zone].length,
): WidgetLayout {
  if (!(id in layout.widgets)) return layout;
  const zones = Object.fromEntries(
    WIDGET_ZONES.map((name) => [name, layout.zones[name].filter((widgetId) => widgetId !== id)]),
  ) as Record<WidgetZone, string[]>;
  const target = zones[zone];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  return {
    ...layout,
    zones,
    widgets: { ...layout.widgets, [id]: { ...layout.widgets[id]!, visible: true } },
  };
}

export function setWidgetVisible(layout: WidgetLayout, id: string, visible: boolean): WidgetLayout {
  const current = layout.widgets[id];
  if (!current || current.visible === visible) return layout;
  return { ...layout, widgets: { ...layout.widgets, [id]: { ...current, visible } } };
}

export function setWidgetSize(layout: WidgetLayout, id: string, size: WidgetSize): WidgetLayout {
  const current = layout.widgets[id];
  if (!current) return layout;
  return { ...layout, widgets: { ...layout.widgets, [id]: { ...current, size: clampSize(size) } } };
}

export function setWidgetAudience(layout: WidgetLayout, audience: WidgetAudience): WidgetLayout {
  return layout.audience === audience ? layout : { ...layout, audience };
}

const PRESET_VISIBLE: Record<Exclude<WidgetLayoutPresetId, "custom">, readonly string[]> = {
  focused: ["core.chat", "core.quick-actions", "goals.current"],
  balanced: ["core.chat", "core.quick-actions", "goals.current", "git.recent", "terminal.shell"],
  manager: ["core.chat", "goals.current", "knowledge.notes", "schedule.tasks", "usage.session", "walkthrough.review"],
  "build-debug": ["core.chat", "files.explorer", "git.recent", "terminal.shell", "preview.app", "session.activity"],
};

export function applyWidgetLayoutPreset(
  layout: WidgetLayout,
  preset: WidgetLayoutPresetId,
): WidgetLayout {
  if (preset === "custom") return layout;
  const visible = new Set(PRESET_VISIBLE[preset]);
  const base = createDefaultWidgetLayout(Object.keys(layout.widgets));
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
const write = (layout: WidgetLayout): void => {
  try { localStorage.setItem(WIDGET_LAYOUT_KEY, serializeWidgetLayout(layout)); } catch { /* private mode */ }
};

let state = parseWidgetLayout(read());
const listeners = new Set<() => void>();

function commit(next: WidgetLayout): void {
  state = next;
  write(state);
  for (const listener of [...listeners]) listener();
}

export function getWidgetLayout(): WidgetLayout {
  return state;
}

export function updateWidgetLayout(update: WidgetLayout | ((current: WidgetLayout) => WidgetLayout)): void {
  commit(typeof update === "function" ? update(state) : update);
}

export function ensureWidgetIds(ids: readonly string[]): void {
  ensureWidgets(ids.map((id) => ({ id })));
}

export function ensureWidgets(definitions: readonly WidgetLayoutDefinition[]): void {
  const missing = definitions.filter((definition) => !(definition.id in state.widgets));
  if (missing.length === 0) return;
  const defaults = createDefaultWidgetLayout(missing);
  const zones = Object.fromEntries(WIDGET_ZONES.map((zone) => [
    zone,
    [...state.zones[zone], ...defaults.zones[zone]],
  ])) as Record<WidgetZone, string[]>;
  commit({ ...state, zones, widgets: { ...state.widgets, ...defaults.widgets } });
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
