// KaTeX wrapper (WP4): lazy-loaded, MathML output (no stylesheet dependency),
// and hard degradation to the raw TeX source when rendering fails.
import { useEffect, useState } from "react";

type Katex = { renderToString(tex: string, opts: Record<string, unknown>): string };
let katexPromise: Promise<Katex | null> | null = null;

function loadKatex(): Promise<Katex | null> {
  katexPromise ??= import("katex")
    .then((m) => (m.default ?? m) as unknown as Katex)
    .catch(() => null);
  return katexPromise;
}

export default function MathTex({ tex, block = false }: { tex: string; block?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    void loadKatex().then((katex) => {
      if (stale) return;
      if (!katex) { setFailed(true); return; }
      try {
        setHtml(katex.renderToString(tex, {
          displayMode: block,
          output: "mathml",
          throwOnError: true,
          strict: "ignore",
        }));
      } catch {
        setFailed(true);
      }
    });
    return () => { stale = true; };
  }, [tex, block]);

  if (failed) {
    // Degrade to source: the TeX stays legible and copyable.
    return block ? <pre className="math-src">{tex}</pre> : <code className="math-src">{tex}</code>;
  }
  if (html === null) return <span className="math-loading">{tex}</span>;
  const Tag = block ? "div" : "span";
  return <Tag className={block ? "math-block" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}
