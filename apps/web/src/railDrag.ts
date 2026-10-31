// Pointer-driven drag for shell rail launchers (top rail ⇄ right rail).
//
// One drag at a time is owned by this module. Each rail registers a zone and
// renders `order` — its own ids with the live preview applied (the dragged
// icon moved, collapsed away, or replaced by a `null` landing slot). A
// floating ghost follows the pointer; neighbours glide out of the way through
// FLIP animations taken from a visual snapshot just before each preview
// change, so re-targeting mid-animation never jumps. Insertion indices are
// computed against the geometry frozen at lift, which keeps the preview free
// of reflow feedback loops (a centred rail re-centring under the pointer).
//
// Pulled far from every rail (REMOVE_DISTANCE_PX) the icon is no longer
// "hovering nowhere" but leaving: its home closes over the gap like the macOS
// Dock, a "Remove" pill rides the ghost, and releasing there takes the icon
// off its rail in a puff of smoke.
//
// Persisting is the zone's `commit` / `remove`; this module never writes
// layout itself.
import {
  useLayoutEffect, useRef, useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { selectionFeedback, tapFeedback } from "./haptics.ts";
import { tr } from "./i18n/index.ts";
import { motionIsReduced } from "./motionPresence.ts";

export type RailZoneId = string;
export type RailAxis = "x" | "y";
/** `from` of a launcher lifted outside any rail (the Custom actions window,
 *  a settings list). No zone owns it, so the source rail draws no hole and
 *  nothing has to leave before the icon lands. */
export const EXTERNAL_RAIL_SOURCE = "__external";
/** `null` marks the landing slot for an icon arriving from another rail. */
export type RailOrderEntry = string | null;

export interface RailZoneSpec {
  id: RailZoneId;
  axis: RailAxis;
  /** Every rendered launcher id, in visual order. */
  ids: readonly string[];
  isDraggable: (id: string) => boolean;
  /** May an icon from another rail land here? */
  accepts: (id: string) => boolean;
  /** May this icon leave for another rail? Defaults to true. */
  canLeave?: (id: string) => boolean;
  /** HTML5 drag type an icon arriving from OUTSIDE the rails carries
   *  (`dnd.ts` CAPABILITY_MIME). Supplying it makes this rail a drop target
   *  for e.g. a Custom actions tile dragged out of its window. */
  externalMime?: string;
  commit: (order: string[], draggedId: string) => void;
  /** Take an icon off this rail altogether: it was pulled away from every
   *  rail and released. Omit for a rail that must keep what it holds (the
   *  editor's list, the view tabs). */
  remove?: (id: string) => void;
  /** May this icon be taken off? Defaults to true when `remove` is set. */
  canRemove?: (id: string) => boolean;
}

export interface RailDragState {
  id: string;
  from: RailZoneId;
  over: RailZoneId | null;
  index: number;
  phase: "dragging" | "dropping";
  /** The pointer is far enough from every rail that releasing now removes
   *  the icon: its home has closed over the gap and no rail holds a slot. */
  removing?: boolean;
}

/** Mouse/pen movement before a press becomes a drag (a click stays a click). */
export const DRAG_THRESHOLD_PX = 5;
/** Touch lifts on a long press so the rail can still scroll and tap. */
export const TOUCH_LIFT_MS = 320;
const TOUCH_SLOP_PX = 8;
/** Generous hit area around a rail: a near-miss still targets it. */
const ZONE_TOLERANCE_PX = 28;
/** An icon released farther than this from the edge of every rail is removed
 *  instead of put back. Between the hit area and this line a release still
 *  puts it back, so a near-miss never costs the icon. */
export const REMOVE_DISTANCE_PX = 50;
/** A pointer already past the line leaves it only this much closer, so a
 *  hand's tremor on the line cannot flicker the verdict. */
export const REMOVE_HYSTERESIS_PX = 6;
/** A ghost with less than this above it (the pill's height and gap) carries
 *  its "Remove" pill below instead, so it is never cut off by the window. */
const LABEL_ROOM_PX = 44;
const FLIP_MS = 260;
const LAND_MS = 240;
const SETTLE_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const SPRING_EASE = "cubic-bezier(0.34, 1.32, 0.5, 1)";
const SLOT_KEY = "__rail-drag-slot";

// ---------------------------------------------------------------- pure model

/** The order a zone renders for the current drag. */
export function previewOrder(ids: readonly string[], zone: RailZoneId, drag: RailDragState | null): RailOrderEntry[] {
  if (!drag) return [...ids];
  const others = ids.filter((id) => id !== drag.id);
  const insert = (entry: RailOrderEntry): RailOrderEntry[] => {
    const next: RailOrderEntry[] = [...others];
    next.splice(Math.max(0, Math.min(drag.index, next.length)), 0, entry);
    return next;
  };
  if (drag.over === zone) return insert(drag.from === zone ? drag.id : null);
  // Hovering nowhere: the icon's home keeps its hole so release reads "put
  // back". Pulled far enough to be removed, it closes instead, as the Dock does.
  if (drag.from === zone) return drag.over === null && !drag.removing ? [...ids] : others;
  return [...ids];
}

/** Number of resting centres before the pointer (the dragged icon excluded). */
export function insertionIndex(centers: readonly number[], pointer: number): number {
  let index = 0;
  for (const center of centers) if (center < pointer) index += 1;
  return index;
}

/** Straight-line distance from a point to a rectangle (0 on or inside it). */
export function distanceToRect(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): number {
  return Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
}

/** Does a pointer `distance` px from the nearest rail want to remove the
 *  icon? `armed` is the previous verdict: leaving the zone takes a few px
 *  more than entering it. */
export function removalIntent(distance: number, armed: boolean): boolean {
  return distance > REMOVE_DISTANCE_PX - (armed ? REMOVE_HYSTERESIS_PX : 0);
}

/** The order to persist when the drag lands in `drag.over`. */
export function finalOrder(ids: readonly string[], drag: RailDragState): string[] {
  return previewOrder(ids, drag.over ?? drag.from, drag).map((entry) => entry ?? drag.id);
}

// ---------------------------------------------------------------- store

export interface ZoneGeometry {
  rect: DOMRect;
  scroll: number;
  /** Resting centres of the zone's ids (dragged excluded), on the zone axis. */
  centers: number[];
  itemSize: number;
}

interface ZoneEntry {
  spec: RailZoneSpec;
  element: HTMLElement | null;
  geometry: ZoneGeometry | null;
}

const zones = new Map<RailZoneId, ZoneEntry>();
const snapshots = new Map<RailZoneId, WeakMap<Element, DOMRect>>();
const listeners = new Set<() => void>();
let state: RailDragState | null = null;

function emit(next: RailDragState | null): void {
  for (const zoneId of zones.keys()) snapshotZone(zoneId);
  state = next;
  for (const listener of [...listeners]) listener();
  // A zone whose markup did not change consumes nothing; drop leftovers so a
  // later unrelated render cannot replay a stale motion.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => snapshots.clear());
}

export function getRailDrag(): RailDragState | null {
  return state;
}

/** Rail zone geometry frozen at the moment an external drag began, so the
 *  landing slot it opens cannot feed back into the index that opened it. */
const externalGeometry = new Map<RailZoneId, ZoneGeometry>();

/** Persist a drop that arrived from outside every rail, through the same
 *  path a rail-to-rail drop takes. `unchanged` guards a drop that lands the
 *  icon exactly where it already sat. */
function commitDrop(over: RailZoneId | null, id: string, index: number): void {
  const target = over === null ? null : zones.get(over);
  if (!target) return;
  const resolved: RailDragState = { id, from: EXTERNAL_RAIL_SOURCE, over, index, phase: "dragging" };
  const order = finalOrder(target.spec.ids, resolved);
  const unchanged = order.every((entry, at) => entry === target.spec.ids[at]);
  for (const zoneId of zones.keys()) snapshotZone(zoneId);
  if (!unchanged) target.spec.commit(order, id);
}

/** Quieten the rails again after an external drag ends, however it ended. */
function clearExternalDrag(): void {
  externalGeometry.clear();
  delete document.body.dataset.railDragging;
  delete document.body.dataset.railDragOver;
  state = null;
  for (const listener of [...listeners]) listener();
  for (const entry of zones.values()) entry.geometry = null;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => snapshots.clear());
}

/** Begin a drag of `id` (a capability not carried by any rail) from a source
 *  outside the rails: an HTML5 dragstart. Rails then advertise themselves as
 *  drop targets exactly as for a rail-to-rail drag. */
export function beginExternalRailDrag(id: string): void {
  externalGeometry.clear();
  document.body.dataset.railDragging = "true";
  document.body.dataset.railDragOver = "none";
  emit({ id, from: EXTERNAL_RAIL_SOURCE, over: null, index: 0, phase: "dragging" });
}

/** The capability an in-flight external drag is carrying, read from its
 *  `DataTransfer` (only readable from `dragover` on). A drag that started
 *  outside the document (another window, a file) carries none. */
export function resolveExternalRailDrag(id: string | null): string | null {
  const drag = state;
  if (!drag || drag.from !== EXTERNAL_RAIL_SOURCE) return null;
  if (!id || drag.id === id) return drag.id || null;
  emit({ ...drag, id });
  return id;
}

/** The rail under an external HTML5 drag, with its insertion index. Measures
 *  once per rail per drag: the landing slot it opens must not move the slots
 *  the index is counted against. */
export function externalRailDropTarget(zone: RailZoneId, coordinate: number): { over: RailZoneId; index: number } | null {
  const drag = state;
  const entry = zones.get(zone);
  if (!drag || drag.from !== EXTERNAL_RAIL_SOURCE || !entry?.element?.isConnected) return null;
  let geometry = externalGeometry.get(zone);
  if (!geometry) {
    geometry = measureZone(entry, drag.id) ?? undefined;
    if (!geometry) return null;
    externalGeometry.set(zone, geometry);
  }
  return { over: zone, index: insertionIndex(geometry.centers, coordinate + (scrollOf(entry.element, entry.spec.axis) - geometry.scroll)) };
}

/** Point the external preview at `zone` (or at nothing, on leaving it). */
export function externalRailDragOver(over: RailZoneId | null, index = 0): void {
  const drag = state;
  if (!drag || drag.from !== EXTERNAL_RAIL_SOURCE) return;
  if (drag.over === over && drag.index === index) return;
  document.body.dataset.railDragOver = over ?? "none";
  emit({ ...drag, over, index });
}

/** End an external drag. A drop in `zone` persists the rail's new order. */
export function endExternalRailDrag(zone: RailZoneId | null = null, index = 0): void {
  const drag = state;
  if (!drag || drag.from !== EXTERNAL_RAIL_SOURCE) return;
  if (zone !== null && zones.get(zone)?.spec.accepts(drag.id)) commitDrop(zone, drag.id, index);
  clearExternalDrag();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ---------------------------------------------------------------- geometry + FLIP

const axisStart = (rect: DOMRect, axis: RailAxis) => axis === "x" ? rect.left : rect.top;
const axisSize = (rect: DOMRect, axis: RailAxis) => axis === "x" ? rect.width : rect.height;
const scrollOf = (element: HTMLElement, axis: RailAxis) => axis === "x" ? element.scrollLeft : element.scrollTop;

function itemElement(zone: HTMLElement, id: string): HTMLElement | null {
  for (const child of zone.querySelectorAll<HTMLElement>("[data-rail-item]")) {
    if (child.dataset.railItem === id) return child;
  }
  return null;
}

/** Resting rect: the visual rect minus any in-flight FLIP translation. */
function restingRect(element: Element): DOMRect {
  const rect = element.getBoundingClientRect();
  const transform = typeof getComputedStyle === "function" ? getComputedStyle(element).transform : "none";
  if (!transform || transform === "none" || typeof DOMMatrixReadOnly !== "function") return rect;
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return new DOMRect(rect.left - matrix.e, rect.top - matrix.f, rect.width, rect.height);
  } catch { return rect; }
}

function measureZone(entry: ZoneEntry, draggedId: string): ZoneGeometry | null {
  const element = entry.element;
  if (!element) return null;
  const { axis, ids } = entry.spec;
  const centers: number[] = [];
  let itemSize = 0;
  for (const id of ids) {
    const item = itemElement(element, id);
    if (!item) continue;
    const rect = restingRect(item);
    itemSize ||= Math.max(rect.width, rect.height);
    if (id !== draggedId) centers.push(axisStart(rect, axis) + axisSize(rect, axis) / 2);
  }
  return { rect: element.getBoundingClientRect(), scroll: scrollOf(element, axis), centers, itemSize };
}

/** Follow a rail that relocated mid-drag (a pane switching between docked
 *  and layered moves the right rail to the other edge). Only a move across
 *  the rail's axis counts: the preview itself only ever changes a rail's
 *  extent along its axis, so re-centring under the pointer cannot feed back.
 *  The frozen centres travel with the rail instead of being re-measured
 *  against a preview that may already hold a landing slot. */
export function followZone(geometry: ZoneGeometry, live: DOMRect, axis: RailAxis): ZoneGeometry {
  const cross: RailAxis = axis === "x" ? "y" : "x";
  if (Math.abs(axisStart(live, cross) - axisStart(geometry.rect, cross)) < 1) return geometry;
  const shift = axisStart(live, axis) - axisStart(geometry.rect, axis);
  return { ...geometry, rect: live, centers: geometry.centers.map((center) => center + shift) };
}

function snapshotZone(zoneId: RailZoneId): void {
  const element = zones.get(zoneId)?.element;
  if (!element) return;
  const rects = new WeakMap<Element, DOMRect>();
  for (const child of element.children) rects.set(child, child.getBoundingClientRect());
  snapshots.set(zoneId, rects);
}

function flipZone(zoneId: RailZoneId): void {
  const rects = snapshots.get(zoneId);
  const element = zones.get(zoneId)?.element;
  snapshots.delete(zoneId);
  if (!rects || !element || motionIsReduced()) return;
  for (const child of element.children) {
    if (typeof (child as HTMLElement).animate !== "function") continue;
    for (const running of child.getAnimations?.() ?? []) if (running.id === "rail-flip") running.cancel();
    const before = rects.get(child);
    if (!before) {
      if (child.hasAttribute("data-rail-slot")) {
        child.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }],
          { duration: FLIP_MS, easing: SPRING_EASE, id: "rail-flip" });
      }
      continue;
    }
    const after = child.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: FLIP_MS, easing: SETTLE_EASE, id: "rail-flip" });
  }
}

// ---------------------------------------------------------------- the gesture

interface Session {
  id: string;
  from: RailZoneId;
  pointerId: number;
  ghost: HTMLDivElement;
  body: HTMLDivElement;
  origin: DOMRect;
  grabX: number;
  grabY: number;
  lastX: number;
  tilt: number;
  frame: number;
  pending: { x: number; y: number } | null;
  /** The last pointer position a target was resolved for. */
  at: { x: number; y: number } | null;
  sourceSize: number;
  touch: boolean;
  /** Rails that are not drag zones (the project rail), frozen at lift: an
   *  icon released near one is no more removed than one released near a zone. */
  keepClear: DOMRect[];
  cleanup: () => void;
}

let session: Session | null = null;

/** Marks a rail the launcher rails do not manage (`Sidebar.tsx` project rail). */
const RAIL_REGION_SELECTOR = "[data-rail-region]";

function makeGhost(
  source: HTMLElement,
  rect: DOMRect,
  removeLabel: string | null,
): { ghost: HTMLDivElement; body: HTMLDivElement } {
  const ghost = document.createElement("div");
  ghost.className = "rail-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  const body = document.createElement("div");
  body.className = "rail-drag-ghost-body";
  if (source.classList.contains("active")) body.classList.add("is-active");
  const glyph = source.querySelector("svg");
  if (source.dataset.railGhost === "clone") {
    // Editor rows lift as themselves (icon, label, controls), not as a bare glyph.
    const clone = source.cloneNode(true) as HTMLElement;
    for (const attribute of ["data-rail-item", "data-rail-drag-source", "id", "tabindex"]) clone.removeAttribute(attribute);
    body.classList.add("is-clone");
    body.append(clone);
  } else if (glyph) {
    const glyphRect = glyph.getBoundingClientRect();
    const clone = glyph.cloneNode(true) as SVGElement;
    clone.setAttribute("width", String(glyphRect.width || 16));
    clone.setAttribute("height", String(glyphRect.height || 16));
    body.append(clone);
  }
  body.style.color = getComputedStyle(source).color;
  ghost.append(body);
  if (removeLabel !== null) {
    // Beside the body, not in it: the body leans and scales with the pointer,
    // the label must stay level and its own size.
    const label = document.createElement("span");
    label.className = "rail-drag-ghost-label";
    label.textContent = removeLabel;
    ghost.append(label);
  }
  document.body.append(ghost);
  return { ghost, body };
}

function targetZoneAt(x: number, y: number, current: Session): RailZoneId | null {
  for (const [zoneId, entry] of zones) {
    // A rail hidden while empty only mounts once a drag offers it an icon.
    if (!entry.geometry && entry.element?.isConnected) entry.geometry = measureZone(entry, current.id);
    if (!entry.geometry) continue;
    if (entry.element?.isConnected) {
      entry.geometry = followZone(entry.geometry, entry.element.getBoundingClientRect(), entry.spec.axis);
    }
    const geometry = entry.geometry;
    const { rect } = geometry;
    const inside = x >= rect.left - ZONE_TOLERANCE_PX && x <= rect.right + ZONE_TOLERANCE_PX
      && y >= rect.top - ZONE_TOLERANCE_PX && y <= rect.bottom + ZONE_TOLERANCE_PX;
    if (!inside) continue;
    if (zoneId === current.from) return zoneId;
    const fromSpec = zones.get(current.from)?.spec;
    if ((fromSpec?.canLeave?.(current.id) ?? true) && entry.spec.accepts(current.id)) return zoneId;
  }
  return null;
}

function track(x: number, y: number): void {
  const current = session;
  if (!current || state?.phase !== "dragging") return;
  current.pending = { x, y };
  if (current.frame) return;
  current.frame = requestAnimationFrame(() => {
    const live = session;
    if (!live) return;
    live.frame = 0;
    const point = live.pending;
    live.pending = null;
    if (!point) return;
    // Lean into the motion like a picked-up object; settle when still.
    const velocity = point.x - live.lastX;
    live.lastX = point.x;
    live.tilt = live.tilt * 0.7 + Math.max(-9, Math.min(9, velocity * 0.9)) * 0.3;
    live.ghost.style.transform = `translate3d(${point.x - live.grabX - live.origin.left}px, ${point.y - live.grabY - live.origin.top}px, 0)`;
    live.body.style.setProperty("--rail-ghost-tilt", `${live.tilt.toFixed(2)}deg`);
    if (point.y - live.grabY < LABEL_ROOM_PX) live.ghost.dataset.label = "below";
    else delete live.ghost.dataset.label;

    const { over, index, removing } = aim(live, point);
    if (over) {
      const targetSize = zones.get(over)!.geometry!.itemSize || live.sourceSize;
      live.body.style.setProperty("--rail-ghost-fit", (targetSize / live.sourceSize).toFixed(3));
    }
    showRemoval(live, removing);
    document.body.dataset.railDragOver = over ?? (removing ? "remove" : "none");
    if (state && (state.over !== over || state.index !== index || (state.removing === true) !== removing)) {
      emit({ ...state, over, index, removing });
    }
  });
}

/** The rail and insertion index under `point`, and whether a release there
 *  would take the icon off its rail instead. */
function aim(
  live: Session,
  point: { x: number; y: number },
): { over: RailZoneId | null; index: number; removing: boolean } {
  live.at = point;
  const over = targetZoneAt(point.x, point.y, live);
  let index = state?.index ?? 0;
  if (over) {
    const entry = zones.get(over)!;
    const geometry = entry.geometry!;
    const element = entry.element;
    const scrollDelta = element ? scrollOf(element, entry.spec.axis) - geometry.scroll : 0;
    index = insertionIndex(geometry.centers, (entry.spec.axis === "x" ? point.x : point.y) + scrollDelta);
  }
  return { over, index, removing: over === null && removalVerdict(live, point) };
}

// ---------------------------------------------------------------- removal

function canRemoveFrom(zoneId: RailZoneId, id: string): boolean {
  const spec = zones.get(zoneId)?.spec;
  return !!spec?.remove && (spec.canRemove?.(id) ?? true);
}

/** Distance from `point` to the nearest rail (a drag zone or a marked rail
 *  region); null when none is laid out, which can never justify removing. */
function railDistance(live: Session, point: { x: number; y: number }): number | null {
  const rects: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> = [];
  for (const entry of zones.values()) if (entry.geometry) rects.push(entry.geometry.rect);
  rects.push(...live.keepClear);
  let nearest = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    nearest = Math.min(nearest, distanceToRect(rect, point.x, point.y));
  }
  return Number.isFinite(nearest) ? nearest : null;
}

/** Would releasing at `point` take the icon off its rail? Only from a rail
 *  that can lose it, only with the pointer on screen (a pointer that left
 *  the window is a lost drag, not a decision), and only past
 *  REMOVE_DISTANCE_PX from every rail. */
function removalVerdict(live: Session, point: { x: number; y: number }): boolean {
  if (!canRemoveFrom(live.from, live.id)) return false;
  if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) return false;
  const distance = railDistance(live, point);
  return distance !== null && removalIntent(distance, state?.removing === true);
}

/** The ghost wears the verdict: translucent, with its "Remove" pill. */
function showRemoval(live: Session, removing: boolean): void {
  if (removing === (live.ghost.dataset.removing === "true")) return;
  if (removing) live.ghost.dataset.removing = "true";
  else delete live.ghost.dataset.removing;
  // A finger covers the ghost: the change of verdict is felt instead.
  if (live.touch) selectionFeedback();
}

const POOF_MS = 480;
const POOF_EASE = "cubic-bezier(0.18, 0.75, 0.3, 1)";
const POOF_RISE_PX = 8;
const DEGREES = Math.PI / 180;

interface Puff {
  /** Degrees clockwise from the +x axis the puff drifts toward. */
  angle: number;
  travel: number;
  size: number;
  /** Scale the puff has swollen to when it is gone. */
  grow: number;
  delay: number;
}

/** The cloud: a soft core and a fan of puffs around it. Fixed, not random,
 *  so every removal reads the same. */
const POOF_PUFFS: readonly Puff[] = [
  { angle: 0, travel: 0, size: 34, grow: 2.2, delay: 0 },
  { angle: -82, travel: 21, size: 22, grow: 2, delay: 10 },
  { angle: -24, travel: 25, size: 20, grow: 1.9, delay: 30 },
  { angle: 36, travel: 23, size: 24, grow: 2, delay: 0 },
  { angle: 98, travel: 24, size: 19, grow: 1.8, delay: 40 },
  { angle: 158, travel: 25, size: 23, grow: 2, delay: 15 },
  { angle: -140, travel: 22, size: 21, grow: 1.9, delay: 25 },
];

/** Take the ghost away in a puff of smoke: the icon swells and dissolves
 *  while the cloud blooms over it and drifts up. Under reduced motion the
 *  icon is simply gone. Everything it creates removes itself. */
function playPoof(ghost: HTMLElement, body: HTMLElement): void {
  if (motionIsReduced() || typeof ghost.animate !== "function") {
    ghost.remove();
    return;
  }
  const rect = ghost.getBoundingClientRect();
  const cloud = document.createElement("div");
  cloud.className = "rail-poof";
  cloud.setAttribute("aria-hidden", "true");
  Object.assign(cloud.style, { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height / 2}px` });
  let done = false;
  const clear = () => {
    if (done) return;
    done = true;
    ghost.remove();
    cloud.remove();
  };
  // Scheduled first, so nothing below can strand the ghost or the cloud: a
  // hidden page stops animations, and an animation call may throw.
  setTimeout(clear, POOF_MS + 160);
  const puffs: Animation[] = [];
  for (const puff of POOF_PUFFS) {
    const node = document.createElement("span");
    node.className = "rail-poof-puff";
    node.style.setProperty("--rail-puff-size", `${puff.size}px`);
    cloud.append(node);
    const dx = Math.cos(puff.angle * DEGREES) * puff.travel;
    const dy = Math.sin(puff.angle * DEGREES) * puff.travel;
    const at = (scale: number, progress: number) =>
      `translate(-50%, -50%) translate(${(dx * progress).toFixed(2)}px, ${(dy * progress - POOF_RISE_PX * progress).toFixed(2)}px) scale(${scale})`;
    const timing = { duration: POOF_MS - puff.delay, delay: puff.delay, fill: "both" } as const;
    // Two animations, because the two curves differ: a puff slows as it
    // swells (ease-out), but smoke holds its density and thins late.
    puffs.push(
      node.animate([{ transform: at(0.3, 0) }, { transform: at(puff.grow, 1) }], { ...timing, easing: POOF_EASE }),
      node.animate([
        { opacity: 0 },
        { opacity: 0.9, offset: 0.16 },
        { opacity: 0.6, offset: 0.55 },
        { opacity: 0 },
      ], { ...timing, easing: "linear" }),
    );
  }
  document.body.append(cloud);
  // No `from`: each animation starts at what the element shows right now.
  const dissolve = body.animate([{ scale: 1.35, opacity: 0 }], { duration: 170, easing: POOF_EASE, fill: "forwards" });
  ghost.querySelector<HTMLElement>(".rail-drag-ghost-label")
    ?.animate([{ opacity: 0 }], { duration: 90, easing: "linear", fill: "forwards" });

  const finished = (animation: Animation, then: () => void) => {
    animation.addEventListener("finish", then);
    animation.addEventListener("cancel", then);
  };
  finished(dissolve, () => ghost.remove());
  let pending = puffs.length;
  for (const animation of puffs) finished(animation, () => { pending -= 1; if (pending === 0) clear(); });
}

/** Release far from every rail: the icon leaves its rail for good. */
function vanish(current: Session, drag: RailDragState): void {
  const origin = zones.get(drag.from);
  // The neighbours closed over the hole while the icon was held out; any
  // difference between that preview and the real rail stays in motion.
  for (const zoneId of zones.keys()) snapshotZone(zoneId);
  session = null;
  delete document.body.dataset.railDragging;
  delete document.body.dataset.railDragOver;
  try {
    origin?.spec.remove?.(drag.id);
  } finally {
    state = null;
    for (const listener of [...listeners]) listener();
    for (const entry of zones.values()) entry.geometry = null;
    externalGeometry.clear();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => snapshots.clear());
    // The smoke is garnish: whatever the store did, the drag is over.
    try { playPoof(current.ghost, current.body); } catch { current.ghost.remove(); }
    if (current.touch) tapFeedback();
  }
}

function suppressNextClick(): void {
  const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

function landingElement(drag: RailDragState): HTMLElement | null {
  const zoneId = drag.over ?? drag.from;
  const element = zones.get(zoneId)?.element;
  if (!element) return null;
  return element.querySelector<HTMLElement>("[data-rail-slot]") ?? itemElement(element, drag.id);
}

function finish(drop: boolean): void {
  const current = session;
  const drag = state;
  if (!current || !drag || drag.phase !== "dragging") return;
  if (current.frame) cancelAnimationFrame(current.frame);
  current.frame = 0;
  current.cleanup();
  // Aim once more at release: a move still waiting for its frame, or a rail
  // that relocated under a resting pointer, decides where the icon lands.
  const point = current.pending ?? current.at;
  const aimed: RailDragState = !drop ? { ...drag, over: null, removing: false } : point ? { ...drag, ...aim(current, point) } : drag;
  if (aimed.removing && canRemoveFrom(aimed.from, aimed.id)) {
    vanish(current, aimed);
    return;
  }
  // Put back or landed: the icon is no longer leaving, whatever it was a frame ago.
  const resolved: RailDragState = { ...aimed, removing: false };
  delete current.ghost.dataset.removing;
  emit({ ...resolved, phase: "dropping" });

  const settle = () => {
    current.ghost.remove();
    session = null;
    delete document.body.dataset.railDragging;
    delete document.body.dataset.railDragOver;
    const target = resolved.over === null ? null : zones.get(resolved.over);
    if (target) {
      const order = finalOrder(target.spec.ids, resolved);
      const unchanged = resolved.over === resolved.from && order.every((id, index) => id === target.spec.ids[index]);
      // Snapshot before the commit so the swap from slot to real icon and
      // the source rail closing its gap stay in motion with the drop.
      for (const zoneId of zones.keys()) snapshotZone(zoneId);
      if (!unchanged) target.spec.commit(order, resolved.id);
    }
    state = null;
    for (const listener of [...listeners]) listener();
    for (const entry of zones.values()) entry.geometry = null;
    externalGeometry.clear();
    requestAnimationFrame(() => snapshots.clear());
  };

  const landing = landingElement({ ...resolved, phase: "dropping" });
  if (!landing || motionIsReduced() || typeof current.ghost.animate !== "function") {
    settle();
    return;
  }
  const to = restingRect(landing);
  const scale = to.width / current.origin.width || 1;
  current.body.classList.remove("is-lifted");
  current.body.style.setProperty("--rail-ghost-fit", "1");
  current.body.style.setProperty("--rail-ghost-tilt", "0deg");
  const animation = current.ghost.animate([
    { transform: current.ghost.style.transform || "none" },
    { transform: `translate3d(${to.left - current.origin.left}px, ${to.top - current.origin.top}px, 0) scale(${scale})` },
  ], { duration: LAND_MS, easing: SETTLE_EASE, fill: "forwards" });
  let settled = false;
  const once = () => { if (!settled) { settled = true; settle(); } };
  animation.addEventListener("finish", once);
  animation.addEventListener("cancel", once);
  setTimeout(once, LAND_MS + 120);
}

function lift(source: HTMLElement, zoneId: RailZoneId, id: string, pointerId: number, x: number, y: number, touch: boolean): void {
  const origin = source.getBoundingClientRect();
  for (const entry of zones.values()) entry.geometry = measureZone(entry, id);
  const from = zones.get(zoneId)?.geometry;
  // Only an icon its rail can lose gets the pill that says so.
  const { ghost, body } = makeGhost(source, origin, canRemoveFrom(zoneId, id) ? tr("raildrag.remove") : null);
  const onMove = (event: PointerEvent) => { if (event.pointerId === pointerId) track(event.clientX, event.clientY); };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    suppressNextClick();
    finish(true);
  };
  const onCancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextClick();
    finish(false);
  };
  const block = (event: Event) => { event.preventDefault(); };
  const onBlur = () => finish(false);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("touchmove", block, { passive: false });
  window.addEventListener("contextmenu", block);
  window.addEventListener("blur", onBlur);
  session = {
    id, from: zoneId, pointerId, ghost, body, origin,
    grabX: x - origin.left, grabY: y - origin.top, lastX: x, tilt: 0, frame: 0, pending: null, at: null,
    sourceSize: Math.max(origin.width, origin.height) || 1,
    touch,
    keepClear: [...document.querySelectorAll<HTMLElement>(RAIL_REGION_SELECTOR)].map((region) => region.getBoundingClientRect()),
    cleanup: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("touchmove", block);
      window.removeEventListener("contextmenu", block);
      window.removeEventListener("blur", onBlur);
    },
  };
  document.body.dataset.railDragging = "true";
  document.body.dataset.railDragOver = zoneId;
  if (touch) navigator.vibrate?.(8);
  const index = from ? insertionIndex(from.centers, zones.get(zoneId)!.spec.axis === "x" ? x : y) : 0;
  emit({ id, from: zoneId, over: zoneId, index, phase: "dragging" });
  // Next frame: the ghost rises (scale + shadow) from exactly where it sat.
  requestAnimationFrame(() => body.classList.add("is-lifted"));
}

function press(event: ReactPointerEvent<HTMLElement>, zoneId: RailZoneId, id: string): void {
  if (session || state || event.button !== 0 || event.ctrlKey || event.metaKey) return;
  const source = event.currentTarget;
  const pointerId = event.pointerId;
  const touch = event.pointerType === "touch";
  const startX = event.clientX;
  const startY = event.clientY;
  let timer = 0;
  const release = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
  };
  const begin = (x: number, y: number) => {
    release();
    if (!source.isConnected || session || state) return;
    lift(source, zoneId, id, pointerId, startX, startY, touch);
    track(x, y);
  };
  let lastX = startX;
  let lastY = startY;
  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    lastX = move.clientX;
    lastY = move.clientY;
    const distance = Math.hypot(lastX - startX, lastY - startY);
    if (touch) {
      if (distance > TOUCH_SLOP_PX) release();
      return;
    }
    if (distance >= DRAG_THRESHOLD_PX) begin(lastX, lastY);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  if (touch) timer = window.setTimeout(() => begin(lastX, lastY), TOUCH_LIFT_MS);
}

// ---------------------------------------------------------------- React seam

export interface RailDragZone {
  /** Callback ref for the element whose children are the launchers. */
  ref: (element: HTMLElement | null) => void;
  order: RailOrderEntry[];
  /** True while an icon hovers this rail as its drop target. */
  targeted: boolean;
  /** True while an icon from another rail could land here: render the rail
   *  even when it is empty, or it can never receive its first icon. */
  receiving: boolean;
  /** Spread onto a launcher button. */
  itemProps: (id: string) => {
    "data-rail-item": string;
    "data-rail-drag-source"?: "true";
    onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
  /** Spread onto the drop container. Empty when the zone accepts no
   *  external drag; a rail without it is a rail-to-rail target only. */
  dropProps: RailHtmlDropProps;
  slotKey: string;
}

export interface RailHtmlDropProps {
  onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave?: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLElement>) => void;
}

export function useRailDragZone(spec: RailZoneSpec): RailDragZone {
  const ref = useRef<HTMLElement | null>(null);
  const drag = useSyncExternalStore(subscribe, getRailDrag, () => null);
  const entry = zones.get(spec.id);
  if (entry) entry.spec = spec;
  else zones.set(spec.id, { spec, element: null, geometry: null });

  useLayoutEffect(() => {
    const element = ref.current;
    const own = zones.get(spec.id);
    if (own) own.element = element;
    return () => {
      const current = zones.get(spec.id);
      if (current && current.element === element) zones.delete(spec.id);
    };
  }, [spec.id]);

  // Every render may follow a preview change: play the pending FLIP, if any.
  useLayoutEffect(() => {
    const own = zones.get(spec.id);
    if (own && own.element !== ref.current) own.element = ref.current;
    flipZone(spec.id);
  });

  const move = (id: string, delta: -1 | 1) => {
    const ids = [...spec.ids];
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    ids.splice(at, 1);
    ids.splice(to, 0, id);
    for (const zoneId of zones.keys()) snapshotZone(zoneId);
    spec.commit(ids, id);
  };

  // An icon dragged in from OUTSIDE the rails (the Custom actions window):
  // the native drag supplies its own ghost, so this only tracks the rail
  // under the pointer and persists the drop through the same commit path.
  const carriesExternal = (event: ReactDragEvent<HTMLElement>): boolean =>
    !!spec.externalMime && !!event.dataTransfer?.types.includes(spec.externalMime);
  // The payload is only readable from `dragover` on (never in `dragstart`,
  // and never in Firefox before the drop), so the id is resolved here rather
  // than armed with the drag.
  const externalIdOf = (event: ReactDragEvent<HTMLElement>): string | null =>
    resolveExternalRailDrag(event.dataTransfer?.getData(spec.externalMime!) || null);
  const externalPoint = (event: ReactDragEvent<HTMLElement>): { over: RailZoneId; index: number } | null =>
    externalRailDropTarget(spec.id, spec.axis === "x" ? event.clientX : event.clientY);
  const dropProps: RailHtmlDropProps = spec.externalMime ? {
    onDragOver: (event) => {
      if (!carriesExternal(event)) return;
      const id = externalIdOf(event);
      const at = externalPoint(event);
      if (!id || !at) return;
      // Accept the drop only where this rail would really take the icon, so
      // the pointer shows "no" instead of landing an icon it cannot hold.
      if (!spec.accepts(id)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      externalRailDragOver(at.over, at.index);
    },
    onDragLeave: (event) => {
      if (!carriesExternal(event)) return;
      // Moving between the rail's own children is not leaving it.
      const to = event.relatedTarget as Node | null;
      if (to && event.currentTarget instanceof Node && event.currentTarget.contains(to)) return;
      externalRailDragOver(null);
    },
    onDrop: (event) => {
      if (!carriesExternal(event)) return;
      event.preventDefault();
      externalIdOf(event);
      const at = externalPoint(event) ?? { over: spec.id, index: spec.ids.length };
      endExternalRailDrag(at.over, at.index);
    },
    onDragEnd: () => endExternalRailDrag(),
  } : {};

  return {
    ref: (element) => { ref.current = element; },
    order: previewOrder(spec.ids, spec.id, drag),
    targeted: drag?.phase === "dragging" && drag.over === spec.id,
    receiving: drag !== null && drag.from !== spec.id
      // An external drag whose payload is not readable yet (Firefox, before
      // its first `dragover`) must still be able to land on an EMPTY rail,
      // or a rail hidden while empty could never receive its first icon.
      && (drag.from === EXTERNAL_RAIL_SOURCE && drag.id === "" ? true : spec.accepts(drag.id))
      && (zones.get(drag.from)?.spec.canLeave?.(drag.id) ?? true),
    slotKey: SLOT_KEY,
    dropProps,
    itemProps: (id) => {
      if (!spec.isDraggable(id)) return { "data-rail-item": id };
      return {
        "data-rail-item": id,
        ...(drag?.id === id && (drag.over === spec.id || (drag.over === null && drag.from === spec.id))
          ? { "data-rail-drag-source": "true" as const } : {}),
        onPointerDown: (event) => press(event, spec.id, id),
        // Alt+Arrow nudges the focused launcher one place along its rail.
        onKeyDown: (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey) return;
          const back = spec.axis === "x" ? "ArrowLeft" : "ArrowUp";
          const forward = spec.axis === "x" ? "ArrowRight" : "ArrowDown";
          if (event.key !== back && event.key !== forward) return;
          event.preventDefault();
          const target = event.currentTarget;
          move(id, event.key === back ? -1 : 1);
          requestAnimationFrame(() => {
            const zone = zones.get(spec.id)?.element;
            (zone ? itemElement(zone, id) : target)?.focus();
          });
        },
      };
    },
  };
}
