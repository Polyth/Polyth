import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { JsonObject, JsonValue, UiSlot } from "@polyth/contracts";
import { useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { useEscape } from "../useEscape.ts";
import {
  AddIcon,
  Button,
  Checkbox,
  CloseIcon,
  IconButton,
  Menu,
  MoreVerticalIcon,
  Select,
  TextInput,
} from "../components/ui/index.ts";
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
import { areaPlacementOptions } from "./areaFit.ts";
import "./builtinWidgets.tsx";
import { tr } from "../i18n/index.ts";
import { getDragWidget, WIDGET_MIME } from "../dnd.ts";
import WidgetGlyph from "../components/WidgetGlyph.tsx";

const GRID_GAP = 10;
const GRID_ROW = 36;

interface SchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
}

export function SchemaWidgetSettings({
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
            <Checkbox
              key={key}
              checked={value === true}
              onChange={(checked) => updateConfig({ ...config, [key]: checked })}
              label={<><strong>{label}</strong>{description && <small>{description}</small>}</>}
            />
          );
        }
        if (choices.length > 0) {
          return (
            <label key={key}>
              <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
              <Select
                label={label}
                value={typeof value === "string" ? value : choices[0]}
                onChange={(next) => updateConfig({ ...config, [key]: next })}
                options={choices.map((choice) => ({ value: choice, label: choice }))}
              />
            </label>
          );
        }
        return (
          <label key={key}>
            <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
            <TextInput
              type={property.type === "number" || property.type === "integer" ? "number" : "text"}
              value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
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
  selected,
  onSelect,
}: {
  instanceId: string;
  widget: WidgetDef;
  placement: WidgetPlacement;
  projectId: string | null;
  sessionId: string | null;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const layout = useWidgetLayout();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const moveCleanupRef = useRef<(() => void) | null>(null);
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
    <section className={`widget-card editing${selected ? " selected" : ""}`} style={positionStyle(placement)} data-widget-id={instanceId} onClick={() => onSelect?.(instanceId)}>
      <header className="widget-card-head widget-card-head-draggable" onPointerDown={startMove}>
        <button
          className="widget-drag"
          aria-label={tr("widgets.widgetcanvas.moveValue", { value: placement.title ?? widget.title })}
          title={tr("widgets.widgetcanvas.dragToMove")}
        >⠿</button>
        <strong>{placement.title ?? widget.title}</strong>
        <div className="widget-card-menu-shell" onPointerDown={(event) => event.stopPropagation()}>
          <Menu
            label={tr("widgets.widgetcanvas.moreOptionsForValue", { title: widget.title })}
            align="end"
            entries={[
              { id: "settings", label: tr("common.settings"), onSelect: () => setSettingsOpen(true) },
              ...(widget.duplicatable
                ? [{
                    id: "duplicate",
                    label: tr("widgets.widgetcanvas.duplicate"),
                    onSelect: () => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                      current,
                      [{ type: "duplicate", id: instanceId }],
                      [widget],
                    )),
                  }]
                : []),
              {
                id: "remove",
                label: tr("widgets.widgetcanvas.removeFromCanvas"),
                onSelect: () => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "visibility", id: instanceId, visible: false }],
                  [widget],
                )),
              },
            ]}
          >
            {(trigger) => (
              <IconButton
                {...trigger}
                className="widget-card-more"
                icon={MoreVerticalIcon}
                size="sm"
                variant="ghost"
                label={tr("widgets.widgetcanvas.moreOptionsForValue", { title: widget.title })}
                onPointerDown={(event) => event.stopPropagation()}
              />
            )}
          </Menu>
        </div>
      </header>
      <div className="widget-card-body">
        {settingsOpen ? (
          <div className="widget-instance-settings">
            <header>
              <strong>{tr("widgets.widgetcanvas.widgetSettings")}</strong>
              <IconButton icon={CloseIcon} size="sm" label={tr("widgets.widgetcanvas.closeWidgetSettings")} onClick={() => setSettingsOpen(false)} />
            </header>
            <label className="widget-placement-setting">
              <span>{tr("widgets.widgetcanvas.placement")}</span>
              <Select
                label={tr("widgets.widgetcanvas.placement")}
                value={widgetSlotOf(layout, instanceId) ?? widget.defaultSlot}
                onChange={(slot) => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "place", id: instanceId, slot: slot as UiSlot }],
                  [widget],
                ))}
                options={areaPlacementOptions(widget)}
              />
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
                  <WidgetGlyph widget={widget} />
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

export default function WidgetCanvas({
  selectedId,
  onSelect,
  onDropSlot,
  editing = false,
}: {
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onDropSlot?: (id: string) => void;
  editing?: boolean;
} = {}) {
  const widgets = useWidgetCatalog();
  const canvasWidgets = useMemo(
    // Buttons belong to their shell surface. Never let a mini-widget turn into
    // a canvas card merely because a plugin supplied a broad slot list.
    () => widgets.filter((widget) => widget.kind !== "mini-widget" && supportedWidgetZones(widget).length > 0),
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
      return placement?.visible && widget && widget.kind !== "mini-widget"
        ? [{ instanceId, placement, widget }]
        : [];
    }).sort((a, b) =>
      a.placement.position.y - b.placement.position.y
      || a.placement.position.x - b.placement.position.x);
  }, [layout]);

  return (
    <div className="widget-workspace customize-zone">
      <div className="widget-canvas-grid" data-widget-surface="workspace-canvas"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(WIDGET_MIME)) event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          const id = getDragWidget(event.dataTransfer);
          if (id && canvasWidgets.some((widget) => widget.id === id)) {
            event.preventDefault(); onDropSlot?.(id);
          }
        }}>
        {cards.map(({ instanceId, placement, widget }) => (
          <WidgetCard
            key={instanceId}
            instanceId={instanceId}
            widget={widget}
            placement={placement}
            projectId={projectId}
            sessionId={sessionId}
            selected={selectedId === instanceId}
            onSelect={onSelect}
          />
        ))}
        {cards.length === 0 && (
          <Button className="widget-canvas-empty" iconStart={AddIcon} onClick={() => setMenuOpen(true)}>
            {tr("widgets.widgetcanvas.addYourFirstWidget")}
          </Button>
        )}
        <SlotHost
          slot="workspace.canvas"
          context={{ editing: true, visibleWidgetIds: cards.map((card) => card.instanceId) }}
          customizable
        />
      </div>
      {/* Shift-key customization mode: the customize trigger is the canvas's
          LAST item; the menu applies add/remove instantly. */}
      <Button
        className={`widget-menu-trigger zone-customize-trigger${editing || menuOpen ? " force-visible" : ""}`}
        size="sm"
        iconStart={AddIcon}
        aria-label={tr("widgets.widgetcanvas.addWidgets")}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {tr("widgets.widgetcanvas.widgets")}
      </Button>
      {menuOpen && <WidgetMenu widgets={canvasWidgets} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
