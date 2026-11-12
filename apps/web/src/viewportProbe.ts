// TEMPORARY device diagnostic (2026-11-10): package windows vanish behind the
// chat in the iOS app while their own field holds the keyboard, and no engine
// here reproduces it. A three-finger tap toggles a read-only overlay with the
// geometry the layer rules depend on, so one device screenshot settles the
// cause. Native app only; remove together with its bootstrap call once the
// report is in (docs/dev/mobile-viewport.md, "Full-height layers").

const FLAG = "polyth.viewportProbe";
const LAYERS = ".railbar:has(> :is(.rail-fullscreen, .panel-sheet)), .rail-fullscreen, .panel-sheet, .module-view--main, .scrim.settings-scrim, .mobile-navigator";

let overlay: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const px = (value: number) => String(Math.round(value));

function layerLine(el: Element): string {
  const r = el.getBoundingClientRect();
  const c = getComputedStyle(el);
  const name = `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(/\s+/).slice(0, 2).join(".")}`;
  return `${name} rect=${px(r.top)}..${px(r.bottom)} pos=${c.position} top=${c.top} h=${c.height} pad=${c.paddingTop}/${c.paddingBottom}`
    + ` tf=${c.transform === "none" ? "-" : c.transform} vis=${c.visibility} op=${c.opacity} st=${(el as HTMLElement).scrollTop}`;
}

function snapshot(): string {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const vv = window.visualViewport;
  const lines = [
    `vv h=${px(vv?.height ?? 0)} off=${px(vv?.offsetTop ?? 0)} page=${px(vv?.pageTop ?? 0)} inner=${window.innerHeight} client=${root.clientHeight} scrollY=${px(window.scrollY)}`,
    `kb=${document.body.dataset.keyboard} src=${document.body.dataset.keyboardSource} frame=${root.dataset.keyboardFrame}`,
    `ftop=${css.getPropertyValue("--visual-frame-top")} fbot=${css.getPropertyValue("--visual-frame-bottom")} lfb=${css.getPropertyValue("--layer-frame-bottom")} inset=${css.getPropertyValue("--keyboard-inset")} vvh=${css.getPropertyValue("--visual-vh")}`,
  ];
  const rootEl = document.getElementById("root");
  if (rootEl) lines.push(`#root rect=${px(rootEl.getBoundingClientRect().top)}..${px(rootEl.getBoundingClientRect().bottom)}`);
  for (const el of Array.from(document.querySelectorAll(LAYERS)).slice(0, 4)) lines.push(layerLine(el));
  const active = document.activeElement as HTMLElement | null;
  lines.push(`active=${active ? `${active.tagName.toLowerCase()}.${String(active.className).split(/\s+/)[0]}` : "-"}`);
  const scrolled: string[] = [];
  for (let el = active; el; el = el.parentElement) {
    if (el.scrollTop || el.scrollLeft) scrolled.push(`${String(el.className).split(/\s+/)[0] || el.tagName.toLowerCase()}=${el.scrollTop}`);
  }
  lines.push(`scrolled=${scrolled.join(",") || "-"}`);
  return lines.join("\n");
}

function show(): void {
  if (overlay) return;
  overlay = document.createElement("pre");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "position:fixed;left:0;right:0;top:var(--safe-top,0px);z-index:2147483647;margin:0;padding:4px 6px;"
    + "font:9px/1.25 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;color:#fff;background:rgba(0,0,0,.78);pointer-events:none";
  document.documentElement.appendChild(overlay);
  const update = () => { if (overlay) overlay.textContent = snapshot(); };
  update();
  timer = setInterval(update, 250);
}

function hide(): void {
  if (timer) clearInterval(timer);
  timer = null;
  overlay?.remove();
  overlay = null;
}

export function startViewportProbe(): void {
  if (typeof window === "undefined") return;
  let enabled = false;
  try { enabled = localStorage.getItem(FLAG) === "1"; } catch { /* storage unavailable */ }
  if (enabled) show();
  window.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 3) return;
    enabled = !enabled;
    try { localStorage.setItem(FLAG, enabled ? "1" : "0"); } catch { /* storage unavailable */ }
    if (enabled) show(); else hide();
  }, { passive: true, capture: true });
}
