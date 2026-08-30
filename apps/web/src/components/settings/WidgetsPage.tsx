import { useEffect, useMemo, useState } from "react";
import type { JsonObject, UiSlot } from "@polyth/contracts";
import { useStore } from "../../store.ts";
import { useWidgetCatalog, getWidget, type WidgetDef } from "../../widgets/catalog.ts";
import WidgetCanvas, { SchemaWidgetSettings } from "../../widgets/WidgetCanvas.tsx";
import {
  applyWidgetLayoutMutations, ensureWidgets, redoWidgetLayout, resetWidgetLayout,
  setWidgetConfig, undoWidgetLayout, updateWidgetLayout, useWidgetLayout,
  useWidgetStoreStatus, widgetDefinitionId, widgetSlotOf,
} from "../../widgets/widgetLayout.ts";
import { areaPlacementOptions } from "../../widgets/areaFit.ts";
import WidgetLibraryPanel from "./WidgetLibraryPanel.tsx";
import { Button, Select } from "../ui/index.ts";
import { useUiSettings, setUiSettings } from "../../uiPrefs.ts";
import "../../widgets/builtinWidgets.tsx";

type PreviewMode = "desktop" | "tablet" | "phone";

export function moveOrderedSelection<T extends string>(selected: readonly T[], item: T, target: T): T[] {
  if (item === target || !selected.includes(item) || !selected.includes(target)) return [...selected];
  const next = selected.filter((id) => id !== item);
  next.splice(next.indexOf(target), 0, item);
  return next;
}

function PreviewControls({ mode }: { mode: PreviewMode }) {
  const ui = useUiSettings();
  const reorder = <T extends string>(ids: readonly T[], set: (value: T[]) => void) => (item: T) => {
    const first = ids[0];
    if (!first) return;
    const next: T[] = first === item ? [...ids.slice(1), item] : moveOrderedSelection(ids, item, first);
    set(next);
  };
  if (mode === "phone") return <section className="workspace-mobile-preview" aria-label="Mobile shortcuts">
    <small>Mobile shortcuts</small><div>{ui.mobileShortcuts.map((id) => <button key={id} type="button" onClick={() => reorder(ui.mobileShortcuts, (mobileShortcuts) => setUiSettings({ mobileShortcuts }))(id)}>{id.replaceAll("-", " ")}</button>)}</div>
  </section>;
  return <>
    <section className="workspace-live-rail" aria-label="Top toolbar"><small>Top toolbar</small><div><button type="button">Files</button><button type="button">Browser</button><button type="button">Goals</button></div></section>
    <section className="workspace-response-preview" aria-label="Response actions"><p>Agent answer preview…</p><div>{ui.responseActions.map((id) => <button key={id} type="button" onClick={() => reorder(ui.responseActions, (responseActions) => setUiSettings({ responseActions }))(id)}>{id}</button>)}</div></section>
    <section className="workspace-composer-preview" aria-label="Composer controls"><input aria-label="Message preview" placeholder="Ask anything…" readOnly /><div><button type="button">+ Files</button><button type="button">Model</button><button type="button">Send</button></div></section>
  </>;
}

function Inspector({ selectedId, widgets }: { selectedId: string | null; widgets: WidgetDef[] }) {
  const layout = useWidgetLayout();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const placement = selectedId ? layout.widgets[selectedId] : undefined;
  const widget = selectedId ? getWidget(widgetDefinitionId(layout, selectedId)) : undefined;
  const mutate = (...mutations: Parameters<typeof applyWidgetLayoutMutations>[1]) => updateWidgetLayout((current) => applyWidgetLayoutMutations(current, mutations, widgets));
  if (!selectedId || !placement) return <aside className="workspace-inspector"><strong>Inspector</strong><p>Select a widget or surface to edit it.</p></aside>;
  if (!widget) return <aside className="workspace-inspector"><strong>{placement.title ?? selectedId}</strong><p>Plugin unavailable. Its placement and settings are preserved.</p><Button type="button" size="sm" variant="danger" onClick={() => mutate({ type: "forget", id: selectedId })}>Remove</Button></aside>;
  const config = placement.config ?? {};
  const updateConfig = (next: JsonObject) => updateWidgetLayout((current) => setWidgetConfig(current, selectedId, next));
  const preset = (name: "Compact" | "Default" | "Large") => {
    const base = widget.defaultSize ?? widget.recommendedSize ?? placement.size;
    const factor = name === "Compact" ? .75 : name === "Large" ? 1.25 : 1;
    mutate({ type: "resize", id: selectedId, size: { w: Math.max(1, Math.round(base.w * factor)), h: Math.max(1, Math.round(base.h * factor)) } });
  };
  return <aside className="workspace-inspector" aria-label="Widget inspector">
    <strong>{placement.title ?? widget.title}</strong><small>{widget.pluginName ?? widget.pluginId}</small>
    <label>Placement<Select label="Placement" value={widgetSlotOf(layout, selectedId) ?? widget.defaultSlot} onChange={(slot) => mutate({ type: "place", id: selectedId, slot: slot as UiSlot })} options={areaPlacementOptions(widget)} /></label>
    {widget.resizable !== false && <div className="workspace-size-presets"><span>Size</span>{(["Compact", "Default", "Large"] as const).map((name) => <Button key={name} type="button" size="sm" variant="ghost" onClick={() => preset(name)}>{name}</Button>)}</div>}
    <section><strong>Widget settings</strong>{widget.settingsRender ? widget.settingsRender({ projectId, sessionId, editing: true, widgetId: widget.id, instanceId: selectedId, config, updateConfig }) : widget.settingsSchema ? <SchemaWidgetSettings schema={widget.settingsSchema} config={config} updateConfig={updateConfig} /> : <p>No additional options.</p>}</section>
    <Button type="button" size="sm" onClick={() => mutate({ type: "duplicate", id: selectedId })} disabled={!widget.duplicatable}>Duplicate</Button>
    <Button type="button" size="sm" variant="danger" onClick={() => mutate({ type: "visibility", id: selectedId, visible: false })} disabled={placement.requiredVisible}>Remove</Button>
  </aside>;
}

export default function WidgetsPage() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const status = useWidgetStoreStatus();
  const project = useStore((state) => state.projectRegistry.projects.find((item) => item.id === state.activeProjectId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>("desktop");
  useEffect(() => { ensureWidgets(widgets); }, [widgets]);
  const selected = useMemo(() => selectedId && layout.widgets[selectedId] ? selectedId : null, [selectedId, layout]);
  const add = (widget: WidgetDef) => updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [{ type: "visibility", id: widget.id, visible: true }, { type: "place", id: widget.id, slot: widget.defaultSlot ?? "workspace.main" }], widgets));
  return <div className={`workspace-customizer preview-${mode}`}>
    <header className="workspace-customizer-toolbar"><strong>Customize workspace</strong><span>Scope: {project?.name ?? "This project"}</span><div className="workspace-preview-modes">{(["desktop", "tablet", "phone"] as const).map((value) => <Button key={value} type="button" size="sm" variant={mode === value ? "primary" : "ghost"} onClick={() => setMode(value)}>{value[0]!.toUpperCase() + value.slice(1)}</Button>)}</div><small role="status">{status.saveStatus === "saving" ? "Saving" : "Saved"}</small><Button type="button" size="sm" onClick={undoWidgetLayout} disabled={!status.canUndo}>Undo</Button><Button type="button" size="sm" onClick={redoWidgetLayout} disabled={!status.canRedo}>Redo</Button><Button type="button" size="sm" variant="ghost" onClick={() => resetWidgetLayout(widgets)}>Reset workspace</Button></header>
    <div className="workspace-customizer-body"><WidgetLibraryPanel widgets={widgets} onAdd={add} /><main className="workspace-live-preview"><PreviewControls mode={mode} /><WidgetCanvas editing selectedId={selected} onSelect={setSelectedId} onDropSlot={(id) => { const widget = widgets.find((item) => item.id === id); if (widget) add(widget); }} /></main><Inspector selectedId={selected} widgets={widgets} /></div>
  </div>;
}
