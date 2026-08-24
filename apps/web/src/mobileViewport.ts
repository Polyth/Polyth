// Visual-viewport plumbing for phone layouts. Publishes the VISUAL viewport
// height and the on-screen-keyboard overlap as CSS custom properties
// (--visual-vh / --keyboard-inset; styles.css carries the pre-JS fallbacks)
// and lets sheet-style overlays wait for the keyboard to retract before they
// measure themselves against the visible band.

export interface ViewportMetrics {
  /** Height of the visible band in px (0 when unknown, e.g. under tests). */
  height: number;
  width: number;
  /** How much of the layout viewport the keyboard covers, in px. */
  keyboardInset: number;
}

const visualViewportOrNull = (): VisualViewport | null =>
  typeof window === "undefined" ? null : window.visualViewport ?? null;

export function getViewportMetrics(): ViewportMetrics {
  const viewport = visualViewportOrNull();
  if (!viewport) {
    const hasWindow = typeof window !== "undefined";
    return {
      height: hasWindow ? window.innerHeight : 0,
      width: hasWindow ? window.innerWidth : 0,
      keyboardInset: 0,
    };
  }
  const keyboardInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  return { height: viewport.height, width: viewport.width, keyboardInset };
}

let started = false;

/** Boot hook: keeps --visual-vh and --keyboard-inset in sync with the visual
 * viewport so keyboard-aware CSS never lets the keyboard cover an active
 * control. Safe to call more than once and outside a browser. */
export function startMobileViewport(): void {
  if (started || typeof window === "undefined" || typeof document === "undefined") return;
  started = true;
  const root = document.documentElement;
  const publish = (): void => {
    const metrics = getViewportMetrics();
    if (metrics.height > 0) root.style.setProperty("--visual-vh", `${Math.round(metrics.height)}px`);
    root.style.setProperty("--keyboard-inset", `${Math.round(metrics.keyboardInset)}px`);
  };
  publish();
  const viewport = visualViewportOrNull();
  viewport?.addEventListener("resize", publish);
  viewport?.addEventListener("scroll", publish);
  window.addEventListener("resize", publish);
  window.addEventListener("orientationchange", publish);
}

/** Blurs the focused editable control and resolves once the on-screen
 * keyboard has retracted (or immediately when none is up), so sheets opened
 * right after measure the full visible band, not the keyboard-squeezed one. */
export function dismissKeyboard(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const active = document.activeElement;
  const editable = active instanceof HTMLElement
    && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
  if (!editable) return Promise.resolve();
  active.blur();
  const viewport = visualViewportOrNull();
  if (!viewport || getViewportMetrics().keyboardInset === 0) {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      viewport.removeEventListener("resize", finish);
      resolve();
    };
    viewport.addEventListener("resize", finish);
    // Some keyboards retract without a resize event; never leave callers hung.
    window.setTimeout(finish, 300);
  });
}
