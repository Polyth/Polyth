import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { listSlots, type SlotItem } from "../../slots.ts";
import { useWidgetCatalog, widgetIsAvailable } from "../../widgets/catalog.ts";
import { setWidgetConfig, updateWidgetLayout, useWidgetLayout } from "../../widgets/widgetLayout.ts";
import { supportedWidgetSlots } from "../../widgets/widgetLibrary.ts";
import {
  mobileRailColumns,
  mobileRailIds,
  moveMobileRailLauncher,
  parseMobileRail,
  removeMobileRailLauncher,
  sameMobileRail,
  useMobileRail,
  writeMobileRail,
  type MobileRailArrangement,
} from "../../composer/mobileRail.ts";
import { surfaceMotionDurationMs } from "../../motionPresence.ts";
import { selectionFeedback, tapFeedback } from "../../haptics.ts";
import { tr } from "../../i18n/index.ts";
import { announce } from "../a11y/live.tsx";
import { SlotBoundary, useSlotVersion, type SlotContext } from "../slots/SlotHost.ts";
import WidgetGlyph from "../WidgetGlyph.tsx";
import { AddIcon, Button, Icon, MinusIcon } from "../ui/index.ts";

/** As on an iPhone Home Screen: holding any composer button starts arranging. */
export const MOBILE_RAIL_HOLD_MS = 500;
const COMPOSER_SLOTS = ["composer.leading", "composer.trailing", "composer.execution"] as const;
type Run = "start" | "end";

interface Gesture {
  pointerId: number;
  id: string;
  /** Pointer offset inside the lifted cell, so it stays under the finger. */
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
}

/** Layout box relative to the launchers box, ignoring the transforms of the
 *  reflow animation, so hit testing never chases a cell that is still moving. */
function layoutBox(node: HTMLElement, root: HTMLElement): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  let current: HTMLElement | null = node;
  while (current && current !== root) {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { left, top, width: node.offsetWidth, height: node.offsetHeight };
}

function cellNode(root: HTMLElement | null, id: string): HTMLElement | null {
  for (const node of root?.querySelectorAll<HTMLElement>("[data-launcher-id]") ?? []) if (node.dataset.launcherId === id) return node;
  return null;
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
  const launchers = useRef<HTMLDivElement>(null);
  const endRun = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(6);
  const [preview, setPreview] = useState<{ id: string; arrangement: MobileRailArrangement } | null>(null);
  /** The launcher just added from the tray settles in like an arriving one. */
  const [added, setAdded] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; pointerId: number; x: number; y: number } | null>(null);
  /** A hold that is still down when arranging starts lifts that launcher, so
   *  one gesture can hold and then drag, as on the Home Screen. */
  const pendingLift = useRef<Gesture | null>(null);
  const beforeMove = useRef(new Map<string, DOMRect>());
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
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
        return { id: `widget:${widget.id}`, title: widget.title, detail: widget.description, icon: <WidgetGlyph widget={widget} />, content: <SlotBoundary slot="composer.leading" item={item} context={context} />, defaultVisible: widget.defaultVisible === true || widget.requiredVisible === true, required: widget.requiredVisible === true, available };
      }),
    ...COMPOSER_SLOTS.flatMap((slot) => listSlots(slot).map((item) => ({
      id: `slot:${slot}:${item.id}`, title: typeof item.meta?.title === "string" ? item.meta.title : item.id.replace(/[._-]/g, " "),
      icon: <Icon icon={AddIcon} />, content: <SlotBoundary slot={slot} item={item} context={context} />, defaultVisible: true, required: false, available: true,
    }))),
  ];
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const defaults: MobileRailArrangement = { start: catalog.filter((item) => item.defaultVisible).map((item) => item.id), end: [] };
  const saved = parseMobileRail(raw) ?? defaults;
  const placed = new Set(mobileRailIds(saved));
  // Ids without a catalog entry (a disabled package) stay in the record so
  // re-enabling the package puts its button back where it was.
  const arrangement: MobileRailArrangement = {
    start: [...saved.start, ...catalog.filter((item) => item.required && !placed.has(item.id)).map((item) => item.id)],
    end: saved.end,
  };
  const presented = preview?.arrangement ?? arrangement;
  // A launcher with nothing to show here (a custom-action bar before the
  // project has an action) gives up its place outside edit mode, as slot
  // hosts omit it. It never holds an empty lane, so the launchers around it,
  // and the run beside Send, keep their places either way.
  const shows = (id: string) => editing ? byId.has(id) : byId.get(id)?.available === true;
  const start = presented.start.filter(shows);
  const end = presented.end.filter(shows);
  // Resting hides the other launchers with CSS instead of unmounting them, so
  // a control in use (a dictation in progress) survives the state change.
  // The resting row keeps the launcher the engaged rail shows nearest Send:
  // the last beside Send, else the last on the unscrolled leading run.
  const quick = (id: string) => id !== "host:add";
  const restingQuick = end.findLast(quick) ?? start.slice(0, Math.max(1, columns - 1 - end.length)).findLast(quick) ?? start.find(quick);
  const initialLaunchers = firstLaunchers.current;
  useEffect(() => {
    if (!firstLaunchers.current) firstLaunchers.current = new Set(byId.keys());
  });

  const commit = (next: MobileRailArrangement) => {
    rail.current?.querySelectorAll<HTMLElement>("[data-launcher-id]").forEach((node) => beforeMove.current.set(node.dataset.launcherId!, node.getBoundingClientRect()));
    writeMobileRail(storageKey, next);
    tapFeedback();
  };
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const clearDrag = () => {
    const current = gesture.current;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (current) {
      cellNode(rail.current, current.id)?.style.removeProperty("transform");
      if (rail.current?.hasPointerCapture(current.pointerId)) rail.current.releasePointerCapture(current.pointerId);
    }
    setPreview(null);
  };

  useLayoutEffect(() => {
    const node = rail.current;
    // The resting row dissolves the rail into the card, which keeps its
    // engaged width, so the card stands in for the rail box there: the
    // resting launcher depends on the engaged lane count.
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
    cancelHold();
    setAdded(null);
    if (!editing) return;
    const lift = pendingLift.current;
    pendingLift.current = null;
    if (lift && rail.current) {
      gesture.current = lift;
      try { rail.current.setPointerCapture(lift.pointerId); } catch { /* the finger already lifted */ }
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onEditingChangeRef.current(false);
    };
    // A tap anywhere else ends arranging, as on the Home Screen. Menus opened
    // from the bar (Add) are portalled and count as inside.
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || rail.current?.contains(target) || bar.current?.contains(target)) return;
      if (target.closest(".ui-menu, .ui-menu-sheet, [role='dialog'], [role='menu']")) return;
      onEditingChangeRef.current(false);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", clearDrag);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", clearDrag);
      document.removeEventListener("pointerdown", outside, true);
      clearDrag();
    };
  }, [editing, storageKey]);
  useEffect(() => {
    // A launcher lifted by a hold began as a touch the browser may pan (the
    // leading run scrolls), which would cancel the drag. Once something is
    // lifted, the rail keeps the touch for itself.
    const node = rail.current;
    const keep = (event: TouchEvent) => { if (gesture.current && event.cancelable) event.preventDefault(); };
    node?.addEventListener("touchmove", keep, { passive: false });
    return () => {
      node?.removeEventListener("touchmove", keep);
      cancelHold();
    };
  }, []);

  // Reflow: every launcher that changed place glides from where it was.
  const order = `${start.join(",")}|${end.join(",")}`;
  useLayoutEffect(() => {
    const duration = surfaceMotionDurationMs();
    const lifted = gesture.current?.moved ? gesture.current.id : null;
    if (duration) rail.current?.querySelectorAll<HTMLElement>("[data-launcher-id]").forEach((node) => {
      const id = node.dataset.launcherId!;
      const previous = beforeMove.current.get(id);
      if (!previous || !node.animate || id === lifted) return;
      node.getAnimations().forEach((animation) => animation.cancel());
      const next = node.getBoundingClientRect();
      if (previous.x === next.x && previous.y === next.y) return;
      node.animate([{ translate: `${previous.x - next.x}px ${previous.y - next.y}px` }, { translate: "0 0" }], {
        duration, easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim() || "ease-out",
      });
    });
    beforeMove.current.clear();
    place();
  }, [order, raw, preview === null]);

  /** Keep the lifted launcher under the finger wherever the reflow put it. */
  function place() {
    const current = gesture.current;
    const root = launchers.current;
    if (!current?.moved || !root) return;
    const node = cellNode(root, current.id);
    if (!node) return;
    const origin = root.getBoundingClientRect();
    const box = layoutBox(node, root);
    node.style.transform = `translate(${current.x - current.grabX - origin.left - box.left}px, ${current.y - current.grabY - origin.top - box.top}px)`;
  }

  /** Where the lifted launcher would land: in the run beside Send once the
   *  finger reaches it (or the last lane), else at its reading-order place
   *  among the leading run. */
  const target = (id: string, x: number, y: number): { run: Run; index: number } => {
    const root = launchers.current!;
    const origin = root.getBoundingClientRect();
    const px = x - origin.left;
    const py = y - origin.top;
    const boxes = (run: Run) => Array.from(root.querySelectorAll<HTMLElement>(`[data-run="${run}"]`))
      .filter((node) => node.dataset.launcherId !== id)
      .map((node) => layoutBox(node, root));
    const lane = root.clientWidth / Math.max(1, columns - 1);
    const endBoxes = boxes("end");
    const endLeft = endRun.current ? layoutBox(endRun.current, root).left : root.clientWidth;
    if (px >= Math.min(endLeft, root.clientWidth - lane)) {
      return { run: "end", index: endBoxes.filter((box) => box.left + box.width / 2 < px).length };
    }
    const startBoxes = boxes("start");
    if (!startBoxes.length) return { run: "start", index: 0 };
    // The row under the finger, or the nearest one above or below.
    const rows = [...new Set(startBoxes.map((box) => box.top))].sort((a, b) => a - b);
    const height = startBoxes[0]!.height;
    const row = rows.reduce((best, top) => Math.abs(py - (top + height / 2)) < Math.abs(py - (best + height / 2)) ? top : best, rows[0]!);
    const before = startBoxes.findIndex((box) => box.top > row || (box.top === row && px < box.left + box.width / 2));
    return { run: "start", index: before < 0 ? startBoxes.length : before };
  };

  const lift = (id: string, event: PointerEvent<HTMLElement>, node: HTMLElement): Gesture => {
    node.getAnimations?.().forEach((animation) => animation.cancel());
    const rect = node.getBoundingClientRect();
    return { pointerId: event.pointerId, id, grabX: event.clientX - rect.left, grabY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  };
  const drop = () => {
    const current = gesture.current;
    const next = preview?.arrangement;
    if (current?.moved) {
      // The lifted launcher settles from under the finger into its place.
      const node = cellNode(rail.current, current.id);
      if (node) beforeMove.current.set(current.id, node.getBoundingClientRect());
    }
    if (current?.moved && next && !sameMobileRail(next, arrangement)) {
      // Persist first, then drop the preview: the saved order is already
      // what is on screen, so nothing jumps back for a frame.
      writeMobileRail(storageKey, next);
      tapFeedback();
      announce(tr("composer.mobileRailMoved"));
    }
    clearDrag();
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
    event.preventDefault();
    const base = preview?.arrangement ?? arrangement;
    if (!current.moved) {
      current.moved = true;
      selectionFeedback();
      setPreview({ id: current.id, arrangement: base });
    }
    const { run, index } = target(current.id, event.clientX, event.clientY);
    // Hidden ids keep their order but are not counted by the hit test, so map
    // the visible index back into the full run before moving.
    const visibleRun = (run === "start" ? start : end).filter((value) => value !== current.id);
    const anchor = visibleRun[index];
    const full = base[run].filter((value) => value !== current.id);
    const next = moveMobileRailLauncher(base, current.id, run, anchor === undefined ? full.length : full.indexOf(anchor));
    if (!sameMobileRail(next, base)) {
      rail.current?.querySelectorAll<HTMLElement>("[data-launcher-id]").forEach((node) => beforeMove.current.set(node.dataset.launcherId!, node.getBoundingClientRect()));
      setPreview({ id: current.id, arrangement: next });
      selectionFeedback();
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(place);
  };

  /** Arrow keys move the focused launcher one place along the row; crossing
   *  the space between the runs moves it beside Send or back. */
  const nudge = (event: KeyboardEvent<HTMLElement>, id: string, run: Run) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const direction = document.documentElement.dir === "rtl" ? -step : step;
    const visibleRun = run === "start" ? start : end;
    const position = visibleRun.indexOf(id);
    let next: MobileRailArrangement | null = null;
    if (run === "start" && direction > 0 && position === start.length - 1) next = moveMobileRailLauncher(arrangement, id, "end", 0);
    else if (run === "end" && direction < 0 && position === 0) next = moveMobileRailLauncher(arrangement, id, "start", arrangement.start.length);
    else {
      const neighbour = visibleRun[position + direction];
      if (neighbour === undefined) return;
      const others = arrangement[run].filter((value) => value !== id);
      const at = others.indexOf(neighbour) + (direction > 0 ? 1 : 0);
      next = moveMobileRailLauncher(arrangement, id, run, at);
    }
    commit(next);
    announce(tr("composer.mobileRailMoved"));
    requestAnimationFrame(() => cellNode(rail.current, id)?.querySelector<HTMLElement>(".mobile-composer-cell-grab")?.focus());
  };

  // Holding any button of the rail starts arranging. Touch only: a mouse press
  // on the mic is push-to-talk, and a right click (below) is the pointer's way in.
  const holdStart = (event: PointerEvent<HTMLDivElement>) => {
    if (editingRef.current || event.pointerType === "mouse" || !event.isPrimary || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".mobile-composer-primary")) return;
    cancelHold();
    const pointerId = event.pointerId;
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-launcher-id]") : null;
    const held = node ? lift(node.dataset.launcherId!, event, node) : null;
    hold.current = {
      pointerId, x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        hold.current = null;
        pendingLift.current = held;
        enterEditing();
        // The release must not also press the launcher under the finger. The
        // click follows the release at once; any later tap is the user's.
        const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
        const disarm = () => window.removeEventListener("click", swallow, { capture: true });
        const released = () => {
          window.removeEventListener("pointerup", released, { capture: true });
          window.removeEventListener("pointercancel", released, { capture: true });
          setTimeout(disarm, 50);
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.addEventListener("pointerup", released, { capture: true });
        window.addEventListener("pointercancel", released, { capture: true });
      }, MOBILE_RAIL_HOLD_MS),
    };
  };
  const holdMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = hold.current;
    if (current && current.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) cancelHold();
  };
  const enterEditing = () => {
    if (editingRef.current) return;
    onEditingChangeRef.current(true);
    tapFeedback();
    announce(tr("composer.mobileRailHint"));
  };

  const cell = (id: string, run: Run, index: number) => {
    const item = byId.get(id)!;
    return <div key={id} className="mobile-composer-cell" data-run={run} data-launcher-id={id}
      data-dragging={preview?.id === id || undefined}
      data-resting={id === "host:add" ? "add" : id === restingQuick ? "quick" : undefined}
      data-arrived={id === added || (initialLaunchers && !initialLaunchers.has(id)) ? true : undefined}
      style={editing ? { "--mobile-rail-jiggle-delay": `${-((index * 3 + (run === "end" ? 1 : 0)) % 4) * 70}ms` } as CSSProperties : undefined}>
      <div className="mobile-composer-launcher" inert={editing || undefined} aria-hidden={editing || undefined}>
        {editing && !item.available ? <span className="mobile-composer-glyph">{item.icon}</span> : item.content}
      </div>
      {editing && <button type="button" className="mobile-composer-cell-grab"
        aria-label={tr("composer.mobileRailAction", { name: item.title })}
        aria-roledescription={tr("composer.mobileRailMovable")}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || gesture.current) return;
          gesture.current = lift(id, event, event.currentTarget.parentElement!);
          // The rail holds the pointer: crossing into the run beside Send
          // remounts this cell, which would drop a capture held by the cell.
          rail.current?.setPointerCapture(event.pointerId);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => nudge(event, id, run)}
      />}
      {editing && !item.required && <button type="button" className="mobile-composer-cell-remove"
        aria-label={tr("composer.mobileRailRemove", { name: item.title })}
        onClick={() => {
          commit(removeMobileRailLauncher(arrangement, id));
          announce(tr("composer.mobileRailRemoved", { name: item.title }));
        }}
      ><Icon icon={MinusIcon} size="sm" /></button>}
    </div>;
  };
  // The rail's own buttons lead the tray, so one just removed is in sight.
  const hidden = catalog.filter((item) => !placed.has(item.id) && !item.required)
    .sort((a, b) => Number(b.defaultVisible) - Number(a.defaultVisible));

  return <>
    <div ref={rail} className="composer-rail mobile-composer-rail" data-editing={editing || undefined} data-resting={resting || undefined}
      style={{ "--mobile-rail-lanes": columns - 1 } as CSSProperties}
      onPointerDownCapture={holdStart}
      onPointerMoveCapture={holdMove}
      onPointerUpCapture={cancelHold}
      onPointerCancelCapture={cancelHold}
      onPointerMove={move}
      onPointerUp={(event) => { if (gesture.current?.pointerId === event.pointerId) drop(); }}
      onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) clearDrag(); }}
      onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId) clearDrag(); }}
      onContextMenu={(event) => {
        // Touch holds are timed above; a right click (or a platform long-press
        // menu) arranges straight away instead of opening the browser menu.
        if (event.target instanceof Element && event.target.closest(".mobile-composer-primary")) return;
        event.preventDefault();
        enterEditing();
      }}
    >
      <div ref={launchers} className="mobile-composer-launchers" role="group" aria-label={tr("composer.mobileRailEdit")}>
        <div className="mobile-composer-run" data-run-box="start">{start.map((id, index) => cell(id, "start", index))}</div>
        <div ref={endRun} className="mobile-composer-run" data-run-box="end" data-empty={end.length === 0 || undefined}>{end.map((id, index) => cell(id, "end", index))}</div>
      </div>
      <div className="mobile-composer-primary" inert={editing || undefined}><span className="composer-primary">{primary}</span></div>
    </div>
    {editing && <div ref={bar} className="mobile-composer-editor">
      {/* As in the iPhone's Control Center editor: what is not in the rail
          waits below it, each with a green plus that adds it to the row. */}
      {hidden.length > 0 && <section className="mobile-composer-tray" aria-label={tr("composer.mobileRailAdd")}>
        <span className="mobile-composer-tray-title" aria-hidden="true">{tr("composer.mobileRailAdd")}</span>
        <div className="mobile-composer-tray-items">
          {hidden.map((entry) => {
            // Two buttons can share a name (a package's composer bar and the
            // launcher opening its page); their descriptions tell them apart.
            const detail = "detail" in entry && typeof entry.detail === "string" && entry.detail && hidden.some((other) => other !== entry && other.title === entry.title) ? entry.detail : null;
            return <button key={entry.id} type="button" className="mobile-composer-tray-item"
              aria-label={tr("composer.mobileRailAddNamed", { name: detail ? `${entry.title}, ${detail}` : entry.title })}
              onClick={() => {
                setAdded(entry.id);
                commit({ start: [...arrangement.start, entry.id], end: arrangement.end });
                announce(tr("composer.mobileRailAdded", { name: entry.title }));
              }}>
              <span className="mobile-composer-tray-badge"><Icon icon={AddIcon} size="sm" /></span>
              <span className="mobile-composer-tray-glyph">{entry.icon}</span>
              <span className="mobile-composer-tray-label">{entry.title}{detail && <small>{detail}</small>}</span>
            </button>;
          })}
        </div>
      </section>}
      <div className="mobile-composer-editor-bar">
        <Button size="sm" variant="ghost" disabled={sameMobileRail(arrangement, defaults)} onClick={() => {
          commit(defaults);
          announce(tr("composer.mobileRailMoved"));
        }}>{tr("composer.mobileRailReset")}</Button>
        <Button size="sm" variant="primary" onClick={() => onEditingChange(false)}>{tr("common.done")}</Button>
      </div>
    </div>}
  </>;
}

/** Keyboard and assistive way in: holding is a touch gesture. Visually hidden
 *  until focused, so the rail shows no edit control of its own. */
export function MobileComposerEditEntry({ editing, onChange }: { editing: boolean; onChange: (value: boolean) => void }) {
  const self = useRef<HTMLButtonElement>(null);
  if (editing) return null;
  return <button ref={self} type="button" className="mobile-composer-edit-entry" onClick={() => {
    const card = self.current?.closest(".composer-card");
    onChange(true);
    // This button leaves with the mode it opened; focus moves onto the first launcher.
    requestAnimationFrame(() => card?.querySelector<HTMLElement>(".mobile-composer-cell-grab")?.focus());
  }}>{tr("composer.mobileRailEdit")}</button>;
}
