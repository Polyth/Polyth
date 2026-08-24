// Shared sanitized Markdown renderer (WP4). One code path for chat bubbles,
// multirun/fusion output and file preview: parse (pure AST) → sanitize URLs →
// render. Rich leaves (mermaid/math/json tree/galleries) mount lazily.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, parseInline, collectImages, type Block, type Inline } from "./parse.ts";
import { sanitizeLinkHref, sanitizeImageSrc } from "./sanitize.ts";
import { findFileRefs } from "./fileReference.ts";
import { getState, openEditorFile, useStore } from "../store.ts";
import { getUiSettings } from "../uiPrefs.ts";
import CopyButton from "../components/CopyButton.tsx";
import Mermaid from "./Mermaid.tsx";
import MathTex from "./MathTex.tsx";
import JsonTree, { tryParseJson } from "./JsonTree.tsx";
import GalleryLightbox, { type GalleryImage } from "./Gallery.tsx";

interface DocContextValue {
  images: GalleryImage[];
  openGallery(src: string): void;
  projectId: string | undefined;
}

const DocContext = createContext<DocContextValue>({ images: [], openGallery: () => {}, projectId: undefined });

// ---------------------------------------------------------------- inline

function FileRefLink({ text, path, startLine, endLine, column }: {
  text: string; path: string; startLine?: number; endLine?: number; column?: number;
}) {
  return (
    <button
      className="file-ref"
      title={`Open ${path}${startLine ? ` at line ${startLine}` : ""}`}
      onClick={() => openEditorFile(path, {
        path,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(column !== undefined ? { column } : {}),
      })}
    >
      {text}
    </button>
  );
}

/** Text (and code-span) runs get conservative file-reference linkification. */
function textWithRefs(text: string, keyBase: string, asCode: boolean): ReactNode[] {
  const segs = findFileRefs(text);
  return segs.map((s, i) => {
    if (s.kind === "ref") {
      return (
        <FileRefLink
          key={`${keyBase}-r${i}`}
          text={s.text}
          path={s.loc.path}
          {...(s.loc.startLine !== undefined ? { startLine: s.loc.startLine } : {})}
          {...(s.loc.endLine !== undefined ? { endLine: s.loc.endLine } : {})}
          {...(s.loc.column !== undefined ? { column: s.loc.column } : {})}
        />
      );
    }
    return asCode ? <code key={`${keyBase}-t${i}`}>{s.text}</code> : <span key={`${keyBase}-t${i}`}>{s.text}</span>;
  });
}

function InlineImage({ src, alt }: { src: string; alt: string }) {
  const ctx = useContext(DocContext);
  const resolved = sanitizeImageSrc(src, { ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}) });
  if (resolved === null) return <code className="md-blocked" title="blocked image source">{alt || src}</code>;
  return (
    <button className="md-img-btn" title={alt || src} onClick={() => ctx.openGallery(resolved)}>
      <img className="md-img" src={resolved} alt={alt} loading="lazy" />
    </button>
  );
}

export function renderInline(nodes: Inline[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    const k = `${keyBase}-${i}`;
    switch (n.kind) {
      case "text":
        out.push(...textWithRefs(n.text, k, false));
        break;
      case "code":
        out.push(...textWithRefs(n.text, k, true));
        break;
      case "strong":
        out.push(<strong key={k}>{renderInline(n.children, k)}</strong>);
        break;
      case "em":
        out.push(<em key={k}>{renderInline(n.children, k)}</em>);
        break;
      case "strike":
        out.push(<del key={k}>{renderInline(n.children, k)}</del>);
        break;
      case "link": {
        const href = sanitizeLinkHref(n.href);
        if (href === null) out.push(<span key={k}>{renderInline(n.children, k)}</span>);
        else out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{renderInline(n.children, k)}</a>);
        break;
      }
      case "image":
        out.push(<InlineImage key={k} src={n.src} alt={n.alt} />);
        break;
      case "math":
        out.push(<MathTex key={k} tex={n.tex} />);
        break;
    }
  });
  return out;
}

// ---------------------------------------------------------------- blocks

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const prefs = getUiSettings();
  const [asTree, setAsTree] = useState(prefs.jsonTreeDefault !== "raw");
  if (lang === "mermaid") return <Mermaid code={text} />;
  const parsed = lang === "json" ? tryParseJson(text) : undefined;
  if (parsed !== undefined) {
    return (
      <div className="copy-wrap json-block">
        <div className="json-block-bar">
          <button className="small-btn" aria-pressed={asTree} onClick={() => setAsTree((v) => !v)}>
            {asTree ? "Raw" : "Tree"}
          </button>
          <CopyButton text={text} />
        </div>
        {asTree
          ? <JsonTree value={parsed} defaultDepth={prefs.jsonTreeDepth ?? 2} />
          : <pre><code>{text}</code></pre>}
      </div>
    );
  }
  return (
    <div className="copy-wrap">
      <pre><code className={lang ? `lang-${lang}` : undefined}>{text}</code></pre>
      <CopyButton text={text} />
    </div>
  );
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

export function renderBlocks(blocks: Block[], keyBase: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${keyBase}-b${i}`;
    switch (b.kind) {
      case "heading": {
        const H = HEADING_TAGS[Math.min(Math.max(b.level, 1), 6) - 1]!;
        return <H key={k}>{renderInline(b.inline, k)}</H>;
      }
      case "para":
        return <p key={k} className="md-para">{renderInline(b.inline, k)}</p>;
      case "code":
        return <CodeBlock key={k} lang={b.lang} text={b.text} />;
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        const hasTasks = b.items.some((item) => item.checked !== undefined);
        return (
          <L key={k} className={hasTasks ? "md-task-list" : undefined}>
            {b.items.map((item, j) => (
              <li key={j} className={item.checked === undefined ? undefined : "md-task-item"}>
                {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? "Completed task" : "Incomplete task"} />}
                <span>{renderInline(item.inline, `${k}-i${j}`)}</span>
              </li>
            ))}
          </L>
        );
      }
      case "quote":
        return <blockquote key={k}>{renderBlocks(b.blocks, k)}</blockquote>;
      case "table":
        return (
          <table key={k} className="md-table">
            <thead>
              <tr>{b.header.map((c, j) => <th key={j}>{renderInline(c, `${k}-h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `${k}-r${ri}c${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        );
      case "hr":
        return <hr key={k} />;
      case "mathBlock":
        return <MathTex key={k} tex={b.tex} block />;
    }
  });
}

// ---------------------------------------------------------------- document

export function MarkdownDoc({ text, keyBase = "md" }: { text: string; keyBase?: string }) {
  const projectId = useStore((s) => s.activeProjectId) ?? undefined;
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const images = useMemo(() => {
    return collectImages(blocks)
      .map((im) => {
        const src = sanitizeImageSrc(im.src, { ...(projectId !== undefined ? { projectId } : {}) });
        return src === null ? null : { src, alt: im.alt };
      })
      .filter((x): x is GalleryImage => x !== null);
  }, [blocks, projectId]);
  const [galleryAt, setGalleryAt] = useState<number | null>(null);

  const ctx = useMemo<DocContextValue>(() => ({
    images,
    projectId,
    openGallery: (src: string) => {
      const at = images.findIndex((im) => im.src === src);
      setGalleryAt(at >= 0 ? at : 0);
    },
  }), [images, projectId]);

  return (
    <DocContext.Provider value={ctx}>
      {renderBlocks(blocks, keyBase)}
      {galleryAt !== null && images.length > 0 && (
        <GalleryLightbox images={images} start={galleryAt} onClose={() => setGalleryAt(null)} />
      )}
    </DocContext.Provider>
  );
}

/** Compatibility face for existing call sites: same signature as Markdown-lite. */
export function renderMarkdown(text: string, keyBase = "md"): ReactNode[] {
  return [<MarkdownDoc key={keyBase} text={text} keyBase={keyBase} />];
}

/** Escape hatch used by non-hook contexts. */
export function activeProjectId(): string | undefined {
  return getState().activeProjectId ?? undefined;
}
