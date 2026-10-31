// The new-chat screen's board: catalog widgets the person placed on it (a
// clock, the weather, provider limits, a Home Assistant tile…). One board per
// account, synced as `core.hero-board` — a preference id of its own, so a
// client that predates it cannot strip it from `core.hero-widgets`. An item
// may be pinned to one project ("Only in this project"). The board also owns
// the screen's single order: built-in widget ids and item ids in one list.
import type { JsonObject, PanelItemSize } from "@polyth/contracts";
import {
  getHeroWidgetPrefs,
  HERO_WIDGET_IDS,
  moveListItem,
  setHeroWidgetPrefs,
  type HeroWidgetId,
} from "./heroWidgetPrefs.ts";

export interface HeroBoardItem {
  id: string;
  /** Catalog widget id. */
  widget: string;
  size: PanelItemSize;
  config: JsonObject;
  /** Shown only in this project; absent means every project. */
  projectId?: string;
  /** Switched off in Customize; keeps its settings. */
  hidden?: boolean;
}

export interface HeroBoard {
  items: HeroBoardItem[];
  /** Built-in ids and item ids, top to bottom. Ids missing from it follow the
   *  built-ins' own order, then the items in the order they were added. */
  order: string[];
}

/** What the board needs to know about a catalog widget. */
export interface HeroBoardWidget {
  id: string;
  duplicatable?: boolean;
  panelSizes?: readonly PanelItemSize[];
  panelDefaultSize?: PanelItemSize;
}

export const HERO_BOARD_KEY = "polyth.heroBoard.v1";
export const HERO_BOARD_SIZES: readonly PanelItemSize[] = ["compact", "standard", "wide", "large"];
const listeners = new Set<() => void>();

const isSize = (value: unknown): value is PanelItemSize => HERO_BOARD_SIZES.includes(value as PanelItemSize);
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

/** Sizes a widget offers on the board. One without panel sizes keeps the
 *  full-width row such widgets always had on this screen. */
export function heroItemSizes(widget: HeroBoardWidget): readonly PanelItemSize[] {
  const sizes = widget.panelSizes?.filter(isSize) ?? [];
  return sizes.length > 0 ? sizes : ["wide"];
}

export function heroItemDefaultSize(widget: HeroBoardWidget): PanelItemSize {
  const sizes = heroItemSizes(widget);
  return widget.panelDefaultSize && sizes.includes(widget.panelDefaultSize) ? widget.panelDefaultSize : sizes[0]!;
}

/** Tolerant reader: junk entries drop, duplicate ids keep the first. */
export function normalizeHeroBoard(value: unknown): HeroBoard {
  const raw = isObject(value) ? value as { items?: unknown; order?: unknown } : {};
  const seen = new Set<string>();
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((entry): HeroBoardItem[] => {
    if (!isObject(entry)) return [];
    const { id, widget, size, config, projectId, hidden } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof widget !== "string" || !widget || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      widget,
      size: isSize(size) ? size : "wide",
      config: isObject(config) ? config : {},
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      ...(hidden === true ? { hidden: true } : {}),
    }];
  });
  const order = Array.isArray(raw.order)
    ? [...new Set(raw.order.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return { items, order };
}

/** The screen's order: the stored one, then built-ins it lacks (in their own
 *  order), then items it lacks. Unknown ids are dropped. */
export function heroOrder(board: HeroBoard, builtinOrder: readonly string[] = HERO_WIDGET_IDS): string[] {
  const itemIds = board.items.map((item) => item.id);
  const known = new Set([...builtinOrder, ...itemIds]);
  return [...new Set([...board.order.filter((id) => known.has(id)), ...builtinOrder, ...itemIds])];
}

/** Items that render in `projectId` (hidden ones only while editing). */
export function heroItemsFor(board: HeroBoard, projectId: string | null, includeHidden = false): HeroBoardItem[] {
  return board.items.filter((item) =>
    (includeHidden || !item.hidden) && (!item.projectId || item.projectId === projectId));
}

function nextId(board: HeroBoard, widgetId: string): string {
  let id = widgetId;
  for (let n = 2; board.items.some((item) => item.id === id); n++) id = `${widgetId}#${n}`;
  return id;
}

/** Add a widget at the bottom. A widget that cannot be duplicated and is
 *  already on the board is shown again instead (`id` names it either way). */
export function addHeroBoardItem(
  board: HeroBoard,
  widget: HeroBoardWidget,
  init: Partial<Pick<HeroBoardItem, "config" | "projectId">> = {},
): { board: HeroBoard; id: string } {
  const existing = widget.duplicatable ? undefined : board.items.find((item) => item.widget === widget.id);
  if (existing) return { board: updateHeroBoardItem(board, existing.id, { hidden: false }), id: existing.id };
  const id = nextId(board, widget.id);
  const item: HeroBoardItem = {
    id,
    widget: widget.id,
    size: heroItemDefaultSize(widget),
    config: init.config ?? {},
    ...(init.projectId ? { projectId: init.projectId } : {}),
  };
  return { board: { ...board, items: [...board.items, item] }, id };
}

/** A copy right below the source, with its own id and the same settings. */
export function duplicateHeroBoardItem(board: HeroBoard, id: string, builtinOrder?: readonly string[]): HeroBoard {
  const source = board.items.find((item) => item.id === id);
  if (!source) return board;
  const copy: HeroBoardItem = { ...source, id: nextId(board, source.widget), config: structuredClone(source.config) };
  delete copy.hidden;
  const order = heroOrder(board, builtinOrder);
  order.splice(order.indexOf(id) + 1, 0, copy.id);
  return { items: [...board.items, copy], order };
}

export function updateHeroBoardItem(
  board: HeroBoard,
  id: string,
  patch: Partial<Pick<HeroBoardItem, "size" | "config" | "projectId" | "hidden">>,
): HeroBoard {
  return {
    ...board,
    items: board.items.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      // `undefined` in the patch clears the field rather than storing it.
      if (!next.projectId) delete next.projectId;
      if (!next.hidden) delete next.hidden;
      return next;
    }),
  };
}

export function removeHeroBoardItem(board: HeroBoard, id: string): HeroBoard {
  return { items: board.items.filter((item) => item.id !== id), order: board.order.filter((entry) => entry !== id) };
}

export interface LegacyHeroPlacement {
  /** Widget-layout instance id. */
  instanceId: string;
  widget: HeroBoardWidget;
  config: JsonObject;
}

/** Adopt widgets an older client placed in a project's own layout. They
 *  become items of that project (`projectId` undefined when every project
 *  shares one interface). Ids derive from the placement, so a layout that
 *  comes back from another device is not adopted twice. */
export function adoptLegacyHeroPlacements(
  board: HeroBoard,
  placements: readonly LegacyHeroPlacement[],
  projectId: string | undefined,
): HeroBoard {
  const fresh = placements.flatMap(({ instanceId, widget, config }): HeroBoardItem[] => {
    const id = `legacy:${projectId ?? "shared"}:${instanceId}`;
    if (board.items.some((item) => item.id === id)) return [];
    return [{ id, widget: widget.id, size: heroItemDefaultSize(widget), config, ...(projectId ? { projectId } : {}) }];
  });
  return fresh.length === 0 ? board : { ...board, items: [...board.items, ...fresh] };
}

function read(): HeroBoard {
  try { return normalizeHeroBoard(JSON.parse(localStorage.getItem(HERO_BOARD_KEY) ?? "null")); }
  catch { return { items: [], order: [] }; }
}

let board = read();

export function getHeroBoard(): HeroBoard {
  return board;
}

export function setHeroBoard(value: HeroBoard): void {
  board = normalizeHeroBoard(value);
  try { localStorage.setItem(HERO_BOARD_KEY, JSON.stringify(board)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function updateHeroBoard(update: (current: HeroBoard) => HeroBoard): void {
  const next = update(board);
  if (next !== board) setHeroBoard(next);
}

/** Settings-sync adapter write. */
export function replaceHeroBoard(value: unknown): void {
  setHeroBoard(normalizeHeroBoard(value));
}

export function subscribeHeroBoard(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Switch one entry of the screen off, as its Customize switch does: a
 *  built-in joins `hidden`, a board item keeps its settings. */
export function hideHeroEntry(id: string): void {
  if (HERO_WIDGET_IDS.includes(id as HeroWidgetId)) {
    const prefs = getHeroWidgetPrefs();
    if (!prefs.hidden.includes(id as HeroWidgetId)) setHeroWidgetPrefs({ ...prefs, hidden: [...prefs.hidden, id as HeroWidgetId] });
    return;
  }
  if (board.items.some((item) => item.id === id)) setHeroBoard(updateHeroBoardItem(board, id, { hidden: true }));
}

/** Move one entry of the screen's order. The built-ins' relative order is
 *  mirrored into `heroWidgetPrefs.order` so clients that predate the board
 *  keep following it. */
export function moveHeroEntry(id: string, index: number): void {
  const prefs = getHeroWidgetPrefs();
  const order = moveListItem(heroOrder(board, prefs.order), id, index);
  setHeroBoard({ ...board, order });
  setHeroWidgetPrefs({
    ...prefs,
    order: order.filter((entry): entry is HeroWidgetId => HERO_WIDGET_IDS.includes(entry as HeroWidgetId)),
  });
}
