import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { JsonObject, JsonValue, UiSlot } from "@polyth/contracts";
import { useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import { CloseIcon, IconButton, TextInput } from "../components/ui/index.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "./catalog.ts";
import {
  applyWidgetLayoutMutations,
  ensureWidgets,
  getWidgetLayout,
  setWidgetPosition,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  widgetSlotOf,
  widgetZoneFromSlot,
  setWidgetConfig,
  type WidgetPlacement,
  type WidgetPosition,
} from "./widgetLayout.ts";
import {
  pluginDisplayName,
  supportedWidgetSlots,
  supportedWidgetZones,
} from "./widgetLibrary.ts";
import "./builtinWidgets.tsx";
import { tr } from "../i18n/index.ts";

const GRID_GAP = 10;
const GRID_ROW = 36;

const SLOT_LABELS: Partial<Record<UiSlot, string>> = {
  "session.composer.before": tr("widgets.widgetcanvas.belowChatAboveComposer"),
  "workspace.header": tr("widgets.widgetcanvas.header"),
  "workspace.left": tr("widgets.widgetcanvas.leftSide"),
  "workspace.main": tr("widgets.widgetcanvas.mainWorkspace"),
  "workspace.right": tr("widgets.widgetcanvas.rightSide"),
  "workspace.bottom": tr("widgets.widgetcanvas.bottomStrip"),
  "workspace.floating": tr("widgets.widgetcanvas.floating"),
};

const slotLabel = (slot: UiSlot): string =>
  SLOT_LABELS[slot]
  ?? slot.split(".").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" · ");

interface SchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
}

function SchemaWidgetSettings({
  schema,
  config,
  updateConfig,
}: {
  schema: Readonly<Record<string, unknown>>;
  config: Readonly<JsonObject>;
  updateConfig: (config: JsonObject) => void;
}) {
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, SchemaProperty>
    : {};
  return (
    <div className="widget-schema-settings">
      {Object.entries(properties).map(([key, property]) => {
        const label = typeof property.title === "string" ? property.title : key;
        const description = typeof property.description === "string" ? property.description : "";
        const value = config[key] ?? property.default as JsonValue | undefined;
        const choices = Array.isArray(property.enum)
          ? property.enum.filter((item): item is string => typeof item === "string")
          : [];
        if (property.type === "boolean") {
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => updateConfig({ ...config, [key]: event.target.checked })}
              />
              <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
            </label>
          );
        }
        if (choices.length > 0) {
          return (
            <label key={key}>
              <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
              <select
                value={typeof value === "string" ? value : choices[0]}
                onChange={(event) => updateConfig({ ...config, [key]: event.target.value })}
              >
                {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            </label>
          );
        }
        return (
          <label key={key}>
            <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
            <input
              type={property.type === "number" || property.type === "integer" ? "number" : "text"}
              value={typeof value === "string" || typeof value === "number" ? value : ""}
              onChange={(event) => updateConfig({
                ...config,
                [key]: property.type === "number" || property.type === "integer"
                  ? Number(event.target.value)
                  : event.target.value,
              })}
            />
          </label>
        );
      })}
    </div>
  );
}

function positionStyle(placement: WidgetPlacement): CSSProperties {
  const width = Math.min(placement.size.w, 12 - placement.position.x);
  return {
    gridColumn: `${placement.position.x + 1} / span ${width}`,
    gridRow: `${placement.position.y + 1} / span ${placement.size.h}`,
    "--widget-w": placement.size.w,
    "--widget-h": placement.size.h,
  } as CSSProperties;
}

function canvasMetrics(element: HTMLElement): { column: number; row: number } {
  const style = getComputedStyle(element);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const width = element.clientWidth - paddingLeft - paddingRight;
  return {
    column: Math.max(24, (width - GRID_GAP * 11) / 12),
    row: GRID_ROW + GRID_GAP,
  };
}

function maxRowsForCanvas(canvas: HTMLElement): number {
  const style = getComputedStyle(canvas);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const available = canvas.clientHeight - paddingTop - paddingBottom;
  return Math.max(1, Math.floor((available + GRID_GAP) / (GRID_ROW + GRID_GAP)));
}

function WidgetCard({
  instanceId,
  widget,
  placement,
  projectId,
  sessionId,
}: {
  instanceId: string;
  widget: WidgetDef;
  placement: WidgetPlacement;
  projectId: string | null;
  sessionId: string | null;
}) {
  const layout = useWidgetLayout();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const moveCleanupRef = useRef<(() => void) | null>(null);
  useEscape(menuOpen, () => setMenuOpen(false));
  useEscape(settingsOpen, () => setSettingsOpen(false));
  const config = placement.config ?? {};
  const updateConfig = (next: JsonObject) => {
    updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
  };

  useEffect(() => () => {
    moveCleanupRef.current?.();
    moveCleanupRef.current = null;
  }, []);

  const startMove = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const dragTarget = event.currentTarget;
    const canvas = dragTarget.closest<HTMLElement>(".widget-canvas-grid");
    if (!canvas) return;
    moveCleanupRef.current?.();
    const pointerId = event.pointerId;
    dragTarget.setPointerCapture(pointerId);
    dragTarget.classList.add("widget-card-head-dragging");
    const metrics = canvasMetrics(canvas);
    const dragStartLayout = getWidgetLayout();
    const startPosition = dragStartLayout.widgets[instanceId]?.position ?? placement.position;
    const start = { x: event.clientX, y: event.clientY, position: startPosition };
    let last = startPosition;
    const onMove = (next: globalThis.PointerEvent) => {
      const position: WidgetPosition = {
        x: Math.max(0, Math.min(12 - placement.size.w,
          start.position.x + Math.round((next.clientX - start.x) / (metrics.column + GRID_GAP)))),
        y: Math.max(0, start.position.y + Math.round((next.clientY - start.y) / metrics.row)),
      };
      if (position.x === last.x && position.y === last.y) return;
      last = position;
      updateWidgetLayout((current) =>
        setWidgetPosition(current, instanceId, position, dragStartLayout));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (dragTarget.hasPointerCapture(pointerId)) dragTarget.releasePointerCapture(pointerId);
      dragTarget.classList.remove("widget-card-head-dragging");
      if (moveCleanupRef.current === cleanup) moveCleanupRef.current = null;
    };
    const onUp = () => cleanup();
    const onCancel = () => cleanup();
    moveCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget.closest<HTMLElement>(".widget-canvas-grid");
    if (!canvas) return;
    const metrics = canvasMetrics(canvas);
    const maxRows = maxRowsForCanvas(canvas);
    const start = { x: event.clientX, y: event.clientY, ...placement.size };
    let last = placement.size;
    const onMove = (next: globalThis.PointerEvent) => {
      const size = {
        w: Math.max(1, Math.min(12 - placement.position.x,
          start.w + Math.round((next.clientX - start.x) / (metrics.column + GRID_GAP)))),
        h: Math.max(1, Math.min(maxRows, start.h + Math.round((next.clientY - start.y) / metrics.row))),
      };
      if (size.w === last.w && size.h === last.h) return;
      last = size;
      updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current,
        [{ type: "resize", id: instanceId, size }],
        [widget],
      ));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 2 : 1;
    let size = placement.size;
    if (event.key === "ArrowRight") size = { ...size, w: size.w + step };
    else if (event.key === "ArrowLeft") size = { ...size, w: size.w - step };
    else if (event.key === "ArrowDown") size = { ...size, h: size.h + step };
    else if (event.key === "ArrowUp") size = { ...size, h: size.h - step };
    else return;
    event.preventDefault();
    const canvas = event.currentTarget.closest<HTMLElement>(".widget-canvas-grid");
    const maxRows = canvas ? maxRowsForCanvas(canvas) : 12;
    size = {
      w: Math.max(1, Math.min(12 - placement.position.x, size.w)),
      h: Math.max(1, Math.min(maxRows, size.h)),
    };
    updateWidgetLayout((current) => applyWidgetLayoutMutations(
      current,
      [{ type: "resize", id: instanceId, size }],
      [widget],
    ));
  };

  return (
    <section className="widget-card editing" style={positionStyle(placement)} data-widget-id={instanceId}>
      <header className="widget-card-head widget-card-head-draggable" onPointerDown={startMove}>
        <button
          className="widget-drag"
          aria-label={tr("widgets.widgetcanvas.moveValue", { value: placement.title ?? widget.title })}
          title={tr("widgets.widgetcanvas.dragToMove")}
        >⠿</button>
        <strong>{placement.title ?? widget.title}</strong>
        <div className="widget-card-menu-shell" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className="widget-card-more"
            aria-label={tr("widgets.widgetcanvas.moreOptionsForValue", { title: widget.title })}
            aria-expanded={menuOpen}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMenuOpen((open) => !open)}
          >⋮</button>
          {menuOpen && (
            <div className="widget-card-menu" role="menu">
              <button role="menuitem" onClick={() => {
                setSettingsOpen(true);
                setMenuOpen(false);
              }}>{tr("common.settings")}</button>
              {widget.duplicatable && (
                <button role="menuitem" onClick={() => {
                  updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    [{ type: "duplicate", id: instanceId }],
                    [widget],
                  ));
                  setMenuOpen(false);
                }}>{tr("widgets.widgetcanvas.duplicate")}</button>
              )}
              <button role="menuitem" onClick={() => {
                updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "visibility", id: instanceId, visible: false }],
                  [widget],
                ));
                setMenuOpen(false);
              }}>{tr("widgets.widgetcanvas.removeFromCanvas")}</button>
            </div>
          )}
        </div>
      </header>
      <div className="widget-card-body">
        {settingsOpen ? (
          <div className="widget-instance-settings">
            <header>
              <strong>{tr("widgets.widgetcanvas.widgetSettings")}</strong>
              <button type="button" aria-label={tr("widgets.widgetcanvas.closeWidgetSettings")} onClick={() => setSettingsOpen(false)}>{tr("widgets.widgetcanvas.message")}</button>
            </header>
            <label className="widget-placement-setting">
              <span>{tr("widgets.widgetcanvas.placement")}</span>
              <select
                value={widgetSlotOf(layout, instanceId) ?? widget.defaultSlot}
                onChange={(event) => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "place", id: instanceId, slot: event.target.value as UiSlot }],
                  [widget],
                ))}
              >
                {supportedWidgetSlots(widget).map((slot) => (
                  <option key={slot} value={slot}>{slotLabel(slot)}</option>
                ))}
              </select>
            </label>
            {widget.settingsRender
              ? widget.settingsRender({
                  projectId,
                  sessionId,
                  editing: true,
                  widgetId: widget.id,
                  instanceId,
                  config,
                  updateConfig,
                })
              : widget.settingsSchema
                ? <SchemaWidgetSettings schema={widget.settingsSchema} config={config} updateConfig={updateConfig} />
                : <div className="builtin-widget-settings"><small>{tr("widgets.widgetcanvas.noAdditionalOptions")}</small></div>}
          </div>
        ) : (
          <ViewErrorBoundary resetKey={`${instanceId}:${projectId ?? ""}:${sessionId ?? ""}`} inline>
            {widget.render({
              projectId,
              sessionId,
              editing: true,
              instanceId,
              config,
              updateConfig,
            })}
          </ViewErrorBoundary>
        )}
      </div>
      {widget.resizable !== false && (
        <button
          className="widget-resize-handle"
          aria-label={tr("widgets.widgetcanvas.resizeValueUseArrowKeys", { title: widget.title })}
          title={tr("widgets.widgetcanvas.dragToResize")}
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        >⌟</button>
      )}
    </section>
  );
}

function WidgetMenu({ widgets, onClose }: { widgets: WidgetDef[]; onClose: () => void }) {
  const layout = useWidgetLayout();
  const [query, setQuery] = useState("");
  const shown = widgets.filter((widget) => {
    const text = `${widget.title} ${widget.description} ${pluginDisplayName(widget)}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  });
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of shown) {
    const name = pluginDisplayName(widget);
    groups.set(name, [...(groups.get(name) ?? []), widget]);
  }
  return (
    <aside className="widget-add-panel widget-menu-single" aria-label={tr("widgets.widgetcanvas.addWidgets")}>
      <div className="widget-add-head">
        <strong>{tr("widgets.widgetcanvas.addWidgets")}</strong>
        <IconButton icon={CloseIcon} size="sm" label={tr("widgets.widgetcanvas.closeWidgetMenu")} onClick={onClose} />
      </div>
      <TextInput
        className="widget-menu-search"
        value={query}
        placeholder={tr("widgets.widgetcanvas.searchWidgets")}
        aria-label={tr("widgets.widgetcanvas.searchWidgets2")}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="widget-menu-list">
        {[...groups.entries()].map(([plugin, items]) => (
          <section key={plugin}>
            <h4>{plugin}</h4>
            {items.map((widget) => {
              const visible = layout.widgets[widget.id]?.visible === true;
              const currentSlot = widgetSlotOf(layout, widget.id) ?? widget.defaultSlot;
              const onCanvas = visible && currentSlot !== undefined && widgetZoneFromSlot(currentSlot) !== null;
              const canvasSlot = supportedWidgetSlots(widget).find(
                (slot) => widgetZoneFromSlot(slot) !== null,
              );
              return (
                <button
                  key={widget.id}
                  className={onCanvas ? "active" : ""}
                  aria-pressed={onCanvas}
                  onClick={() => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    onCanvas
                      ? [{ type: "visibility", id: widget.id, visible: false }]
                      : [
                          { type: "visibility", id: widget.id, visible: true },
                          ...(canvasSlot
                            ? [{ type: "place" as const, id: widget.id, slot: canvasSlot }]
                            : []),
                        ],
                    widgets,
                  ))}
                >
                  <span><strong>{widget.title}</strong><small>{widget.description}</small></span>
                  <span aria-hidden="true">{onCanvas ? "−" : "+"}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

export default function WidgetCanvas() {
  const widgets = useWidgetCatalog();
  const canvasWidgets = useMemo(
    () => widgets.filter((widget) => supportedWidgetZones(widget).length > 0),
    [widgets],
  );
  const layout = useWidgetLayout();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    ensureWidgets(canvasWidgets);
  }, [canvasWidgets]);

  const cards = useMemo(() => {
    const placed = [...new Set(Object.values(layout.zones).flat())];
    return placed.flatMap((instanceId) => {
      const placement = layout.widgets[instanceId];
      const widget = getWidget(widgetDefinitionId(layout, instanceId));
      return placement?.visible && widget ? [{ instanceId, placement, widget }] : [];
    }).sort((a, b) =>
      a.placement.position.y - b.placement.position.y
      || a.placement.position.x - b.placement.position.x);
  }, [layout]);

  return (
    <div className="widget-workspace">
      <button
        className="widget-menu-trigger"
        aria-label={tr("widgets.widgetcanvas.addWidgets")}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Icon.plus /><span>{tr("widgets.widgetcanvas.widgets")}</span>
      </button>
      <div className="widget-canvas-grid">
        {cards.map(({ instanceId, placement, widget }) => (
          <WidgetCard
            key={instanceId}
            instanceId={instanceId}
            widget={widget}
            placement={placement}
            projectId={projectId}
            sessionId={sessionId}
          />
        ))}
        {cards.length === 0 && (
          <button className="widget-canvas-empty" onClick={() => setMenuOpen(true)}>
            <Icon.plus /> {tr("widgets.widgetcanvas.addYourFirstWidget")}</button>
        )}
        <SlotHost
          slot="workspace.canvas"
          context={{ editing: true, visibleWidgetIds: cards.map((card) => card.instanceId) }}
        />
      </div>
      {menuOpen && <WidgetMenu widgets={canvasWidgets} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
