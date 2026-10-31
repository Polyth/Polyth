import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { listSlots, type SlotItem } from "../../slots.ts";
import { useWidgetCatalog, widgetIsAvailable } from "../../widgets/catalog.ts";
import { setWidgetConfig, updateWidgetLayout, useWidgetLayout } from "../../widgets/widgetLayout.ts";
import { supportedWidgetSlots } from "../../widgets/widgetLibrary.ts";
import { mobileRailCells, mobileRailColumns, parseMobileRail, swapMobileRailSlots, useMobileRail, writeMobileRail, type MobileRailSlots } from "../../composer/mobileRail.ts";
import { surfaceMotionDurationMs } from "../../motionPresence.ts";
import { tapFeedback } from "../../haptics.ts";
import { tr } from "../../i18n/index.ts";
import { announce } from "../a11y/live.tsx";
import { SlotBoundary, useSlotVersion, type SlotContext } from "../slots/SlotHost.ts";
import WidgetGlyph from "../WidgetGlyph.tsx";
import { AddIcon, Button, CheckIcon, ChevronLeftIcon, ChevronRightIcon, DeleteIcon, EditIcon, Icon, IconButton, Menu } from "../ui/index.ts";

const HOLD_MS = 420;
const COMPOSER_SLOTS = ["composer.leading", "composer.trailing", "composer.execution"] as const;

/** Touch entry is deliberate; mouse, keyboard and assistive activation need no hold. */
export function MobileComposerEditButton({ editing, onChange }: { editing: boolean; onChange: (value: boolean) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const pointerType = useRef("");
  const [pressing, setPressing] = useState(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPressing(false);
  };
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  return <IconButton
    icon={editing ? CheckIcon : EditIcon}
    size="sm"
    className="mobile-composer-edit"
    label={editing ? tr("common.done") : tr("composer.mobileRailEdit")}
    title={editing ? tr("common.done") : tr("composer.mobileRailHold")}
    pressed={editing}
    data-holding={pressing || undefined}
    style={{ "--mobile-composer-hold": `${HOLD_MS}ms` } as CSSProperties}
    onPointerDown={(event) => {
      pointerType.current = event.pointerType;
      if (event.button !== 0 || !event.isPrimary || editing) return;
      cancel();
      held.current = false;
      if (event.pointerType === "mouse") return;
      origin.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPressing(true);
      timer.current = setTimeout(() => {
        cancel();
        held.current = true;
        onChange(true);
        tapFeedback();
        announce(tr("composer.mobileRailHint"));
      }, HOLD_MS);
    }}
    onPointerMove={(event) => {
      if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancel();
    }}
    onPointerUp={cancel}
    onPointerCancel={cancel}
    onLostPointerCapture={cancel}
    onBlur={cancel}
    onContextMenu={(event) => event.preventDefault()}
    onClick={(event) => {
      if (held.current) { held.current = false; return; }
      if (editing || event.detail === 0 || pointerType.current === "mouse") onChange(!editing);
      else announce(tr("composer.mobileRailHold"));
    }}
  />;
}

export default function MobileComposerRail({ storageKey, context, add, primary, resting = false, editing, onEditingChange }: {
  storageKey: string;
  context: SlotContext;
  add: ReactNode;
  primary: ReactNode;
  /** The resting composer is one row: Add · input · first launcher · Send. */
  resting?: boolean;
  editing: boolean;
  onEditingChange: (value: boolean) => void;
}) {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  useSlotVersion();
  const raw = useMobileRail(storageKey);
  const rail = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(6);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const gesture = useRef<{ pointerId: number; from: number; to: number; x: number; y: number; node: HTMLElement; capture: HTMLButtonElement; moved: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const beforeMove = useRef(new Map<string, DOMRect>());
  // Launchers registered when the rail first painted, so one a
  // package registers later (dictation's mic after boot) fades in instead of
  // popping into the row. Layout changes (lane count) never count as arrival.
  const firstLaunchers = useRef<ReadonlySet<string> | null>(null);

  const catalog = [
    { id: "host:add", title: tr("composeraddmenu.addFilesContextAndTools"), icon: <Icon icon={AddIcon} />, content: add, defaultVisible: true, required: false, available: add !== null && add !== undefined },
    ...widgets.filter((widget) => widget.kind === "mini-widget" && supportedWidgetSlots(widget).some((slot) => COMPOSER_SLOTS.includes(slot as typeof COMPOSER_SLOTS[number])))
      // A people-only composer leaves out what acts on the agent's turn.
      .filter((widget) => !(widget.agentOnly && context.agentless === true))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
      .map((widget) => {
        const config = layout.widgets[widget.id]?.config ?? {};
        const available = widgetIsAvailable(widget, {
          projectId: typeof context.projectId === "string" ? context.projectId : null,
          sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
          config,
        });
        const item: SlotItem = { id: widget.id, order: 0, render: (hostContext) => widget.render({
          ...hostContext,
          projectId: typeof context.projectId === "string" ? context.projectId : null,
          sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
          editing: false, instanceId: widget.id, config,
          updateConfig: (next) => updateWidgetLayout((current) => setWidgetConfig(current, widget.id, next)),
        }) };
        return { id: `widget:${widget.id}`, title: widget.title, icon: <WidgetGlyph widget={widget} />, content: <SlotBoundary slot="composer.leading" item={item} context={context} />, defaultVisible: widget.defaultVisible === true || widget.requiredVisible === true, required: widget.requiredVisible === true, available };
      }),
    ...COMPOSER_SLOTS.flatMap((slot) => listSlots(slot).map((item) => ({
      id: `slot:${slot}:${item.id}`, title: typeof item.meta?.title === "string" ? item.meta.title : item.id.replace(/[._-]/g, " "),
      icon: <Icon icon={AddIcon} />, content: <SlotBoundary slot={slot} item={item} context={context} />, defaultVisible: true, required: false, available: true,
    }))),
  ];
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const slots = parseMobileRail(raw) ?? catalog.filter((item) => item.defaultVisible).map((item) => item.id);
  for (const item of catalog) if (item.required && !slots.includes(item.id)) slots.push(item.id);
  // A launcher with nothing to show here (a custom-action bar before the
  // project has an action) gives up its cell outside edit mode, as slot hosts
  // omit it, instead of leaving an empty tap target that widens the rail.
  // Edit mode keeps it in place so it can still be moved or removed.
  const shown = editing ? slots : slots.filter((id) => !id || byId.get(id)?.available !== false);
  const cells = mobileRailCells(shown, columns - 1, editing);
  // Resting hides the other launchers with CSS instead of unmounting them, so
  // a control in use (a dictation in progress) survives the state change.
  // The resting row keeps the launcher the engaged rail shows nearest Send:
  // the last one on its first, unscrolled page. Only when that page has none
  // besides Add does the first launcher further along stand in.
  const quick = (id: string | null) => !!id && id !== "host:add" && byId.has(id);
  const restingQuick = cells.slice(0, columns - 1).findLast(quick) ?? cells.find(quick);
  const initialLaunchers = firstLaunchers.current;
  useEffect(() => {
    if (!firstLaunchers.current) firstLaunchers.current = new Set(byId.keys());
  });

  const clearDrag = () => {
    const current = gesture.current;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    current?.node.style.removeProperty("transform");
    if (current?.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId);
    setDragged(null);
    setOver(null);
  };
  useLayoutEffect(() => {
    const node = rail.current;
    // The resting row dissolves the rail into the card, which keeps its
    // engaged width, so the card stands in for the rail box there: the
    // resting launcher depends on the engaged section count.
    const box = resting ? node?.closest<HTMLElement>(".composer-card") : node;
    if (!node || !box) return;
    const primaryNode = node.querySelector<HTMLElement>(".mobile-composer-primary");
    const measure = () => {
      const style = getComputedStyle(node);
      const width = box.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const tap = parseFloat(style.getPropertyValue("--tap")) || 44;
      const gap = parseFloat(style.columnGap);
      setColumns(mobileRailColumns(width, tap, primaryNode?.getBoundingClientRect().width || tap, Number.isFinite(gap) ? gap : 4));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (primaryNode) observer.observe(primaryNode);
    return () => observer.disconnect();
  }, [resting]);
  useEffect(() => {
    clearDrag();
    if (!editing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onEditingChange(false);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", clearDrag);
      clearDrag();
    };
  }, [editing, columns, storageKey]);
  useLayoutEffect(() => {
    const duration = surfaceMotionDurationMs();
    if (duration) rail.current?.querySelectorAll<HTMLElement>("[data-launcher-id]").forEach((node) => {
      const previous = beforeMove.current.get(node.dataset.launcherId!);
      if (!previous || !node.animate) return;
      node.getAnimations().forEach((animation) => animation.cancel());
      const next = node.getBoundingClientRect();
      if (previous.x === next.x && previous.y === next.y) return;
      node.animate([{ transform: `translate(${previous.x - next.x}px, ${previous.y - next.y}px)` }, { transform: "none" }], {
        duration, easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim() || "ease-out",
      });
    });
    beforeMove.current.clear();
  }, [raw]);
  const commit = (next: MobileRailSlots) => {
    rail.current?.querySelectorAll<HTMLElement>("[data-launcher-id]").forEach((node) => beforeMove.current.set(node.dataset.launcherId!, node.getBoundingClientRect()));
    writeMobileRail(storageKey, next);
    tapFeedback();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    suppressClick.current = true;
    setDragged(cells[current.from] ?? null);
    event.preventDefault();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { current.node.style.transform = `translate(${dx}px, ${dy}px)`; });
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-mobile-rail-cell]");
    if (target && rail.current?.contains(target)) {
      current.to = Number(target.dataset.mobileRailCell);
      setOver(current.to);
    } else {
      current.to = current.from;
      setOver(null);
    }
  };
  return <>
    <div ref={rail} className="composer-rail mobile-composer-rail" data-editing={editing || undefined} data-resting={resting || undefined} style={{ "--mobile-rail-lanes": columns - 1 } as CSSProperties}>
      <div className="mobile-composer-launchers" role="group" aria-label={tr("composer.mobileRailEdit")}>
        {cells.map((id, index) => {
          const item = id ? byId.get(id) : undefined;
          return <div key={id ?? `empty:${index}`} className="mobile-composer-cell" data-mobile-rail-cell={index} data-launcher-id={item?.id} data-dragging={dragged === item?.id || undefined} data-drop={over === index || undefined}
            data-resting={item?.id === "host:add" ? "add" : item && item.id === restingQuick ? "quick" : undefined}
            data-arrived={item && initialLaunchers && !initialLaunchers.has(item.id) ? true : undefined}>
            <div className="mobile-composer-launcher" inert={editing || undefined} aria-hidden={editing || undefined}>{item?.content}</div>
            {editing && <Menu label={item?.title ?? tr("composer.mobileRailAdd")} align="start" entries={item ? [
              { id: "previous", label: tr("composer.mobileRailPrevious"), icon: ChevronLeftIcon, disabled: index === 0, onSelect: () => commit(swapMobileRailSlots(cells, index, index - 1)) },
              { id: "next", label: tr("composer.mobileRailNext"), icon: ChevronRightIcon, disabled: index === cells.length - 1, onSelect: () => commit(swapMobileRailSlots(cells, index, index + 1)) },
              { id: "remove", label: tr("composer.mobileRailRemove", { name: item.title }), icon: DeleteIcon, danger: true, disabled: item.required, onSelect: () => commit(cells.map((value, i) => i === index ? null : value)) },
            ] : catalog.filter((entry) => !slots.includes(entry.id)).map((entry) => ({ id: entry.id, label: entry.title, icon: () => entry.icon, onSelect: () => commit(cells.map((value, i) => i === index ? entry.id : value)) }))}>
              {(trigger) => <button {...trigger} type="button" className="mobile-composer-cell-edit" aria-label={item ? tr("composer.mobileRailAction", { name: item.title }) : tr("composer.mobileRailAdd")}
                onPointerDown={(event) => {
                  suppressClick.current = false;
                  if (!item || event.button !== 0 || !event.isPrimary || gesture.current) return;
                  event.currentTarget.parentElement!.getAnimations?.().forEach((animation) => animation.cancel());
                  gesture.current = { pointerId: event.pointerId, from: index, to: index, x: event.clientX, y: event.clientY, node: event.currentTarget.parentElement!, capture: event.currentTarget, moved: false };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={move}
                onPointerUp={() => {
                  const current = gesture.current;
                  clearDrag();
                  if (current?.moved && current.from !== current.to) {
                    commit(swapMobileRailSlots(cells, current.from, current.to));
                    announce(tr("composer.mobileRailMoved"));
                  }
                }}
                onPointerCancel={clearDrag}
                onLostPointerCapture={clearDrag}
                onContextMenu={(event) => event.preventDefault()}
                onClick={(event) => {
                  if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; }
                  suppressClick.current = false;
                  trigger.onClick();
                }}
              >{!item && <Icon icon={AddIcon} size="sm" />}</button>}
            </Menu>}
          </div>;
        })}
      </div>
      <div className="mobile-composer-primary" inert={editing || undefined}><span className="composer-primary">{primary}</span></div>
    </div>
    {editing && <div className="mobile-composer-editor-bar"><span>{tr("composer.mobileRailHint")}</span><Button size="sm" variant="ghost" onClick={() => { writeMobileRail(storageKey, null); tapFeedback(); }}>{tr("composer.mobileRailReset")}</Button></div>}
  </>;
}
