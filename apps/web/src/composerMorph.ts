// The phone composer rests as a one-line row and engages into a card (editor,
// model chips, rail) when its editor takes focus — the same moment the
// software keyboard starts to slide. Rather than jumping between the two, the
// card's height eases from the size it had to the size it now has, on the
// keyboard's own curve (`--motion-keyboard`). While it morphs the root carries
// `data-composer-morph="engage" | "rest"` and CSS holds the content at the
// card's bottom edge, so Send and the rail stay put while the top edge rises
// or falls. Both ways the card lays out its engaged rows, and the editor is
// the one row that opens or closes (styles.css): the model line above it
// holds the top edge while the card has room for it, and is transparent
// otherwise. Resting, the row is presented once the card has shrunk to it.
// The controls the row and the rail share, and the editor's placeholder,
// travel between their two places with the card, so neither presentation
// moves anything. Reduced motion keeps the instant switch.
//
// An engaging card must be measured as it will settle: whatever sizes its
// rows for the engaged state runs first (Composer's editor auto-grow is a
// layout effect declared before this hook). Its rows then keep their size
// while the edge rises (styles.css), and should one still change on the way —
// the keyboard re-bands the shell, a late render resizes or adds a row — the
// morph re-aims at the new settled height instead of snapping to it at the end.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { KEYBOARD_RIDE_ANIMATION_ID } from "./keyboardMotion.ts";
import { keyboardMotion } from "./motionPresence.ts";

export const COMPOSER_MORPH_ATTRIBUTE = "data-composer-morph";

const cardOf = (root: HTMLElement | null): HTMLElement | null =>
  root?.querySelector<HTMLElement>(".composer-card") ?? null;

/** The card's laid-out rows: in-flow children, through `display: contents`. */
function cardRows(card: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(card.children)) {
    const style = getComputedStyle(child);
    if (style.display === "contents") rows.push(...cardRows(child));
    else if (style.display !== "none" && style.position !== "absolute" && style.position !== "fixed") rows.push(child);
  }
  return rows;
}

const px = (value: string): number => parseFloat(value) || 0;

/** Editor rows that stop clipping while their editor glides (glideEditor). */
const unclipped = new WeakSet<Element>();

/** The row an engaging card opens (styles.css: the editor may shrink, and
 *  clips its content, while the card is shorter than its rows). */
function isOpeningRow(row: Element, style = getComputedStyle(row)): boolean {
  return style.flexGrow === "0" && style.flexShrink !== "0" && (style.overflowY === "clip" || unclipped.has(row));
}

/** The vertical translation a computed transform applies. */
function translatedY(style: CSSStyleDeclaration): number {
  const values = /matrix(3d)?\(([^)]+)\)/.exec(style.transform)?.[2]?.split(",").map(Number) ?? [];
  const y = style.transform.startsWith("matrix3d") ? values[13] : values[5];
  return Number.isFinite(y) ? y! : 0;
}

/** An opening row's settled height: its content's, whatever its box is now. */
function openingRowHeight(row: Element, style: CSSStyleDeclaration): number {
  const top = row.getBoundingClientRect().top;
  let bottom = top + px(style.borderTopWidth) + px(style.paddingTop);
  for (const child of cardRows(row)) {
    const style = getComputedStyle(child);
    // Its laid-out bottom: the editor's own glide (below) moves its box.
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom - translatedY(style) + px(style.marginBottom));
  }
  return bottom - top + px(style.paddingBottom) + px(style.borderBottomWidth);
}

/** The height an engaging card settles at: its rows (they do not flex while it
 *  morphs, styles.css — the opening row counts at its content's size) plus
 *  its own padding and border. Null when nothing is laid out, or when a row
 *  can still flex — its box then says nothing about its settled size. */
function settledCardHeight(card: HTMLElement): number | null {
  const rows = cardRows(card);
  if (!rows.length) return null;
  let height = 0;
  for (const row of rows) {
    const style = getComputedStyle(row);
    const frozen = style.flexGrow === "0" && style.flexShrink === "0";
    if (!frozen && !isOpeningRow(row, style)) return null;
    height += (frozen ? row.getBoundingClientRect().height : openingRowHeight(row, style))
      + px(style.marginTop) + px(style.marginBottom);
  }
  const style = getComputedStyle(card);
  const gap = px(style.rowGap) * (rows.length - 1);
  const edges = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]
    .reduce((sum, value) => sum + px(value), 0);
  return height + gap + edges;
}

/** The rows above the opening row hold the card's top edge only while the
 *  card is tall enough for every row but the opening one; shorter, they are
 *  pushed above the edge (the content holds the bottom one) and would slide
 *  against it. Engaging, they stay transparent until they hold the edge, then
 *  fade in where they settle; resting, they fade out where they are while the
 *  editor closes under them, gone before the edge reaches them. The fade runs
 *  on the morph's own timing, its keyframe offsets in the morph's eased
 *  progress — the card's height — and carries the morph's id, so a reported
 *  keyboard curve re-times both alike (keyboardMotion.ts). */
function holdTopRows(
  card: HTMLElement,
  from: number,
  to: number,
  timing: KeyframeAnimationOptions,
  engaging: boolean,
  carried: Map<Element, Keyframe>,
) {
  const rows = cardRows(card);
  const opening = rows.findIndex((row) => isOpeningRow(row));
  if (opening <= 0) return null;
  const openingRow = rows[opening]!;
  const top = rows.slice(0, opening).filter((row) => typeof (row as HTMLElement).animate === "function") as HTMLElement[];
  // A morph cut short starts from the opacity the rows had: re-engaging
  // half-way through a rest used to blank the model line and fade it in anew.
  const start = Number(carried.get(top[0]!)?.opacity ?? (engaging ? 0 : 1));
  // Resting, the editor closes from the box it has now.
  const closing = engaging ? 0 : openingRow.getBoundingClientRect().height;
  const keyframes = (settled: number): Keyframe[] => {
    if (!engaging) {
      const shrink = from - settled;
      const gone = shrink > 0 ? Math.min(1, Math.max(0, closing / shrink)) : 1;
      return [{ opacity: start, offset: 0 }, { opacity: 0, offset: gone }, { opacity: 0, offset: 1 }];
    }
    const growth = settled - from;
    const held = growth > 0 ? Math.min(1, Math.max(0, 1 - openingRowHeight(openingRow, getComputedStyle(openingRow)) / growth)) : 0;
    return [{ opacity: start, offset: 0 }, { opacity: start, offset: held }, { opacity: 1, offset: 1 }];
  };
  const fades = top.map((row) => row.animate(keyframes(to), timing));
  return {
    /** Interrupted: remember the rows' opacity for the next morph. */
    carry() {
      for (const [index, fade] of fades.entries()) {
        if (fade.playState !== "finished") carried.set(top[index]!, { opacity: getComputedStyle(top[index]!).opacity });
      }
    },
    retarget(settled: number) {
      const next = keyframes(settled);
      for (const fade of fades) (fade.effect as KeyframeEffect | null)?.setKeyframes?.(next);
    },
    cancel() {
      for (const fade of fades) fade.cancel();
    },
  };
}

/** Call `retarget` whenever the engaging card's settled height moves away from
 *  `initial`: a row resizes, or a row comes or goes. Returns the disposer. */
function followSettledHeight(card: HTMLElement, initial: number, retarget: (height: number) => void): () => void {
  if (typeof ResizeObserver !== "function" || typeof getComputedStyle !== "function") return () => {};
  let target = initial;
  const check = () => {
    const settled = settledCardHeight(card);
    if (settled === null || Math.abs(settled - target) < 0.5) return;
    target = settled;
    retarget(settled);
  };
  // Re-aim on the next frame, outside resize-observer delivery: resizing the
  // card from inside it would leave the card's own observer (the hook's
  // height tracking) an undelivered notification, reported as an error.
  let pending: (() => void) | null = null;
  const schedule = () => {
    if (pending) return;
    const run = () => { pending = null; check(); };
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(run);
      pending = () => globalThis.cancelAnimationFrame?.(id);
    } else {
      const id = setTimeout(run, 16);
      pending = () => clearTimeout(id);
    }
  };
  // The rows, not the card: the card's own height is the animation's — and
  // so is the opening row's box, so what sizes it is watched instead.
  const rows = new ResizeObserver(schedule);
  const watch = () => {
    rows.disconnect();
    for (const row of cardRows(card)) {
      if (isOpeningRow(row)) for (const content of cardRows(row)) rows.observe(content);
      else rows.observe(row);
    }
  };
  watch();
  const added = typeof MutationObserver === "function"
    ? new MutationObserver(() => { watch(); schedule(); })
    : null;
  added?.observe(card, { childList: true });
  return () => {
    pending?.();
    pending = null;
    rows.disconnect();
    added?.disconnect();
  };
}

const ENGAGED_CLASS = "composer-expanded";
const RESTING_CLASS = "composer-collapsed";

/** Controls both the resting row and the engaged rail show (Add, the resting
 *  launcher, Send), and the launchers only the rail shows. */
const SHARED_CONTROLS = ".mobile-composer-cell[data-resting], .mobile-composer-primary";
const RAIL_ONLY_CONTROLS = ".mobile-composer-cell:not([data-resting])";

type Placements = Map<Element, { x: number; y: number }>;

/** Where the shared controls sit, from the card's bottom-left corner: the
 *  content holds the bottom edge while the card morphs (styles.css). */
function placements(card: HTMLElement): Placements {
  const box = card.getBoundingClientRect();
  const found: Placements = new Map();
  for (const control of Array.from(card.querySelectorAll(SHARED_CONTROLS))) {
    const rect = control.getBoundingClientRect();
    if (rect.width) found.set(control, { x: rect.left - box.left, y: rect.bottom - box.bottom });
  }
  return found;
}

/** The editor's first line — its left edge and middle — from the card's
 *  bottom-left corner: where its placeholder reads. */
type EditorLine = { editor: HTMLElement; x: number; y: number };
function editorLine(card: HTMLElement): EditorLine | null {
  const editor = card.querySelector<HTMLElement>(".composer-input > .composer-editor");
  const rect = editor?.getBoundingClientRect();
  if (!editor || !rect?.width) return null;
  const box = card.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const line = parseFloat(style.lineHeight) || px(style.fontSize) * 1.2;
  return { editor, x: rect.left + px(style.paddingLeft) - box.left, y: rect.top + px(style.paddingTop) + line / 2 - box.bottom };
}

type RestingLayout = { width: number; height: number; controls: Placements; line: EditorLine | null };

function measureLayout(card: HTMLElement): RestingLayout {
  const box = card.getBoundingClientRect();
  return { width: box.width, height: box.height, controls: placements(card), line: editorLine(card) };
}

/** The resting row's height, control placements and editor line. Recorded
 *  while the row is presented and settled (`known`), so engaging — the
 *  keyboard's first frame — measures nothing extra; otherwise (the card is a
 *  different width, or has not rested yet) measured while the card lays out
 *  its engaged rows: the root takes the resting class for one synchronous
 *  read, ~5ms on the composer's subtree. */
function restingLayout(root: HTMLElement, card: HTMLElement, known: RestingLayout | null): RestingLayout {
  const current = known
    && Math.abs(known.width - card.getBoundingClientRect().width) < 0.5
    && [...known.controls.keys()].every((control) => control.isConnected)
    && known.line?.editor.isConnected !== false;
  if (current) return known;
  const swap = root.classList.contains(ENGAGED_CLASS);
  if (swap) root.classList.replace(ENGAGED_CLASS, RESTING_CLASS);
  const layout = measureLayout(card);
  if (swap) root.classList.replace(RESTING_CLASS, ENGAGED_CLASS);
  return layout;
}

/** The editor as the card lays it out engaged, before the morph holds the
 *  card: its line, its row's height and the card's. */
function engagedEditor(card: HTMLElement) {
  const line = editorLine(card);
  const row = line?.editor.closest<HTMLElement>(".composer-input");
  return line && row ? { line, row, rowHeight: row.getBoundingClientRect().height, cardHeight: card.getBoundingClientRect().height } : null;
}

/** The editor's line (its placeholder) travels between the row's line and
 *  its engaged one with the card: resting, down into the row while the editor
 *  closes around it — clipped away with it, the row's own appeared ~200ms
 *  later in a card left empty — and engaging, up out of the row while the
 *  editor opens, where it used to vanish on the first frame and come back as
 *  the editor opened. The editor row stops clipping for it, and the transform
 *  undoes the row's opening or closing on keyframes sampled in the morph's
 *  eased progress. A morph cut short hands the editor's place to the next. */
function glideEditor(
  engaged: NonNullable<ReturnType<typeof engagedEditor>>,
  row: EditorLine | null,
  from: number,
  to: number,
  timing: KeyframeAnimationOptions,
  engaging: boolean,
  carried: Map<Element, Keyframe>,
) {
  const { line, row: box, rowHeight, cardHeight } = engaged;
  const editor = line.editor;
  const resumed = carried.get(editor);
  if (typeof editor.animate !== "function" || !row) return null;
  // How far the editor row, short of its engaged height, lowers the editor
  // (its content holds the row's top, which moves with the card's top edge).
  const closed = (height: number) => rowHeight - Math.min(rowHeight, Math.max(0, height - (cardHeight - rowHeight)));
  // The line travels straight from where it shows now — the row's line when
  // engaging; resting, the engaged line, lowered already if an engage was cut
  // short — to where it settles.
  const start = engaging ? row : { x: line.x, y: line.y + closed(from) };
  const end = engaging ? line : row;
  const at = (progress: number) => {
    const x = start.x + (end.x - start.x) * progress - line.x;
    const y = start.y + (end.y - start.y) * progress - (line.y + closed(from + (to - from) * progress));
    return `translate(${Math.round(x * 100) / 100}px, ${Math.round(y * 100) / 100}px)`;
  };
  const samples = 24;
  const keyframes: Keyframe[] = resumed
    ? [resumed, { transform: at(1) }]
    : Array.from({ length: samples + 1 }, (_, i) => ({ offset: i / samples, transform: at(i / samples) }));
  box.style.overflow = "visible";
  unclipped.add(box);
  const glide = editor.animate(keyframes, timing);
  return {
    carry() {
      if (glide.playState !== "finished") carried.set(editor, { transform: getComputedStyle(editor).transform });
    },
    cancel() {
      glide.cancel();
      box.style.removeProperty("overflow");
      unclipped.delete(box);
    },
  };
}

/** The rail's controls travel between their row and rail places with the
 *  card — engaging from the row's, resting to it — and the launchers only the
 *  rail shows fade with it, so presenting the row (or the rail) moves nothing:
 *  Send stood 17px further right in the row and jumped there. A morph cut
 *  short hands where each control is to the next one (`carried`). */
function glideControls(
  card: HTMLElement,
  row: Placements,
  timing: KeyframeAnimationOptions,
  engaging: boolean,
  carried: Map<Element, Keyframe>,
) {
  const glides = new Map<Element, Animation>();
  const glide = (control: Element, start: Keyframe, end: Keyframe) => {
    if (typeof (control as HTMLElement).animate !== "function") return;
    glides.set(control, (control as HTMLElement).animate([carried.get(control) ?? start, end], timing));
  };
  for (const [control, rail] of placements(card)) {
    const rowAt = row.get(control);
    if (!rowAt) continue;
    const dx = rowAt.x - rail.x;
    const dy = rowAt.y - rail.y;
    const offset = { transform: Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? "none" : `translate(${dx}px, ${dy}px)` };
    if (offset.transform === "none" && !carried.has(control)) continue;
    glide(control, engaging ? offset : { transform: "none" }, engaging ? { transform: "none" } : offset);
  }
  for (const control of Array.from(card.querySelectorAll(RAIL_ONLY_CONTROLS))) {
    glide(control, { opacity: engaging ? 0 : 1 }, { opacity: engaging ? 1 : 0 });
  }
  carried.clear();
  return {
    /** Interrupted: remember where each control is for the next morph. */
    carry() {
      for (const [control, animation] of glides) {
        if (animation.playState === "finished") continue;
        const style = getComputedStyle(control);
        carried.set(control, "opacity" in ((animation.effect as KeyframeEffect).getKeyframes()[0] ?? {})
          ? { opacity: style.opacity }
          : { transform: style.transform });
      }
    },
    cancel() {
      for (const animation of glides.values()) animation.cancel();
    },
  };
}

/**
 * Morphs the card between the resting row and the engaged card, and returns
 * whether the composer should present as engaged. Engaging presents the card
 * at once and grows it from the row's height. Resting is the mirror: the card
 * keeps its engaged rows while it shrinks to the row's height — the model line
 * fading out, the editor closing between it and the rail — and only then
 * presents as the row. Swapping first left the row floating in a tall, empty,
 * shrinking card, the model line and editor gone on the first frame.
 */
export function useComposerMorph(
  rootRef: RefObject<HTMLElement | null>,
  engaged: boolean,
  enabled: boolean,
): boolean {
  // The card's last settled height: the starting point of the next morph.
  const lastHeight = useRef(0);
  const generation = useRef(0);
  const morphing = useRef(false);
  const carried = useRef(new Map<Element, Keyframe>());
  const resting = useRef<RestingLayout | null>(null);
  // Resting, the engaged card stays presented until its morph ends (or is
  // found not to run). Derived in render, so the switch never paints the row.
  const [closing, setClosing] = useState(false);
  const [seen, setSeen] = useState(engaged);
  if (seen !== engaged) {
    setSeen(engaged);
    setClosing(!engaged && enabled);
  }

  useEffect(() => {
    const root = rootRef.current;
    const card = enabled ? cardOf(root) : null;
    if (!root || !card) return;
    const settled = () => {
      if (morphing.current) return;
      lastHeight.current = card.getBoundingClientRect().height;
      if (root.classList.contains(RESTING_CLASS)) resting.current = measureLayout(card);
    };
    settled();
    if (typeof ResizeObserver !== "function") return;
    // Typing, attachments and notices change the height between morphs.
    const observer = new ResizeObserver(settled);
    observer.observe(card);
    return () => observer.disconnect();
  }, [enabled, rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = enabled ? cardOf(root) : null;
    // No morph: present the row now. A layout effect's update re-renders
    // before the browser paints, so the engaged card never shows at rest.
    const rest = () => { if (!engaged) setClosing(false); };
    if (!root || !card) { rest(); return; }
    const from = lastHeight.current;
    const row = restingLayout(root, card, resting.current);
    const editor = engagedEditor(card);
    const to = engaged ? card.getBoundingClientRect().height : row.height;
    lastHeight.current = to;
    const { duration, easing } = keyboardMotion();
    if (!from || Math.abs(from - to) < 1 || duration === 0 || typeof card.animate !== "function") {
      carried.current.clear();
      rest();
      return;
    }
    const current = ++generation.current;
    morphing.current = true;
    root.setAttribute(COMPOSER_MORPH_ATTRIBUTE, engaged ? "engage" : "rest");
    // Tagged as a keyboard rider: once the native shell reports the
    // keyboard's real slide it is retimed to it (keyboardMotion.ts).
    const timing = { duration, easing, id: KEYBOARD_RIDE_ANIMATION_ID };
    const animation = card.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
    const held = holdTopRows(card, from, to, timing, engaged, carried.current);
    const travel = editor ? glideEditor(editor, row.line, from, to, timing, engaged, carried.current) : null;
    const glides = glideControls(card, row.controls, timing, engaged, carried.current);
    // A resting row is a fixed height; an engaged card settles at its rows.
    const unfollow = engaged
      ? followSettledHeight(card, to, (height) => {
        if (current !== generation.current) return;
        lastHeight.current = height;
        (animation.effect as KeyframeEffect | null)?.setKeyframes?.([{ height: `${from}px` }, { height: `${height}px` }]);
        held?.retarget(height);
      })
      : () => {};
    const settle = () => {
      if (current !== generation.current) return;
      unfollow();
      // The card has shrunk to the row: present the row within this frame —
      // a scheduled render would paint the engaged card at its full height
      // once the morph stops holding it.
      if (!engaged) flushSync(() => setClosing(false));
      held?.cancel();
      travel?.cancel();
      glides.cancel();
      morphing.current = false;
      root.removeAttribute(COMPOSER_MORPH_ATTRIBUTE);
      lastHeight.current = card.getBoundingClientRect().height;
      if (!engaged) resting.current = measureLayout(card);
    };
    animation.addEventListener("finish", settle);
    animation.addEventListener("cancel", settle);
    return () => {
      unfollow();
      if (current !== generation.current) return;
      // Interrupted mid-way: the next morph starts from where this one is now
      // (its keyframes still drive the height until cancelled), not its end.
      if (morphing.current) {
        lastHeight.current = card.getBoundingClientRect().height;
        held?.carry();
        travel?.carry();
        glides.carry();
      }
      // Retire this morph before cancelling, so its own cancel event can never
      // overwrite what the next one measures, and nothing outlives it if the
      // next switch does not morph at all.
      generation.current += 1;
      morphing.current = false;
      root.removeAttribute(COMPOSER_MORPH_ATTRIBUTE);
      held?.cancel();
      travel?.cancel();
      glides.cancel();
      animation.cancel();
    };
  // Only an engage/rest switch morphs; enabling on a layout change must not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged]);

  return engaged || closing;
}
