// Mermaid diagrams (WP4): lazy-loaded, strict security level, zoom controls
// and a fullscreen dialog. Render errors degrade to the diagram source.
import { useEffect, useId, useState } from "react";
import Dialog from "../components/a11y/Dialog.tsx";

type MermaidApi = {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi | null> | null = null;

function loadMermaid(): Promise<MermaidApi | null> {
  mermaidPromise ??= import("mermaid")
    .then((m) => {
      const api = (m.default ?? m) as unknown as MermaidApi;
      api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "inherit" });
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

  useEffect(() => {
    let stale = false;
    setSvg(null);
    setError(null);
    void loadMermaid().then(async (api) => {
      if (stale) return;
      if (!api) { setError("diagram renderer unavailable"); return; }
      try {
        const out = await api.render(`mmd-${id}-${Date.now().toString(36)}`, code);
        if (!stale) setSvg(out.svg);
      } catch (err) {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => { stale = true; };
  }, [code, id]);

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
