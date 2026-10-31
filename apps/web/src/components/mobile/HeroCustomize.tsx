// The new chat's Customize panel and its desktop entry: a pencil in the
// hero's top-right corner that, like every customization zone's pencil, shows
// only while Shift is held over the screen or the workspace Edit mode is on.
// Touch screens open the panel from the long-press edit mode
// (HeroEditMode.tsx). The panel (compact dialog on desktop/tablet, sheet on
// phones) switches every piece of the screen on or off:
//   * On this screen — the greeting, Shortcuts (its button opens the
//     shortcut picker), Recent sessions (its list
//     options fold out inline), Apps (package icons the user picks and
//     arranges inline) and the widgets added to the account's board
//     (heroBoard.ts): Add widget, then per item its size, "Only in this
//     project", its own settings, Duplicate and Remove. Built-ins and items
//     share one order and reorder by drag or arrow keys on their handle;
//   * Composer — the project/branch row, its Isolate switch, and the
//     composer's widget buttons (phones hand off to the rail's own editor).
// Screen choices live in `heroWidgetPrefs` and `heroBoard` (account-synced);
// composer buttons are the project's shared widget layout, so the panel says so.
import { useEffect, useId, useState, type ReactNode } from "react";
import type { PanelItemSize, UiSlot } from "@polyth/contracts";
import { tr } from "../../i18n/index.ts";
import { setOverlay, useStore, workspaceProjectId } from "../../store.ts";
import { useShellMode } from "../../responsiveShell.ts";
import {
  defaultHeroWidgetPrefs,
  HERO_WIDGET_IDS,
  isDefaultHeroWidgetPrefs,
  moveListItem,
  setHeroAppsPrefs,
  setHeroChromePrefs,
  setHeroWidgetPrefs,
  type HeroAppsPrefs,
  type HeroChromePrefs,
  type HeroWidgetId,
} from "../../heroWidgetPrefs.ts";
import {
  addHeroBoardItem,
  duplicateHeroBoardItem,
  heroItemSizes,
  heroItemsFor,
  heroOrder,
  moveHeroEntry,
  removeHeroBoardItem,
  setHeroBoard,
  updateHeroBoard,
  updateHeroBoardItem,
  type HeroBoardItem,
} from "../../heroBoard.ts";
import { SchemaWidgetSettings } from "../../widgets/WidgetCanvas.tsx";
import { Seg } from "../settings/parts.tsx";
import { requestMobileRailEdit } from "../../composer/mobileRail.ts";
import { closeHeroPanel, openHeroPanel, useHeroPanel } from "../../heroEditing.ts";
import { useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import { applyWidgetLayoutMutations, updateWidgetLayout, useWidgetLayout, type WidgetLayout } from "../../widgets/widgetLayout.ts";
import { supportedWidgetSlots } from "../../widgets/widgetLibrary.ts";
import { widgetsForZone } from "../../widgets/zoneWidgets.ts";
import { capabilityIdOfWidget } from "../../railPlacement.ts";
import WidgetGlyph from "../WidgetGlyph.tsx";
import { useWindowPackages } from "../../starterPackages.ts";
import {
  AppsIcon,
  Button,
  BranchIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DragHandleIcon,
  EditIcon,
  HideIcon,
  HistoryIcon,
  Icon,
  IconButton,
  LockIcon,
  PlusIcon,
  QuoteIcon,
  RefreshIcon,
  ResponsiveOverlay,
  Switch,
  TargetIcon,
  TextInput,
  ViewOptionsIcon,
  type LucideIcon,
} from "../ui/index.ts";
import { HeroRecentOptions } from "./HeroRecentSettings.tsx";
import { useHeroBoard, useHeroOrder, useHeroWidgetPrefs } from "./HeroWidgets.tsx";
import { HERO_SLOT } from "./HeroBoard.tsx";
import { HeroAppTileContent, pinnedHeroApps } from "./HeroApps.tsx";
import { useSortable } from "./useSortable.ts";

const SIZE_LABELS = {
  compact: "workspace.panel.sizeCompact",
  standard: "workspace.panel.sizeStandard",
  wide: "workspace.panel.sizeWide",
  large: "workspace.panel.sizeLarge",
} as const satisfies Record<PanelItemSize, string>;
const COMPOSER_SLOTS: readonly UiSlot[] = ["composer.leading", "composer.trailing"];

function CustomizeRow({
  sortId,
  dragging = false,
  icon,
  title,
  detail,
  checked,
  onChange,
  disabled = false,
  tools,
  children,
}: {
  /** Set on rows the section's sortable list can reorder. */
  sortId?: string;
  dragging?: boolean;
  icon: ReactNode;
  title: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Quiet extra controls between the text and the switch. */
  tools?: ReactNode;
  /** Inline content folded out under the row (Recent's list options). */
  children?: ReactNode;
}) {
  const labelId = useId();
  return (
    <li
      className="hero-customize-item"
      data-sort-id={sortId}
      data-dragging={dragging ? "true" : undefined}
      data-off={checked ? undefined : "true"}
      data-disabled={disabled ? "true" : undefined}
    >
      <div className="hero-customize-row">
        <span className="hero-customize-icon" aria-hidden="true">{icon}</span>
        {/* The text is a large, forgiving target for pointer and touch; the
            switch stays the one accessible control. */}
        <span className="hero-customize-text" onClick={() => { if (!disabled) onChange(!checked); }}>
          <span className="hero-customize-title" id={labelId}>{title}</span>
          {detail && <span className="hero-customize-detail">{detail}</span>}
        </span>
        {tools && <span className="hero-customize-tools">{tools}</span>}
        <Switch checked={checked} onChange={onChange} labelledBy={labelId} disabled={disabled} />
      </div>
      {children}
    </li>
  );
}

function Section({ title, note, listRef, dragging = false, children }: {
  title: string;
  note?: string;
  listRef?: { current: HTMLElement | null };
  dragging?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="hero-customize-section" aria-labelledby={headingId}>
      <h3 className="hero-customize-caption" id={headingId}>{title}</h3>
      <ul
        className="hero-customize-group"
        ref={listRef ? (node) => { listRef.current = node; } : undefined}
        data-dragging={dragging ? "true" : undefined}
      >{children}</ul>
      {note && <p className="hero-customize-note">{note}</p>}
    </section>
  );
}

/** Show or hide a catalog widget in one of `slots`. Showing places it in its
 *  own default home when that is one of them, else in the first it supports. */
function setZoneWidget(widgets: readonly WidgetDef[], widget: WidgetDef, slots: readonly UiSlot[], visible: boolean): void {
  if (!visible) {
    updateWidgetLayout((current) => applyWidgetLayoutMutations(
      current, [{ type: "visibility", id: widget.id, visible: false }], widgets));
    return;
  }
  const supported = supportedWidgetSlots(widget);
  const slot = widget.defaultSlot && slots.includes(widget.defaultSlot)
    ? widget.defaultSlot
    : slots.find((candidate) => supported.includes(candidate)) ?? slots[0]!;
  updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
    { type: "visibility", id: widget.id, visible: true },
    { type: "place", id: widget.id, slot },
  ], widgets));
}

function zoneWidgets(widgets: readonly WidgetDef[], layout: WidgetLayout, slots: readonly UiSlot[]): {
  widget: WidgetDef;
  shown: boolean;
}[] {
  const zone = widgetsForZone(widgets, layout, slots);
  // Capability launchers keep their one-home rule in the rail editor.
  const plain = (widget: WidgetDef) => capabilityIdOfWidget(widget.id) === null;
  return [
    ...zone.active.filter(plain).map((widget) => ({ widget, shown: true })),
    ...zone.inactive.filter(plain).map((widget) => ({ widget, shown: false })),
  ];
}

/** Apps' inline editor: the pinned tiles as they will read on the screen
 *  (drag or arrow keys to reorder, × or Delete to take one off), then every
 *  other package window as a tile to add with one tap, then names on/off. */
function HeroAppsOptions({ prefs }: { prefs: HeroAppsPrefs }) {
  const packages = useWindowPackages();
  const pinned = pinnedHeroApps(prefs.ids, packages);
  const available = packages.filter((entry) => !prefs.ids.includes(entry.id));
  const pinnedIds = pinned.map((entry) => entry.id);
  // Reorder against the full stored list so an unloaded package keeps its place.
  const sortable = useSortable({
    ids: pinnedIds,
    onMove: (id, index) => {
      const anchor = pinnedIds.filter((item) => item !== id)[index];
      const without = prefs.ids.filter((item) => item !== id);
      const at = anchor === undefined ? without.length : without.indexOf(anchor);
      setHeroAppsPrefs({ ids: moveListItem([...without, id], id, at) });
    },
  });
  const remove = (id: string) => setHeroAppsPrefs({ ids: prefs.ids.filter((item) => item !== id) });
  const labelsId = useId();

  if (packages.length === 0) return <p className="hero-customize-note">{tr("workspace.herocustomize.appsNone")}</p>;
  return (
    <div className="hero-apps-editor">
      <p className="hero-apps-editor-caption">{tr("workspace.herocustomize.appsPinned")}</p>
      {pinned.length === 0 ? (
        <p className="hero-apps-editor-empty">{tr("workspace.herocustomize.appsEmpty")}</p>
      ) : (
        <ul
          className="hero-apps hero-apps--edit"
          ref={(node) => { sortable.listRef.current = node; }}
          data-dragging={sortable.dragging ? "true" : undefined}
          data-labels="true"
        >
          {pinned.map((app) => (
            <li key={app.id} data-sort-id={app.id} data-dragging={sortable.dragging === app.id ? "true" : undefined}>
              <button
                type="button"
                className="hero-app hero-app--pinned"
                aria-label={tr("workspace.herocustomize.appHandle", { label: app.label })}
                title={tr("workspace.herocustomize.appHandle", { label: app.label })}
                {...sortable.handleProps(app.id)}
                onKeyDown={(event) => {
                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    remove(app.id);
                    return;
                  }
                  sortable.handleProps(app.id).onKeyDown(event);
                }}
              >
                <HeroAppTileContent app={app} />
              </button>
              <button
                type="button"
                className="hero-app-remove"
                aria-label={tr("workspace.herocustomize.removeApp", { label: app.label })}
                title={tr("workspace.herocustomize.removeApp", { label: app.label })}
                onClick={() => remove(app.id)}
              ><Icon icon={CloseIcon} size="sm" /></button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && <>
        <p className="hero-apps-editor-caption">{tr("workspace.herocustomize.appsAvailable")}</p>
        <ul className="hero-apps hero-apps--available" data-labels="true">
          {available.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                className="hero-app hero-app--add"
                aria-label={tr("workspace.herocustomize.addApp", { label: app.label })}
                title={app.description ?? app.label}
                onClick={() => setHeroAppsPrefs({ ids: [...prefs.ids, app.id] })}
              >
                <HeroAppTileContent app={app} badge={<span className="hero-app-add-badge" aria-hidden="true"><Icon icon={PlusIcon} size="sm" /></span>} />
              </button>
            </li>
          ))}
        </ul>
      </>}
      <div className="hero-apps-editor-labels">
        <span id={labelsId}>{tr("workspace.herocustomize.appsLabels")}</span>
        <Switch checked={prefs.labels} onChange={(labels) => setHeroAppsPrefs({ labels })} labelledBy={labelsId} />
      </div>
    </div>
  );
}

/** Catalog widgets that can go on the new-chat board. Capability launchers
 *  keep their one-home rule in the rail editor. */
function boardCandidates(widgets: readonly WidgetDef[]): WidgetDef[] {
  return widgets
    .filter((widget) => supportedWidgetSlots(widget).includes(HERO_SLOT) && capabilityIdOfWidget(widget.id) === null)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

const packageOf = (widget: WidgetDef): string => widget.pluginName ?? widget.ownerPackageId ?? widget.pluginId;

/** Add widget: every candidate grouped by its package, with search once the
 *  list is long. A widget that cannot be duplicated and is already shown
 *  reads as added. */
function HeroAddWidget({ widgets, items, onAdded }: {
  widgets: readonly WidgetDef[];
  items: readonly HeroBoardItem[];
  onAdded: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = boardCandidates(widgets);
  if (candidates.length === 0) return <p className="hero-customize-note">{tr("workspace.herocustomize.addWidgetNone")}</p>;
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = candidates.filter((widget) => {
    const text = `${widget.title} ${widget.description} ${packageOf(widget)}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of matches) groups.set(packageOf(widget), [...(groups.get(packageOf(widget)) ?? []), widget]);
  const add = (widget: WidgetDef) => {
    let added = "";
    updateHeroBoard((board) => {
      const result = addHeroBoardItem(board, widget);
      added = result.id;
      return result.board;
    });
    if (added) onAdded(added);
  };
  return (
    <div className="hero-add-widget">
      {candidates.length > 4 && (
        <TextInput
          uiSize="sm"
          type="search"
          value={query}
          placeholder={tr("workspace.herocustomize.addWidgetSearch")}
          aria-label={tr("workspace.herocustomize.addWidgetSearch")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      )}
      {matches.length === 0 && <p className="hero-customize-note">{tr("workspace.herocustomize.addWidgetNoMatches")}</p>}
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, entries]) => (
        <section key={group} className="hero-add-widget-group">
          {groups.size > 1 && <h4 className="hero-apps-editor-caption">{group}</h4>}
          <ul>
            {entries.map((widget) => {
              const added = !widget.duplicatable && items.some((item) => item.widget === widget.id && !item.hidden);
              return (
                <li key={widget.id} className="hero-add-widget-row">
                  <span className="hero-customize-icon" aria-hidden="true"><WidgetGlyph widget={widget} /></span>
                  <span className="hero-customize-text">
                    <span className="hero-customize-title">{widget.title}</span>
                    {widget.description && <span className="hero-customize-detail">{widget.description}</span>}
                  </span>
                  <Button size="sm" iconStart={added ? undefined : PlusIcon} disabled={added} onClick={() => add(widget)}>
                    {added ? tr("workspace.herocustomize.added") : tr("workspace.herocustomize.add")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One board item's fold-out: size, project scope, the widget's own settings,
 *  then Duplicate and Remove. */
function HeroBoardItemOptions({ item, widget, projectId }: { item: HeroBoardItem; widget: WidgetDef; projectId: string | null }) {
  const sizes = heroItemSizes(widget);
  const scopeId = useId();
  const update = (patch: Parameters<typeof updateHeroBoardItem>[2]) =>
    updateHeroBoard((board) => updateHeroBoardItem(board, item.id, patch));
  const updateConfig = (config: HeroBoardItem["config"]) => update({ config });
  const settingsContext = {
    projectId,
    sessionId: null,
    editing: true,
    instanceId: item.id,
    widgetId: widget.id,
    config: item.config,
    updateConfig,
    panelSize: item.size,
  };
  return (
    <div className="hero-recent-settings-form hero-board-options">
      {sizes.length > 1 && (
        <div className="hero-recent-settings-row">
          <span className="hero-recent-settings-label">{tr("workspace.herocustomize.size")}</span>
          <Seg<PanelItemSize>
            label={tr("workspace.herocustomize.size")}
            value={item.size}
            options={sizes.map((size) => [size, tr(SIZE_LABELS[size])] as [PanelItemSize, string])}
            onChange={(size) => update({ size })}
          />
        </div>
      )}
      <div className="hero-recent-settings-row">
        <span className="hero-recent-settings-label" id={scopeId}>{tr("workspace.herocustomize.onlyThisProject")}</span>
        <Switch
          checked={item.projectId !== undefined}
          disabled={!projectId && item.projectId === undefined}
          labelledBy={scopeId}
          onChange={(only) => update({ projectId: only ? projectId ?? undefined : undefined })}
        />
      </div>
      {widget.settingsRender
        ? <div className="hero-board-settings">{widget.settingsRender(settingsContext)}</div>
        : widget.settingsSchema
          ? <div className="hero-board-settings"><SchemaWidgetSettings schema={widget.settingsSchema} config={item.config} updateConfig={updateConfig} /></div>
          : null}
      <div className="hero-board-actions">
        {widget.duplicatable && (
          <Button variant="ghost" size="sm" iconStart={CopyIcon} onClick={() => updateHeroBoard((board) => duplicateHeroBoardItem(board, item.id))}>
            {tr("workspace.herocustomize.duplicate")}
          </Button>
        )}
        <Button variant="ghost" size="sm" iconStart={DeleteIcon} onClick={() => updateHeroBoard((board) => removeHeroBoardItem(board, item.id))}>
          {tr("workspace.herocustomize.remove")}
        </Button>
      </div>
    </div>
  );
}

function HeroCustomizePanel({ projectId, onClose, startAdding = false }: {
  projectId: string | null;
  onClose: () => void;
  /** Open with Add widget folded out (the edit mode's Add widget). */
  startAdding?: boolean;
}) {
  const prefs = useHeroWidgetPrefs();
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const phone = useShellMode() === "phone";
  const board = useHeroBoard();
  const order = useHeroOrder();
  const [recentOpen, setRecentOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(startAdding);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const chrome = (key: keyof HeroChromePrefs) => (checked: boolean) => setHeroChromePrefs({ [key]: checked });

  const builtin: Record<HeroWidgetId, { icon: LucideIcon; title: string; detail: string }> = {
    starters: {
      icon: TargetIcon,
      title: tr("workspace.builtinsurfaces.quickStarters"),
      detail: tr("workspace.herocustomize.startersDetail"),
    },
    recent: {
      icon: HistoryIcon,
      title: tr("mobile.herowidgets.recentSessions"),
      detail: tr("workspace.herocustomize.recentDetail"),
    },
    apps: {
      icon: AppsIcon,
      title: tr("workspace.heroapps.title"),
      detail: tr("workspace.herocustomize.appsDetail"),
    },
  };
  const toggleWidget = (id: HeroWidgetId) => (checked: boolean) => setHeroWidgetPrefs({
    ...prefs,
    hidden: checked ? prefs.hidden.filter((item) => item !== id) : [...prefs.hidden, id],
  });
  // Items of other projects keep their place in the order but are not listed.
  const catalog = new Map(widgets.map((widget) => [widget.id, widget]));
  const items = new Map(heroItemsFor(board, projectId, true)
    .filter((item) => catalog.has(item.widget))
    .map((item) => [item.id, item]));
  const rows = order.filter((id) => HERO_WIDGET_IDS.includes(id as HeroWidgetId) || items.has(id));
  const sortable = useSortable({
    ids: rows,
    onMove: (id, index) => {
      const anchor = rows.filter((row) => row !== id)[index];
      const without = order.filter((entry) => entry !== id);
      moveHeroEntry(id, anchor === undefined ? without.length : without.indexOf(anchor));
    },
  });
  const disclosure: Partial<Record<HeroWidgetId, { open: boolean; toggle: () => void; label: string; body: ReactNode }>> = {
    recent: {
      open: recentOpen,
      toggle: () => setRecentOpen(!recentOpen),
      label: tr("workspace.herocustomize.recentOptions"),
      body: <HeroRecentOptions prefs={prefs.recent} currentProjectId={projectId} />,
    },
    apps: {
      open: appsOpen,
      toggle: () => setAppsOpen(!appsOpen),
      label: tr("workspace.herocustomize.appsOptions"),
      body: <HeroAppsOptions prefs={prefs.apps} />,
    },
  };

  const composerWidgets = phone ? [] : zoneWidgets(widgets, layout, COMPOSER_SLOTS);

  return (
    <div className="hero-customize">
      <p className="hero-customize-sub">{tr("workspace.herocustomize.subtitle")}</p>
      <Section title={tr("workspace.herocustomize.screen")} listRef={sortable.listRef} dragging={sortable.dragging !== null}>
        <CustomizeRow
          icon={<Icon icon={QuoteIcon} size="sm" />}
          title={tr("workspace.herocustomize.greeting")}
          detail={tr("workspace.herocustomize.greetingDetail")}
          checked={prefs.chrome.greeting}
          onChange={chrome("greeting")}
        />
        {rows.map((rowId) => {
          const boardItem = items.get(rowId);
          if (boardItem) {
            const widget = catalog.get(boardItem.widget)!;
            // Copies of one widget read as "Clock", "Clock 2", … in list order.
            const copies = rows.filter((row) => items.get(row)?.widget === boardItem.widget);
            const title = copies.length > 1 ? `${widget.title} ${copies.indexOf(boardItem.id) + 1}` : widget.title;
            const shown = !boardItem.hidden;
            const open = openItem === boardItem.id && shown;
            const moveLabel = tr("workspace.herocustomize.reorderValue", { value: title });
            const optionsLabel = tr("workspace.herocustomize.widgetOptions", { value: title });
            return (
              <CustomizeRow
                key={boardItem.id}
                sortId={boardItem.id}
                dragging={sortable.dragging === boardItem.id}
                icon={<WidgetGlyph widget={widget} />}
                title={title}
                detail={boardItem.projectId ? tr("workspace.herocustomize.onlyThisProject") : widget.description}
                checked={shown}
                onChange={(checked) => updateHeroBoard((current) => updateHeroBoardItem(current, boardItem.id, { hidden: !checked }))}
                tools={<>
                  <IconButton
                    icon={ViewOptionsIcon}
                    size="sm"
                    className="hero-customize-tool hero-customize-disclose"
                    label={optionsLabel}
                    pressed={open}
                    aria-expanded={open}
                    disabled={!shown}
                    onClick={() => setOpenItem(open ? null : boardItem.id)}
                  />
                  <button
                    type="button"
                    className="hero-customize-tool hero-customize-move"
                    aria-label={moveLabel}
                    title={moveLabel}
                    {...sortable.handleProps(boardItem.id)}
                  ><Icon icon={DragHandleIcon} size="sm" /></button>
                </>}
              >
                {open && <div className="hero-customize-nested">
                  <HeroBoardItemOptions item={boardItem} widget={widget} projectId={projectId} />
                </div>}
              </CustomizeRow>
            );
          }
          const id = rowId as HeroWidgetId;
          const item = builtin[id];
          const shown = !prefs.hidden.includes(id);
          const fold = disclosure[id];
          const moveLabel = tr("workspace.herocustomize.reorderValue", { value: item.title });
          return (
            <CustomizeRow
              key={id}
              sortId={id}
              dragging={sortable.dragging === id}
              icon={<Icon icon={item.icon} size="sm" />}
              title={item.title}
              detail={item.detail}
              checked={shown}
              onChange={toggleWidget(id)}
              tools={<>
                {id === "starters" && (
                  // The picker owns search, pinning, ordering and custom
                  // shortcuts; the screen itself has no add button.
                  <IconButton
                    icon={ViewOptionsIcon}
                    size="sm"
                    className="hero-customize-tool hero-customize-disclose"
                    label={tr("workspace.herocustomize.startersOptions")}
                    aria-haspopup="dialog"
                    disabled={!shown}
                    onClick={() => { onClose(); setOverlay("starter-picker"); }}
                  />
                )}
                {fold && (
                  <IconButton
                    icon={ViewOptionsIcon}
                    size="sm"
                    className="hero-customize-tool hero-customize-disclose"
                    label={fold.label}
                    pressed={fold.open && shown}
                    aria-expanded={fold.open && shown}
                    disabled={!shown}
                    onClick={fold.toggle}
                  />
                )}
                <button
                  type="button"
                  className="hero-customize-tool hero-customize-move"
                  aria-label={moveLabel}
                  title={moveLabel}
                  {...sortable.handleProps(id)}
                ><Icon icon={DragHandleIcon} size="sm" /></button>
              </>}
            >
              {fold && shown && fold.open && <div className="hero-customize-nested">{fold.body}</div>}
            </CustomizeRow>
          );
        })}
        <li className="hero-customize-item hero-customize-add">
          <button
            type="button"
            className="hero-customize-row hero-customize-add-row"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
          >
            <span className="hero-customize-icon" aria-hidden="true"><Icon icon={PlusIcon} size="sm" /></span>
            <span className="hero-customize-text"><span className="hero-customize-title">{tr("workspace.herocustomize.addWidget")}</span></span>
          </button>
          {addOpen && <div className="hero-customize-nested">
            <HeroAddWidget
              widgets={widgets}
              items={[...items.values()]}
              onAdded={(id) => { setAddOpen(false); setOpenItem(id); }}
            />
          </div>}
        </li>
      </Section>

      <Section
        title={tr("workspace.herocustomize.composer")}
        {...(composerWidgets.length > 0 ? { note: tr("workspace.herocustomize.composerShared") } : {})}
      >
        <CustomizeRow
          icon={<Icon icon={BranchIcon} size="sm" />}
          title={tr("workspace.herocustomize.location")}
          detail={tr("workspace.herocustomize.locationDetail")}
          checked={prefs.chrome.location}
          onChange={chrome("location")}
        />
        <CustomizeRow
          icon={<Icon icon={LockIcon} size="sm" />}
          title={tr("workspace.herocustomize.isolation")}
          detail={tr("workspace.herocustomize.isolationDetail")}
          checked={prefs.chrome.location && prefs.chrome.isolation}
          disabled={!prefs.chrome.location}
          onChange={chrome("isolation")}
        />
        {composerWidgets.map(({ widget, shown }) => (
          <CustomizeRow
            key={widget.id}
            icon={<WidgetGlyph widget={widget} />}
            title={widget.title}
            {...(widget.description ? { detail: widget.description } : {})}
            checked={shown || widget.requiredVisible === true}
            disabled={widget.requiredVisible === true}
            onChange={(checked) => setZoneWidget(widgets, widget, COMPOSER_SLOTS, checked)}
          />
        ))}
        {phone && (
          <li className="hero-customize-item">
            <div className="hero-customize-row">
              <span className="hero-customize-icon" aria-hidden="true"><Icon icon={ViewOptionsIcon} size="sm" /></span>
              <span className="hero-customize-text">
                <span className="hero-customize-title">{tr("workspace.herocustomize.composerButtons")}</span>
                <span className="hero-customize-detail">{tr("workspace.herocustomize.composerButtonsDetail")}</span>
              </span>
              <Button size="sm" onClick={() => { onClose(); requestMobileRailEdit(); }}>{tr("workspace.herocustomize.arrange")}</Button>
            </div>
          </li>
        )}
      </Section>
    </div>
  );
}

/** Pinned under the panel: empty the screen in one tap, or put it back. */
/** Hide every board item shown in `projectId` (settings are kept). */
function hideBoardItems(projectId: string | null, resetOrder: boolean): void {
  updateHeroBoard((board) => {
    const hidden = heroItemsFor(board, projectId).reduce((next, item) => updateHeroBoardItem(next, item.id, { hidden: true }), board);
    return resetOrder ? { ...hidden, order: [] } : hidden;
  });
}

function HeroCustomizeActions({ projectId }: { projectId: string | null }) {
  const prefs = useHeroWidgetPrefs();
  const board = useHeroBoard();
  const shownItems = heroItemsFor(board, projectId).length;
  const screenEmpty = !prefs.chrome.greeting
    && HERO_WIDGET_IDS.every((id) => prefs.hidden.includes(id))
    && shownItems === 0;
  const clearScreen = () => {
    setHeroWidgetPrefs({ ...prefs, hidden: [...HERO_WIDGET_IDS], chrome: { ...prefs.chrome, greeting: false } });
    hideBoardItems(projectId, false);
  };
  return (
    <div className="hero-customize-actions">
      <Button variant="ghost" size="sm" iconStart={HideIcon} disabled={screenEmpty} onClick={clearScreen}>
        {tr("workspace.herocustomize.clearScreen")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconStart={RefreshIcon}
        disabled={isDefaultHeroWidgetPrefs(prefs) && shownItems === 0}
        onClick={() => {
          setHeroWidgetPrefs(defaultHeroWidgetPrefs(prefs));
          hideBoardItems(projectId, true);
        }}
      >{tr("workspace.herorecent.reset")}</Button>
    </div>
  );
}

/** The new chat's pencil, pinned to the hero's top-right corner. It is a
 *  customization-zone trigger: hidden at rest, shown by Shift over the screen
 *  or the workspace Edit mode. It also hosts the panel the touch edit mode
 *  opens, so it is mounted in every shell. */
export function HeroCustomizeButton() {
  const request = useHeroPanel();
  const open = request !== false;
  const setOpen = (next: boolean) => { if (next) openHeroPanel(); else closeHeroPanel(); };
  // Leaving the new chat closes the panel with it.
  useEffect(() => closeHeroPanel, []);
  const projectId = useStore(workspaceProjectId);
  const prefs = useHeroWidgetPrefs();
  const board = useHeroBoard();
  const customized = !isDefaultHeroWidgetPrefs(prefs) || heroItemsFor(board, projectId).length > 0;
  const title = tr("workspace.herocustomize.title");
  return (
    <>
      <IconButton
        className="hero-customize-trigger zone-customize-trigger"
        icon={EditIcon}
        size="sm"
        variant="ghost"
        label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-customized={customized ? "true" : undefined}
        onClick={() => setOpen(!open)}
      />
      <ResponsiveOverlay
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        desktop="dialog"
        dialogSize="sm"
        dialogFooter={<HeroCustomizeActions projectId={projectId} />}
        phone="sheet"
        sheetSize="tall"
        sheetFooter={<HeroCustomizeActions projectId={projectId} />}
        className="hero-customize-panel"
        initialFocus=".hero-customize-row .switch"
      >
        <HeroCustomizePanel projectId={projectId} onClose={() => setOpen(false)} startAdding={request === "add"} />
      </ResponsiveOverlay>
    </>
  );
}
