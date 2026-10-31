// Fresh-chat content is a widget board, not hardcoded chrome.
// Built-ins use the `session.empty.widgets` slot; catalog widgets the person
// adds live on the account's board (heroBoard.ts, HeroBoard.tsx). Both share
// one order and are arranged from the screen's Customize panel
// (HeroCustomize.tsx) or in place: by drag while Shift or the workspace Edit
// mode is on, and by grip in the touch edit mode (HeroEditMode.tsx). The
// preferences are mirrored through the account settings sync.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { PanelItemSize } from "@polyth/contracts";
import { tr } from "../../i18n/index.ts";
import { useHeroArranging, useHeroEditing } from "../../heroEditing.ts";
import {
  getHeroWidgetPrefs,
  HERO_APPS_DEFAULTS,
  HERO_CHROME_DEFAULTS,
  HERO_RECENT_DEFAULTS,
  HERO_WIDGET_IDS,
  subscribeHeroWidgetPrefs,
  type HeroWidgetId,
  type HeroWidgetPrefs,
} from "../../heroWidgetPrefs.ts";
import {
  getHeroBoard,
  heroItemsFor,
  heroOrder,
  hideHeroEntry,
  moveHeroEntry,
  subscribeHeroBoard,
  type HeroBoard,
} from "../../heroBoard.ts";
import { DragHandleIcon, Icon, MinusIcon } from "../ui/index.ts";
import { useSortable } from "./useSortable.ts";

const HERO_WIDGET_MIME = "application/x-polyth-hero-widget";
const SERVER_PREFS: HeroWidgetPrefs = {
  order: [...HERO_WIDGET_IDS],
  hidden: [],
  recent: HERO_RECENT_DEFAULTS,
  chrome: HERO_CHROME_DEFAULTS,
  apps: HERO_APPS_DEFAULTS,
};
const EMPTY_BOARD: HeroBoard = { items: [], order: [] };

export function useHeroWidgetPrefs(): HeroWidgetPrefs {
  return useSyncExternalStore(subscribeHeroWidgetPrefs, getHeroWidgetPrefs, () => SERVER_PREFS);
}

export function useHeroBoard(): HeroBoard {
  return useSyncExternalStore(subscribeHeroBoard, getHeroBoard, () => EMPTY_BOARD);
}

/** The screen's one order: built-ins and board items together. */
export function useHeroOrder(): string[] {
  const prefs = useHeroWidgetPrefs();
  const board = useHeroBoard();
  return useMemo(() => heroOrder(board, prefs.order), [board, prefs.order]);
}

/** A built-in's name, as the Customize panel lists it. */
export function heroBuiltinTitle(id: HeroWidgetId): string {
  if (id === "starters") return tr("workspace.builtinsurfaces.quickStarters");
  if (id === "recent") return tr("mobile.herowidgets.recentSessions");
  return tr("workspace.heroapps.title");
}

interface HeroArrange {
  handleProps: ReturnType<typeof useSortable<string>>["handleProps"];
  dragging: string | null;
}

const HeroArrangeContext = createContext<HeroArrange | null>(null);

/** The widget grid. In the touch edit mode its tiles reorder by their grip:
 *  the nearest tile centre is the drop target, in rows as in columns. */
export function HeroWidgetHost({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  const prefs = useHeroWidgetPrefs();
  const board = useHeroBoard();
  const order = useHeroOrder();
  const shown = useMemo(() => {
    const items = new Set(heroItemsFor(board, projectId).map((item) => item.id));
    return order.filter((id) => items.has(id)
      || (HERO_WIDGET_IDS.includes(id as HeroWidgetId) && !prefs.hidden.includes(id as HeroWidgetId)));
  }, [board, order, prefs.hidden, projectId]);
  const sortable = useSortable({
    ids: shown,
    // `index` counts shown tiles; the stored order also keeps hidden ones.
    onMove: (id, index) => {
      const anchor = shown.filter((entry) => entry !== id)[index];
      const without = order.filter((entry) => entry !== id);
      moveHeroEntry(id, anchor === undefined ? without.length : without.indexOf(anchor));
    },
  });
  const arrange = useMemo<HeroArrange>(
    () => ({ handleProps: sortable.handleProps, dragging: sortable.dragging }),
    [sortable.handleProps, sortable.dragging],
  );
  return (
    <HeroArrangeContext.Provider value={arrange}>
      <div
        className="hero-widget-host"
        ref={(node) => { sortable.listRef.current = node; }}
        data-dragging={sortable.dragging ? "true" : undefined}
      >{children}</div>
    </HeroArrangeContext.Provider>
  );
}

/** Frame a built-in contribution or a board item. Hidden built-ins render
 *  nothing; position is CSS `order`, the tile's width is its `size`. */
export function HeroWidget({ id, size, title, children }: {
  id: string;
  size?: PanelItemSize;
  /** The tile's name for its edit controls; built-ins know their own. */
  title?: string;
  children: ReactNode;
}) {
  const value = useHeroWidgetPrefs();
  const order = useHeroOrder();
  const arranging = useHeroArranging();
  const touchEditing = useHeroEditing();
  const arrange = useContext(HeroArrangeContext);
  if (value.hidden.includes(id as HeroWidgetId)) return null;
  const builtin = HERO_WIDGET_IDS.includes(id as HeroWidgetId);
  const label = title ?? (builtin ? heroBuiltinTitle(id as HeroWidgetId) : id);
  return (
    <section
      className={`hero-widget hero-widget-${id.replace(/[^a-z0-9-]/gi, "-")}`}
      data-size={size}
      data-sort-id={id}
      data-editing={touchEditing ? "true" : undefined}
      data-dragging={arrange?.dragging === id ? "true" : undefined}
      style={{ order: order.indexOf(id) }}
      // The touch edit mode drags by the grip; HTML drag is for the mouse.
      draggable={arranging && !touchEditing}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(HERO_WIDGET_MIME, id);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(HERO_WIDGET_MIME)) event.preventDefault();
      }}
      onDrop={(event) => {
        const dragged = event.dataTransfer.getData(HERO_WIDGET_MIME);
        if (!order.includes(dragged) || dragged === id) return;
        event.preventDefault();
        moveHeroEntry(dragged, order.filter((item) => item !== dragged).indexOf(id));
      }}
    >
      {children}
      {touchEditing && arrange && (
        <span className="hero-widget-edit">
          <button
            type="button"
            className="hero-widget-hide"
            aria-label={tr("workspace.herocustomize.hideValue", { value: label })}
            onClick={() => hideHeroEntry(id)}
          ><Icon icon={MinusIcon} size="sm" /></button>
          <button
            type="button"
            className="hero-widget-grip"
            aria-label={tr("workspace.herocustomize.reorderValue", { value: label })}
            {...arrange.handleProps(id)}
          ><Icon icon={DragHandleIcon} size="sm" /></button>
        </span>
      )}
    </section>
  );
}
