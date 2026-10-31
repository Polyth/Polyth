// The one editor behind every icon rail and shell zone (top rail, right rail,
// sidebar, header actions, composer, status bar). Two parts:
//   * "Shown here": what the rail renders, in its order. Drag a row (or
//     Alt+↑/↓ on its handle) to reorder; the minus removes it.
//   * the library: compact tiles for everything that could be added, grouped
//     into tools and widgets. A tile already living in another rail carries
//     that rail's name — choosing it MOVES it here, so nothing is ever shown
//     twice.
// Placement mutations are the caller's (`RailEditorEntry.add/remove` and
// `reorder`); this component only presents the model from railEditorModel.ts.
import { useId, useMemo, useState, type ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import type { TranslationKey } from "../i18n/index.ts";
import { useRailDragZone } from "../railDrag.ts";
import {
  RAIL_EDITOR_SEARCH_THRESHOLD,
  dedupeRailEntries,
  railEditorSections,
  type RailEditorEntry,
} from "../railEditorModel.ts";
import { AddIcon, DragHandleIcon, Icon, LockIcon, MinusIcon, SearchIcon } from "./ui/index.ts";

export interface RailEditorAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

const ZONE_LABEL: Partial<Record<UiSlot, TranslationKey>> = {
  "app.header.center": "raileditor.zoneTopRail",
  "workspace.rail": "raileditor.zoneRightRail",
  "app.header.leading": "raileditor.zoneHeader",
  "app.header.actions": "raileditor.zoneHeader",
  "session.header.actions": "raileditor.zoneHeader",
  "sidebar.toolbar": "raileditor.zoneSidebar",
  "sidebar.rail": "sidebar.projectRail",
  "sidebar.footer": "raileditor.zoneSidebarFooter",
  "composer.leading": "raileditor.zoneComposer",
  "composer.trailing": "raileditor.zoneComposer",
  "session.composer.before": "raileditor.zoneAboveComposer",
  "session.footer": "raileditor.zoneSessionFooter",
  "app.statusbar.leading": "raileditor.zoneStatusBar",
  "app.statusbar.trailing": "raileditor.zoneStatusBar",
};

/** Short human name of a rail/zone ("Top rail", "Status bar", …). */
export function railZoneLabel(slot: UiSlot): string {
  const key = ZONE_LABEL[slot];
  return key ? tr(key) : tr("raileditor.zoneOther");
}

function Tile({ entry }: { entry: RailEditorEntry }) {
  const where = entry.elsewhere ? railZoneLabel(entry.elsewhere) : null;
  const action = where
    ? tr("raileditor.moveHere", { label: entry.label, zone: where })
    : tr("raileditor.addItem", { label: entry.label });
  return (
    <button
      type="button"
      className={`rail-editor-tile${where ? " is-elsewhere" : ""}`}
      title={entry.description ? `${action}\n${entry.description}` : action}
      aria-label={action}
      onClick={entry.add}
    >
      <span className="rail-editor-glyph" aria-hidden="true">{entry.icon}</span>
      <span className="rail-editor-tile-label">{entry.label}</span>
      {where
        ? <span className="rail-editor-tile-where" aria-hidden="true">{where}</span>
        : <span className="rail-editor-tile-add" aria-hidden="true"><Icon icon={AddIcon} size="sm" /></span>}
    </button>
  );
}

export default function RailEditor({
  slot,
  title,
  entries,
  reorder,
  actions = [],
  sheet = false,
  dragId,
  candidatesLabel,
  note,
}: {
  slot: UiSlot;
  title: string;
  entries: readonly RailEditorEntry[];
  /** Persist a new order of the shown keys; omit for zones without order. */
  reorder?: (keys: string[]) => void;
  actions?: readonly RailEditorAction[];
  /** Rendered inside the phone sheet, which supplies its own title bar. */
  sheet?: boolean;
  /** Drag zone id; defaults to one per slot. */
  dragId?: string;
  /** Heading of the "could be added" tiles; defaults to Tools. */
  candidatesLabel?: string;
  /** Footer note; defaults to the one-home-per-item rule. */
  note?: string;
}) {
  const [query, setQuery] = useState("");
  const headingId = useId();
  const unique = useMemo(() => dedupeRailEntries(entries), [entries]);
  const searchable = unique.length > RAIL_EDITOR_SEARCH_THRESHOLD;
  const sections = railEditorSections(unique, searchable ? query : "");
  const shownKeys = sections.shown.map((entry) => entry.key);
  const byKey = new Map(sections.shown.map((entry) => [entry.key, entry]));
  const canReorder = reorder !== undefined && !query && shownKeys.length > 1;
  const drag = useRailDragZone({
    id: dragId ?? `rail-editor:${slot}`,
    axis: "y",
    ids: shownKeys,
    isDraggable: () => canReorder,
    accepts: () => false,
    canLeave: () => false,
    commit: (order) => reorder?.(order),
  });
  const totalShown = unique.filter((entry) => entry.shown).length;
  const nothingToAdd = sections.tools.length === 0 && sections.widgets.length === 0;

  return (
    <div className="rail-editor" data-presentation={sheet ? "sheet" : "popover"} aria-labelledby={sheet ? undefined : headingId}>
      {!sheet && (
        <header className="rail-editor-head">
          <div className="rail-editor-heading">
            <span className="rail-editor-eyebrow">{tr("settingsview.customize")}</span>
            <h2 id={headingId}>{title}</h2>
          </div>
          <span className="rail-editor-count">{tr("raileditor.shownCount", { count: totalShown })}</span>
        </header>
      )}
      {searchable && (
        <label className="rail-editor-search">
          <SearchIcon aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={tr("raileditor.searchPlaceholder")}
            aria-label={tr("common.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="rail-editor-body">
        <section className="rail-editor-section" aria-label={tr("raileditor.shownHere")}>
          <div className="rail-editor-section-head">
            <span>{tr("raileditor.shownHere")}</span>
            {canReorder && <small>{tr("raileditor.dragHint")}</small>}
          </div>
          {sections.shown.length === 0 ? (
            <p className="rail-editor-empty">{query ? tr("picker.noMatches") : tr("raileditor.emptyHere")}</p>
          ) : (
            <ol className="rail-editor-shown" ref={drag.ref}>
              {drag.order.map((key) => {
                if (key === null) return <li key={drag.slotKey} className="rail-editor-row rail-drag-slot" data-rail-slot aria-hidden="true" />;
                const entry = byKey.get(key);
                if (!entry) return null;
                const props = drag.itemProps(key);
                return (
                  <li
                    key={key}
                    className="rail-editor-row"
                    data-rail-ghost="clone"
                    data-reorderable={canReorder || undefined}
                    data-rail-item={props["data-rail-item"]}
                    data-rail-drag-source={props["data-rail-drag-source"]}
                    onPointerDown={props.onPointerDown}
                    onKeyDown={props.onKeyDown}
                    tabIndex={-1}
                    title={entry.description}
                  >
                    {canReorder
                      ? (
                        <button
                          type="button"
                          className="rail-editor-grip"
                          aria-label={tr("raileditor.reorderItem", { label: entry.label })}
                          title={tr("raileditor.dragHint")}
                        >
                          <Icon icon={DragHandleIcon} size="sm" />
                        </button>
                      )
                      : <span className="rail-editor-grip" aria-hidden="true" />}
                    <span className="rail-editor-glyph" aria-hidden="true">{entry.icon}</span>
                    <span className="rail-editor-row-label">{entry.label}</span>
                    {entry.locked
                      ? (
                        <span className="rail-editor-lock" title={tr("raileditor.alwaysAvailable")} aria-label={tr("raileditor.alwaysAvailable")}>
                          <Icon icon={LockIcon} size="sm" />
                        </span>
                      )
                      : (
                        <button
                          type="button"
                          className="rail-editor-remove"
                          aria-label={tr("raileditor.removeItem", { label: entry.label })}
                          title={tr("raileditor.removeItem", { label: entry.label })}
                          onClick={entry.remove}
                        >
                          <Icon icon={MinusIcon} size="sm" />
                        </button>
                      )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {sections.tools.length > 0 && (
          <section className="rail-editor-section" aria-label={candidatesLabel ?? tr("raileditor.tools")}>
            <div className="rail-editor-section-head">
              <span>{candidatesLabel ?? tr("raileditor.tools")}</span>
              <small>{sections.tools.length}</small>
            </div>
            <div className="rail-editor-grid">
              {sections.tools.map((entry) => <Tile key={entry.key} entry={entry} />)}
            </div>
          </section>
        )}
        {sections.widgets.length > 0 && (
          <section className="rail-editor-section" aria-label={tr("raileditor.widgets")}>
            <div className="rail-editor-section-head">
              <span>{tr("raileditor.widgets")}</span>
              <small>{sections.widgets.length}</small>
            </div>
            <div className="rail-editor-grid">
              {sections.widgets.map((entry) => <Tile key={entry.key} entry={entry} />)}
            </div>
          </section>
        )}
        {nothingToAdd && !query && <p className="rail-editor-empty rail-editor-all-added">{tr("raileditor.everythingAdded")}</p>}
        {nothingToAdd && query && sections.shown.length > 0 && <p className="rail-editor-empty">{tr("picker.noMatches")}</p>}
      </div>
      <footer className="rail-editor-foot">
        <span className="rail-editor-note">{note ?? tr("raileditor.oneHomeNote")}</span>
        {actions.map((action) => (
          <button key={action.id} type="button" className="rail-editor-action" onClick={action.onSelect}>
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </footer>
    </div>
  );
}
