// The sandboxed frame a page runs in, shared by the chat block (PageBlock)
// and by a page shown full size somewhere else (PageSurface). The sandbox and
// the policy built by src/page.ts are the boundary; everything here is the
// host's side of the bridge.
import { useEffect, useRef, type CSSProperties } from "react";
import { DEFAULT_PAGE_THEME, PAGE_CHANNEL, PAGE_SANDBOX, pageThemeCss, type PageTheme } from "../src/page.ts";

/** A page that keeps leaving (a self-refresh loop) stops being remounted. */
export const MAX_RESETS = 3;
/** Grace for the bridge's "ready" to arrive after a load; the two are separate tasks. */
const READY_GRACE_MS = 400;
/** Per frame: documents the bridge announced, and how many loads used one up. */
const frameDocs = new WeakMap<HTMLIFrameElement, { readies: number; consumed: number }>();
export const docsOf = (frame: HTMLIFrameElement) => {
  let docs = frameDocs.get(frame);
  if (!docs) { docs = { readies: 0, consumed: 0 }; frameDocs.set(frame, docs); }
  return docs;
};
/** Host tokens the page may use, read from the live document. */
export function readPageTheme(): PageTheme {
  const root = typeof document === "undefined" ? null : document.documentElement;
  const compute = typeof getComputedStyle === "function" ? getComputedStyle : null;
  if (!root || !compute) return DEFAULT_PAGE_THEME;
  const style = compute(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const d = DEFAULT_PAGE_THEME;
  return {
    scheme: root.classList.contains("light") ? "light" : "dark",
    bg: read("--bg", d.bg),
    fg: read("--text", d.fg),
    muted: read("--muted", d.muted),
    accent: read("--accent", d.accent),
    border: read("--border", d.border),
    font: read("--ui-font-family", d.font),
    radius: read("--radius-card", d.radius),
  };
}

/** Post host theme changes into the running pages, so they restyle without
 *  reloading. */
export function usePageThemePush(frames: { readonly current: ReadonlySet<HTMLIFrameElement> }): void {
  // The root's inline style also carries non-theme variables that can change
  // per frame, so mutations coalesce to one read per animation frame and a
  // page hears only an actual theme change.
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    let lastCss = pageThemeCss(readPageTheme());
    let scheduled = false;
    const push = () => {
      scheduled = false;
      const css = pageThemeCss(readPageTheme());
      if (css === lastCss) return;
      lastCss = css;
      for (const frame of frames.current) frame.contentWindow?.postMessage({ channel: PAGE_CHANNEL, kind: "theme", css }, "*");
    };
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(push);
      else setTimeout(push, 16);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => { observer.disconnect(); scheduled = false; };
  }, [frames]);
}

export function PageIframe({ srcDoc, title, register, onNavigated, style, full, className = "chat-block-page-frame" }: {
  srcDoc: string;
  title: string;
  register(node: HTMLIFrameElement | null, previous: { current: HTMLIFrameElement | null }): void;
  onNavigated(): void;
  style: CSSProperties;
  full?: boolean;
  className?: string;
}) {
  const previous = useRef<HTMLIFrameElement | null>(null);
  const checks = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    for (const timer of checks.current) clearTimeout(timer);
    checks.current.clear();
  }, []);
  // Every load gets its own check, in order, and each check uses up at most
  // one announcement. A page that leaves right after it loaded (a meta
  // refresh, a redirect in its first script) produces two loads close
  // together: the first uses up the announcement, the second finds none.
  const onLoad = (event: { currentTarget: HTMLIFrameElement }) => {
    const docs = docsOf(event.currentTarget);
    // Before any announcement the load is the frame's first document (or an
    // initial blank one): it may only use up an announcement, never reset.
    const first = docs.readies === 0;
    const timer = setTimeout(() => {
      checks.current.delete(timer);
      if (docs.readies > docs.consumed) docs.consumed += 1;
      else if (!first) onNavigated();
    }, READY_GRACE_MS);
    checks.current.add(timer);
  };
  return (
    <iframe
      ref={(node) => register(node, previous)}
      className={className}
      title={title}
      sandbox={PAGE_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      loading="lazy"
      data-page-full={full ? "true" : undefined}
      onLoad={onLoad}
      style={style}
    />
  );
}
