export interface TerminalGridMeasurement {
  w: number;
  h: number;
  cols: number;
  rows: number;
  viewportHeight: number;
}

/** Use layout pixels for both the viewport and glyphs, including on spawn. */
export function measureTerminalGrid(body: HTMLElement | null, probe: HTMLElement | null): TerminalGridMeasurement | undefined {
  if (!body || !probe || body.clientWidth <= 0 || body.clientHeight <= 0
    || probe.offsetWidth <= 0 || probe.offsetHeight <= 0) return;
  const w = probe.offsetWidth / 100;
  const h = probe.offsetHeight;
  const style = getComputedStyle(body);
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const cols = Math.floor((body.clientWidth - paddingX) / w);
  // A nearly collapsed window is not a useful PTY grid. Preserve the last
  // valid size until layout can measure at least eight columns again.
  if (cols < 8) return;
  return { w, h, cols, rows: Math.max(2, Math.floor((body.clientHeight - paddingY) / h)), viewportHeight: body.clientHeight };
}
