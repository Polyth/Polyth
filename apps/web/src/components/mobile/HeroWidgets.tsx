// UX-MOBILE-01: fresh-chat content is a widget rail, not hardcoded chrome.
// Built-ins use the `session.empty.widgets` slot; a plugin can add/replacement
// widgets through the same seam. Users can hide/reorder the built-ins locally.
import { useSyncExternalStore, type ReactNode } from "react";
import Sheet, { SheetRow } from "./Sheet.tsx";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { useCustomizeActive } from "../../useShiftArmed.ts";

export type HeroWidgetId = "starters" | "recent";

export interface HeroWidgetPrefs {
  order: HeroWidgetId[];
  hidden: HeroWidgetId[];
}

const KEY = "polyth.heroWidgets.v1";
const HERO_WIDGET_MIME = "application/x-polyth-hero-widget";
const DEFAULTS: HeroWidgetPrefs = { order: ["starters", "recent"], hidden: [] };
const ids: HeroWidgetId[] = ["starters", "recent"];
let prefs = read();
const listeners = new Set<() => void>();

function read(): HeroWidgetPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<HeroWidgetPrefs>;
    const order = Array.isArray(raw.order)
      ? [...new Set(raw.order.filter((id): id is HeroWidgetId => ids.includes(id as HeroWidgetId)))]
      : [];
    return {
      order: [...order, ...ids.filter((id) => !order.includes(id))],
      hidden: Array.isArray(raw.hidden)
        ? [...new Set(raw.hidden.filter((id): id is HeroWidgetId => ids.includes(id as HeroWidgetId)))]
        : [],
    };
  } catch {
    return { ...DEFAULTS, order: [...DEFAULTS.order], hidden: [] };
  }
}

function commit(next: HeroWidgetPrefs): void {
  prefs = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function useHeroWidgetPrefs(): HeroWidgetPrefs {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => prefs,
    () => DEFAULTS,
  );
}

/** Frame a slot contribution; hidden widgets render nothing, order is CSS. */
export function HeroWidget({ id, children }: { id: HeroWidgetId; children: ReactNode }) {
  const value = useHeroWidgetPrefs();
  const customizeActive = useCustomizeActive();
  if (value.hidden.includes(id)) return null;
  return (
    <section
      className={`hero-widget hero-widget-${id}`}
      style={{ order: value.order.indexOf(id) }}
      draggable={customizeActive}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(HERO_WIDGET_MIME, id);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(HERO_WIDGET_MIME)) event.preventDefault();
      }}
      onDrop={(event) => {
        const dragged = event.dataTransfer.getData(HERO_WIDGET_MIME) as HeroWidgetId;
        if (!ids.includes(dragged) || dragged === id) return;
        event.preventDefault();
        const order = value.order.filter((item) => item !== dragged);
        order.splice(order.indexOf(id), 0, dragged);
        commit({ ...value, order });
      }}
    >{children}</section>
  );
}

export function HeroWidgetSettings({ onClose }: { onClose: () => void }) {
  const value = useHeroWidgetPrefs();
  const label: Record<HeroWidgetId, string> = { starters: tr("mobile.herowidgets.quickStarters"), recent: tr("mobile.herowidgets.recentSessions") };
  const move = (id: HeroWidgetId, delta: number) => {
    const at = value.order.indexOf(id);
    const target = value.order[at + delta];
    if (!target) return;
    const order = [...value.order];
    order.splice(at, 1);
    order.splice(order.indexOf(target), 0, id);
    commit({ ...value, order });
  };
  return (
    <Sheet title={tr("mobile.herowidgets.newChatWidgets")} className="hero-widget-sheet" onClose={onClose}>
      <p className="sheet-empty">{tr("mobile.herowidgets.chooseWhatAppearsBeforeTheComposerWidgets")}</p>
      <div role="listbox" aria-label={tr("mobile.herowidgets.newChatWidgets")}>
        {value.order.map((id, index) => {
          const hidden = value.hidden.includes(id);
          return (
            <SheetRow
              key={id}
              title={label[id]}
              meta={hidden ? tr("projectfolderdialog.hidden") : tr("mobile.herowidgets.visible")}
              icon={id === "starters" ? <Icon.target /> : <Icon.clock />}
              onClick={() => commit({
                ...value,
                hidden: hidden ? value.hidden.filter((item) => item !== id) : [...value.hidden, id],
              })}
              trailing={<span className="sheet-row-tools">
                <button type="button" className="sheet-row-tool" aria-label={tr("mobile.herowidgets.moveValueUp", { value: label[id] })} disabled={index === 0} onClick={() => move(id, -1)}>↑</button>
                <button type="button" className="sheet-row-tool" aria-label={tr("mobile.herowidgets.moveValueDown", { value: label[id] })} disabled={index === value.order.length - 1} onClick={() => move(id, 1)}>↓</button>
              </span>}
            />
          );
        })}
      </div>
    </Sheet>
  );
}
