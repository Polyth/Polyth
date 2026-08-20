// Mermaid diagrams (WP4): lazy-loaded, strict security level, zoom controls
// and a fullscreen dialog. Render errors degrade to the diagram source.
import { useEffect, useId, useState } from "react";
import Dialog from "../components/a11y/Dialog.tsx";

type MermaidApi = {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi | null> | null = null;

// F15: diagram colors derive from the live theme tokens (base theme +
// themeVariables read from the CSS custom properties at render time).
function themeConfig(): Record<string, unknown> {
  const base: Record<string, unknown> = { startOnLoad: false, securityLevel: "strict", fontFamily: "inherit" };
  if (typeof document === "undefined") return { ...base, theme: "dark" };
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = !document.documentElement.classList.contains("light");
  return {
    ...base,
    theme: "base",
    themeVariables: {
      darkMode: dark,
      background: v("--panel", dark ? "#191816" : "#f1ede6"),
      primaryColor: v("--elevated", dark ? "#221f1c" : "#ffffff"),
      primaryTextColor: v("--text", dark ? "#f0eee8" : "#2a2620"),
      primaryBorderColor: v("--border", dark ? "#35322c" : "#d5cec1"),
      secondaryColor: v("--raised", dark ? "#2a2724" : "#f3efe8"),
      tertiaryColor: v("--sunken", dark ? "#0e0d0c" : "#e9e4da"),
      lineColor: v("--muted", "#9c9890"),
      textColor: v("--text", dark ? "#f0eee8" : "#2a2620"),
      mainBkg: v("--elevated", dark ? "#221f1c" : "#ffffff"),
      nodeBorder: v("--border", dark ? "#35322c" : "#d5cec1"),
      clusterBkg: v("--panel", dark ? "#191816" : "#f1ede6"),
      edgeLabelBackground: v("--panel", dark ? "#191816" : "#f1ede6"),
    },
  };
}

function loadMermaid(): Promise<MermaidApi | null> {
  mermaidPromise ??= import("mermaid")
    .then((m) => {
      const api = (m.default ?? m) as unknown as MermaidApi;
      api.initialize(themeConfig());
      return api;
    })
    .catch(() => null);
  return mermaidPromise;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function SvgPane({ svg, zoom }: { svg: string; zoom: number }) {
  return (
    <div className="mermaid-pane" style={{ overflow: "auto" }}>
      <div style={{ transform: `scale(${zoom})`, transformOrigin: "top left", width: "fit-content" }}
        dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

export default function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(2);
  const [full, setFull] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  // Re-render diagrams when the theme tokens change (F15).
  useEffect(() => {
    const bump = () => setThemeTick((t) => t + 1);
    window.addEventListener("polyth:theme", bump);
    return () => window.removeEventListener("polyth:theme", bump);
  }, []);

  useEffect(() => {
    let stale = false;
    setSvg(null);
    setError(null);
    void loadMermaid().then(async (api) => {
      if (stale) return;
      if (!api) { setError("diagram renderer unavailable"); return; }
      try {
        api.initialize(themeConfig());
        const out = await api.render(`mmd-${id}-${Date.now().toString(36)}`, code);
        if (!stale) setSvg(out.svg);
      } catch (err) {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => { stale = true; };
  }, [code, id, themeTick]);

  if (error !== null) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-note">Mermaid failed: {error}</div>
        <pre><code>{code}</code></pre>
      </div>
    );
  }
  if (svg === null) return <pre className="mermaid-loading"><code>{code}</code></pre>;

  const zoom = ZOOMS[zoomIdx] ?? 1;
  return (
    <div className="mermaid-wrap">
      <div className="mermaid-toolbar">
        <button className="small-btn" aria-label="Zoom out" disabled={zoomIdx === 0} onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}>−</button>
        <span className="mermaid-zoom">{Math.round(zoom * 100)}%</span>
        <button className="small-btn" aria-label="Zoom in" disabled={zoomIdx === ZOOMS.length - 1} onClick={() => setZoomIdx((i) => Math.min(ZOOMS.length - 1, i + 1))}>+</button>
        <button className="small-btn" onClick={() => setFull(true)}>Fullscreen</button>
      </div>
      <SvgPane svg={svg} zoom={zoom} />
      {full && (
        <Dialog title="Diagram" size="full" onClose={() => setFull(false)}>
          <div className="dialog-head">
            <span className="dialog-title">Diagram</span>
            <span className="header-spacer" />
            <button className="small-btn" aria-label="Zoom out" onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}>−</button>
            <button className="small-btn" aria-label="Zoom in" onClick={() => setZoomIdx((i) => Math.min(ZOOMS.length - 1, i + 1))}>+</button>
            <button className="small-btn" onClick={() => setFull(false)}>Close</button>
          </div>
          <SvgPane svg={svg} zoom={zoom} />
        </Dialog>
      )}
    </div>
  );
}
