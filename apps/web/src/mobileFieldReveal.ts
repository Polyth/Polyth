// Keep a focused text field inside its own scroll containers after the
// interaction frame changes under it (docs/dev/mobile-viewport.md).
//
// Safari reveals a focused field by panning the visual viewport inside the
// still-tall layout viewport. mobileViewport.css then shrinks the full-height
// layers to that band, so a field that was in view a moment ago can end up
// below the bottom of its now-shorter scroll container, clipped, with nothing
// left to bring it back: the pan already happened. A native-resize WebView
// reveals through its own layout pass and finds the field already visible, so
// this stays a no-op there.
//
// Only real vertical scroll containers (`overflow-y: auto | scroll`) move.
// `hidden` and `clip` boxes are layout clips, not scrollers: scrolling one would
// leave its content permanently shifted, which is the "shell slides off the
// top" failure this exists to avoid. Nothing here touches the document or the
// visual viewport.

/** Space kept between the field and the scroll container's edge. */
export const REVEAL_MARGIN = 8;

export function revealFieldInScrollers(field: Element | null | undefined): void {
  const doc = field?.ownerDocument;
  const view = doc?.defaultView;
  if (!field || !doc || !view) return;
  // body/html never scroll in the mobile shell; the loop stops at the body.
  for (let node = field.parentElement; node && node !== doc.body; node = node.parentElement) {
    const { overflowY } = view.getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (node.scrollHeight <= node.clientHeight) continue;
    // Re-read both rects per container: scrolling an inner one moves the field
    // before the next one out is considered.
    const box = field.getBoundingClientRect();
    const port = node.getBoundingClientRect();
    const top = port.top + node.clientTop + REVEAL_MARGIN;
    const bottom = port.top + node.clientTop + node.clientHeight - REVEAL_MARGIN;
    let delta = 0;
    // A field taller than the port pins its top edge so the caret line it
    // starts on stays visible.
    if (box.height > bottom - top || box.top < top) delta = box.top - top;
    else if (box.bottom > bottom) delta = box.bottom - bottom;
    if (delta !== 0) node.scrollTop += delta;
  }
}
