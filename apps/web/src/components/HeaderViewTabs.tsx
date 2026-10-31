// The header's view tabs (Chat, Canvas, Tasks, Creative Studio…): one
// customizable rail. Drag a tab (long-press on touch, Alt+←/→ on keyboard) to
// reorder it; the Customize pencil (Shift or Edit mode) opens the shared rail
// editor to reorder, hide and bring tabs back. The model is viewTabs.ts.
import { createElement, useRef, useState } from "react";
import { tr } from "../i18n/index.ts";
import { useRailDragZone } from "../railDrag.ts";
import { railIconFor } from "../railIcons.ts";
import type { RailEditorEntry } from "../railEditorModel.ts";
import { useShellMode } from "../responsiveShell.ts";
import { CANVAS_TAB_ID, CHAT_TAB_ID, useViewTabs, type ResolvedViewTab, type ViewTabsModel } from "../viewTabs.ts";
import { ChatIcon, EditIcon, GridViewIcon, IconButton } from "./ui/index.ts";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import RailEditor from "./RailEditor.tsx";

/** Drag ids are namespaced so a tab can never be taken for a rail launcher. */
const TAB_DRAG_PREFIX = "tab:";
const dragIdOf = (id: string) => `${TAB_DRAG_PREFIX}${id}`;
const tabIdOf = (dragId: string) => dragId.slice(TAB_DRAG_PREFIX.length);

function tabGlyph(tab: ResolvedViewTab) {
  if (tab.id === CHAT_TAB_ID) return createElement(ChatIcon, { size: 15, strokeWidth: 1.8, "aria-hidden": true });
  if (tab.id === CANVAS_TAB_ID) return createElement(GridViewIcon, { size: 15, strokeWidth: 1.8, "aria-hidden": true });
  return createElement(railIconFor(tab.id));
}

function ViewTabsEditor({ model }: { model: ViewTabsModel }) {
  const entries: RailEditorEntry[] = model.tabs.map((tab) => ({
    key: dragIdOf(tab.id),
    kind: "tool",
    label: tab.label,
    icon: tabGlyph(tab),
    shown: tab.shown,
    locked: false,
    add: () => model.setShown(tab.id, true),
    remove: () => model.setShown(tab.id, false),
  }));
  const title = tr("raileditor.zoneViewTabs");
  return (
    <RailEditor
      slot="app.header.leading"
      dragId="rail-editor:view-tabs"
      title={title}
      entries={entries}
      reorder={(keys) => model.reorder(keys.map(tabIdOf))}
      candidatesLabel={tr("raileditor.hiddenViewTabs")}
      note={tr("raileditor.viewTabsNote")}
      sheet={useShellMode() === "phone"}
    />
  );
}

function CustomizeViewTabsButton({ model }: { model: ViewTabsModel }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const label = tr("raileditor.customizeZone", { zone: tr("raileditor.zoneViewTabs") });
  return (
    <>
      <IconButton
        ref={anchorRef}
        className="zone-customize-trigger zone-edit-button"
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
        align="start"
        side="down"
        phone="sheet"
        sheetSize="tall"
        className="rail-editor-overlay"
      >
        <ViewTabsEditor model={model} />
      </ResponsiveOverlay>
    </>
  );
}

/** `editing` keeps the rail mounted with a single tab so its pencil can
 *  bring the others back; otherwise a lone tab is no choice and is omitted. */
export default function HeaderViewTabs({ editing }: { editing: boolean }) {
  const model = useViewTabs();
  const drawn = model.tabs.filter((tab) => tab.drawn);
  const byDragId = new Map(drawn.map((tab) => [dragIdOf(tab.id), tab]));
  const drag = useRailDragZone({
    id: "view-tabs",
    axis: "x",
    ids: drawn.map((tab) => dragIdOf(tab.id)),
    isDraggable: () => drawn.length > 1,
    accepts: () => false,
    canLeave: () => false,
    commit: (order) => model.reorder(order.map(tabIdOf)),
  });
  if (drawn.length < 2 && !editing) return null;
  return (
    <div className="workspace-mode-switch-zone customize-zone">
      <div
        className="workspace-mode-switch"
        role="group"
        aria-label={tr("header.workspaceView")}
        ref={drag.ref}
      >
        {drag.order.map((entry) => {
          if (entry === null) return null;
          const tab = byDragId.get(entry);
          if (!tab) return null;
          return (
            <button
              key={entry}
              type="button"
              className={`${tab.active ? "active" : ""}${tab.focused ? " focus-mode-trigger" : ""}`}
              data-workspace-mode={tab.focused ? "focus" : undefined}
              data-view-tab={tab.id}
              aria-pressed={tab.active}
              {...drag.itemProps(entry)}
              onClick={() => model.select(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <CustomizeViewTabsButton model={model} />
    </div>
  );
}
