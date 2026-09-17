// Shared sanitized Markdown renderer (WP4). One code path for chat bubbles,
// multirun/fusion output and file preview: parse (pure AST) → sanitize URLs →
// render. Rich leaves (mermaid/math/json tree/galleries) mount lazily.
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { tr } from "../i18n/index.ts";
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  Icon,
} from "../components/ui/index.ts";
import { highlight } from "../highlight.ts";
import { codeBlockOverflow } from "./codeBlock.ts";

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
      title={tr("markdown.render.openValueValue", { path: path, value: startLine ? ` at line ${startLine}` : "" })}
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
  if (resolved === null) return <code className="md-blocked" title={tr("markdown.render.blockedImageSource")}>{alt || src}</code>;
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

function readViewportHeight(): number {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--visual-vh").trim();
    if (raw.endsWith("px")) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  if (typeof window === "undefined") return 0;
  const visual = window.visualViewport?.height;
  if (typeof visual === "number" && visual > 0) return visual;
  return window.innerHeight > 0 ? window.innerHeight : 0;
}

function HighlightedPre({ lang, text }: { lang: string; text: string }) {
  const html = useMemo(() => highlight(text, lang), [lang, text]);
  return (
    <pre>
      <code
        className={lang ? `lang-${lang}` : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

function MdCodeFrame({
  text,
  children,
  className,
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsible, setCollapsible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const measure = () => {
      const viewportHeight = readViewportHeight();
      if (viewportHeight <= 0) {
        setCollapsible(false);
        return;
      }
      const next = codeBlockOverflow(body.scrollHeight, viewportHeight);
      setCollapsible(next.collapsible);
    };

    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(body);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [text]);

  return (
    <div
      className={[
        "md-code-block",
        className,
        collapsible ? "is-collapsible" : "",
        collapsed ? "is-collapsed" : "",
        collapsible && expanded ? "is-expanded" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="md-code-block-body" ref={bodyRef}>{children}</div>
      {collapsible && (
        <button
          type="button"
          className="md-code-block-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? tr("markdown.render.collapseCode") : tr("markdown.render.expandCode")}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon icon={expanded ? ChevronUpIcon : ChevronDownIcon} size="sm" />
        </button>
      )}
      <CopyButton text={text} />
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const prefs = getUiSettings();
  const [asTree, setAsTree] = useState(prefs.jsonTreeDefault !== "raw");
  if (lang === "mermaid") return <Mermaid code={text} />;
  const parsed = lang === "json" ? tryParseJson(text) : undefined;
  if (parsed !== undefined) {
    return (
      <MdCodeFrame text={text} className="json-block">
        <div className="json-block-bar">
          <Button size="sm" aria-pressed={asTree} onClick={() => setAsTree((v) => !v)}>
            {asTree ? tr("markdown.render.raw") : tr("markdown.render.tree")}
          </Button>
        </div>
        {asTree
          ? <JsonTree value={parsed} defaultDepth={prefs.jsonTreeDepth ?? 2} />
          : <HighlightedPre lang="json" text={text} />}
      </MdCodeFrame>
    );
  }
  return (
    <MdCodeFrame text={text}>
      <HighlightedPre lang={lang} text={text} />
    </MdCodeFrame>
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
