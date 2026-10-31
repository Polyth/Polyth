import type { ResourceRef } from "@polyth/web-sdk";
import ResourceLink from "../components/ResourceLink.tsx";
// Shared sanitized Markdown renderer. One code path for chat bubbles,
// multirun/fusion output and file preview: parse (pure AST) → sanitize URLs →
// render. Rich leaves (mermaid/math/json tree/galleries) mount lazily.
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseMarkdown, collectImages, holdBackStreamingTail, splitFrontmatter, type Block, type Inline, type TableAlign } from "./parse.ts";
import { sanitizeLinkHref, sanitizeImageSrc, isVideoSource } from "./sanitize.ts";
import { findFileRefs } from "./fileReference.ts";
import { getState, useStore } from "../store.ts";
import { getUiSettings } from "../uiPrefs.ts";
import CopyButton from "../components/CopyButton.tsx";
import Mermaid from "./Mermaid.tsx";
import MathTex from "./MathTex.tsx";
import JsonTree, { tryParseJson } from "./JsonTree.tsx";
import ImageLightbox, { type MarkdownImage } from "./ImageLightbox.tsx";
import { tr } from "../i18n/index.ts";
import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Icon,
  ImageIcon,
} from "../components/ui/index.ts";
import { highlight } from "../highlight.ts";
import { codeBlockOverflow } from "./codeBlock.ts";
import { renderFence, useMarkdownFenceRenderer } from "./fenceRenderers.ts";
import { useConversationReply } from "./conversationReplies.ts";

interface DocContextValue {
  images: MarkdownImage[];
  openGallery(src: string): void;
  projectId: string | undefined;
  sessionId?: string | null;
  repositoryId?: string | null;
  resourceContext?: Pick<ResourceRef, "projectId" | "sessionId" | "repositoryId">;
  /** An agent's answer in the conversation (see MarkdownFenceContext.conversation). */
  conversation?: boolean;
  /** The answer's message id (the document's keyBase): fences read the user
   *  reply that followed it (MarkdownFenceContext.reply). */
  messageId?: string;
}

const DocContext = createContext<DocContextValue>({ images: [], openGallery: () => {}, projectId: undefined });

// ---------------------------------------------------------------- inline

function FileRefLink({ text, path, startLine, endLine, column }: {
  text: string; path: string; startLine?: number; endLine?: number; column?: number;
}) {
  const context = useContext(DocContext).resourceContext;
  if (!context) return <code>{text}</code>;
  return <ResourceLink resource={{ ...context, scheme: "file", locator: path }}
    {...(startLine === undefined ? {} : { selection: { startLine, endLine: endLine ?? startLine, ...(column === undefined ? {} : { column }) } })}>{text}</ResourceLink>;
}

/** Text (and code-span) runs get conservative file-reference linkification.
 *  `linkify` is false inside a markdown link: that text is already inside an
 *  anchor, and a `.file-ref` button there is invalid nested interactive
 *  content that fires two actions (the link and the editor jump) on one tap. */
function textWithRefs(text: string, keyBase: string, asCode: boolean, linkify: boolean): ReactNode[] {
  if (!linkify) return [asCode ? <code key={`${keyBase}-t0`}>{text}</code> : text];
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
  const resolved = sanitizeImageSrc(src, {
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    sessionId: ctx.sessionId ?? ctx.resourceContext?.sessionId,
    repositoryId: ctx.repositoryId ?? ctx.resourceContext?.repositoryId,
  });
  if (resolved === null) return (
    <span className="md-blocked">
      {tr("markdown.render.blockedImageSource")}: {alt || src}
    </span>
  );
  // A video file behind the image syntax renders as a player; the URL policy
  // (and so the blocked-source text above) is exactly the image policy.
  if (isVideoSource(src)) return <video className="md-video" controls preload="metadata" playsInline src={resolved} />;
  return (
    <button className="md-img-btn" title={alt || src} onClick={() => ctx.openGallery(resolved)}>
      <img className="md-img" src={resolved} alt={alt} loading="lazy" />
    </button>
  );
}

export function renderInline(nodes: Inline[], keyBase: string, linkify = true): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    const k = `${keyBase}-${i}`;
    switch (n.kind) {
      case "text":
        out.push(...textWithRefs(n.text, k, false, linkify));
        break;
      case "code":
        out.push(...textWithRefs(n.text, k, true, linkify));
        break;
      case "strong":
        out.push(<strong key={k}>{renderInline(n.children, k, linkify)}</strong>);
        break;
      case "em":
        out.push(<em key={k}>{renderInline(n.children, k, linkify)}</em>);
        break;
      case "strike":
        out.push(<del key={k}>{renderInline(n.children, k, linkify)}</del>);
        break;
      case "link": {
        const href = sanitizeLinkHref(n.href);
        if (href === null) out.push(<span key={k}>{renderInline(n.children, k, false)}</span>);
        else out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{renderInline(n.children, k, false)}</a>);
        break;
      }
      case "image":
        out.push(<InlineImage key={k} src={n.src} alt={n.alt} />);
        break;
      case "math":
        out.push(<MathTex key={k} tex={n.tex} />);
        break;
      case "break":
        out.push(<br key={k} />);
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
  lang,
  text,
  children,
  className,
  headerAction,
}: {
  lang?: string;
  text: string;
  children: ReactNode;
  className?: string;
  headerAction?: ReactNode;
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

  const displayLang = lang ? lang.trim().toLowerCase() : "";

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
      <div className="md-code-block-header">
        <span className="md-code-block-lang">{displayLang}</span>
        <div className="md-code-block-actions">
          {headerAction}
          <CopyButton text={text} />
        </div>
      </div>
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
    </div>
  );
}

/** A fence some package renders (`host.markdown.registerFence`); the host's
 *  plain code frame stays available to it as `source`. */
function CodeBlock({ lang, text, info = "", closed = true, blockKey = "" }: { lang: string; text: string; info?: string; closed?: boolean; blockKey?: string }) {
  const doc = useContext(DocContext);
  const fence = useMarkdownFenceRenderer(lang);
  const reply = useConversationReply(fence && doc.conversation ? doc.messageId : undefined);
  if (fence) {
    // A model may put the view line on the opener (` ```ui steps Plan `). The
    // renderer owns the whole block, so those extra info tokens become its
    // first line. A language without a renderer keeps the host's plain frame
    // and drops them (CommonMark ignores the rest of the info string).
    const body = info ? (text ? `${info}\n${text}` : info) : text;
    const source = <PlainCodeBlock lang={lang} text={body} />;
    return renderFence(fence, {
      lang: lang.trim().toLowerCase(),
      text: body,
      info,
      closed,
      source,
      context: {
        blockKey,
        ...(doc.projectId ? { projectId: doc.projectId } : {}),
        ...(doc.resourceContext ? { sessionId: doc.resourceContext.sessionId ?? null } : {}),
        ...(doc.conversation ? { conversation: true } : {}),
        ...(reply !== undefined ? { reply } : {}),
      },
    });
  }
  return <PlainCodeBlock lang={lang} text={text} />;
}

function PlainCodeBlock({ lang, text }: { lang: string; text: string }) {
  const prefs = getUiSettings();
  const [asTree, setAsTree] = useState(prefs.jsonTreeDefault !== "raw");
  if (lang === "mermaid") return <Mermaid code={text} />;
  const parsed = lang === "json" ? tryParseJson(text) : undefined;
  if (parsed !== undefined) {
    return (
      <MdCodeFrame
        lang={lang}
        text={text}
        className="json-block"
        headerAction={
          <Button
            size="sm"
            variant="ghost"
            className="json-toggle-btn"
            aria-pressed={asTree}
            onClick={() => setAsTree((v) => !v)}
          >
            {asTree ? tr("markdown.render.raw") : tr("markdown.render.tree")}
          </Button>
        }
      >
        {asTree
          ? <JsonTree value={parsed} defaultDepth={prefs.jsonTreeDepth ?? 2} />
          : <HighlightedPre lang="json" text={text} />}
      </MdCodeFrame>
    );
  }
  return (
    <MdCodeFrame lang={lang} text={text}>
      <HighlightedPre lang={lang} text={text} />
    </MdCodeFrame>
  );
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** A paragraph that is exactly one bare http(s) autolink (the parser's
 *  `link` node whose text equals its href) to a video file. */
function bareVideoAutolink(inline: Inline[]): string | null {
  if (inline.length !== 1) return null;
  const node = inline[0]!;
  if (node.kind !== "link" || node.children.length !== 1) return null;
  const child = node.children[0]!;
  if (child.kind !== "text" || child.text !== node.href) return null;
  if (!/^https?:\/\//i.test(node.href) || !isVideoSource(node.href)) return null;
  return node.href;
}

/** A bare video URL paragraph: the player plus its small caption link. */
function VideoAutolink({ href }: { href: string }) {
  const ctx = useContext(DocContext);
  const resolved = sanitizeImageSrc(href, {
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    sessionId: ctx.sessionId ?? ctx.resourceContext?.sessionId,
    repositoryId: ctx.repositoryId ?? ctx.resourceContext?.repositoryId,
  });
  const safeHref = sanitizeLinkHref(href);
  if (resolved === null || safeHref === null) return <p className="md-para">{href}</p>;
  return (
    <p className="md-para md-video-autolink">
      <video className="md-video" controls preload="metadata" playsInline src={resolved} />
      <a className="md-video-caption" href={safeHref} target="_blank" rel="noopener noreferrer">{href}</a>
    </p>
  );
}

/** A GFM column alignment as a logical text alignment, so a mirrored
 *  (right-to-left) table keeps the author's intent. */
const ALIGN_STYLE = { left: "start", center: "center", right: "end" } as const;
function cellAlign(align: TableAlign | undefined): { style?: { textAlign: "start" | "center" | "end" } } {
  return align ? { style: { textAlign: ALIGN_STYLE[align] } } : {};
}

export function renderBlocks(blocks: Block[], keyBase: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${keyBase}-b${i}`;
    switch (b.kind) {
      case "heading": {
        const H = HEADING_TAGS[Math.min(Math.max(b.level, 1), 6) - 1]!;
        return <H key={k}>{renderInline(b.inline, k)}</H>;
      }
      case "para": {
        const video = bareVideoAutolink(b.inline);
        if (video) return <VideoAutolink key={k} href={video} />;
        return <p key={k} className="md-para">{renderInline(b.inline, k)}</p>;
      }
      case "code":
        return <CodeBlock key={k} lang={b.lang} text={b.text} info={b.info ?? ""} closed={b.closed} blockKey={k} />;
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        // Only a list made entirely of tasks drops its markers; in a mixed
        // list the plain items keep their bullet and a task's box hangs in
        // the marker gutter, so every item starts on one text edge.
        const allTasks = b.items.length > 0 && b.items.every((item) => item.checked !== undefined);
        return (
          <L key={k} className={allTasks ? "md-task-list" : undefined} {...(b.start !== undefined ? { start: b.start } : {})}>
            {b.items.map((item, j) => {
              const ik = `${k}-i${j}`;
              const content = (
                <>
                  {item.inline.length > 0 && <span className="md-li-text">{renderInline(item.inline, ik)}</span>}
                  {item.blocks && renderBlocks(item.blocks, ik)}
                </>
              );
              if (item.checked === undefined) return <li key={j}>{content}</li>;
              return (
                <li key={j} className="md-task-item">
                  <input type="checkbox" className="sr-only" checked={item.checked} disabled aria-label={item.checked ? tr("markdown.completedTask") : tr("markdown.incompleteTask")} />
                  <span className="md-task-box" data-checked={item.checked ? "true" : "false"} aria-hidden="true">
                    {item.checked && <Icon icon={CheckIcon} size="sm" />}
                  </span>
                  <div className="md-task-body">{content}</div>
                </li>
              );
            })}
          </L>
        );
      }
      case "quote":
        return <blockquote key={k} className="md-quote">{renderBlocks(b.blocks, k)}</blockquote>;
      case "table":
        // The table owns its own horizontal overflow: a narrow message column
        // (phone, split pane, enlarged text) scrolls the grid instead of
        // squeezing a cell until "Модель" breaks into one letter per line.
        return (
          <div key={k} className="md-table-scroll" role="region" tabIndex={0} aria-label={tr("markdown.table")}>
            <table className="md-table">
              <thead>
                <tr>{b.header.map((c, j) => <th key={j} {...cellAlign(b.align?.[j])}>{renderInline(c, `${k}-h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => <td key={ci} {...cellAlign(b.align?.[ci])}>{renderInline(c, `${k}-r${ri}c${ci}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={k} className="md-hr" />;
      case "mathBlock":
        return <MathTex key={k} tex={b.tex} block />;
    }
  });
}

// ---------------------------------------------------------------- document

export function MarkdownDoc({ text, keyBase = "md", showGalleryShortcut = false, streaming = false, frontmatter = false, conversation = false, resourceContext }: {
  text: string;
  keyBase?: string;
  showGalleryShortcut?: boolean;
  /** The text is a live prefix: withhold a trailing block whose type is still
   *  undecided (see holdBackStreamingTail) instead of flashing it as prose. */
  streaming?: boolean;
  /** Document mode: render leading YAML-ish frontmatter as a properties table
   *  instead of an <hr> and raw keys. Off by default so chat is unchanged. */
  frontmatter?: boolean;
  /** An agent's answer in the conversation: package fences may run there
   *  without a click. Off for every other surface. */
  conversation?: boolean;
  resourceContext?: DocContextValue["resourceContext"];
}) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const projectId = resourceContext?.projectId ?? activeProjectId ?? undefined;
  const sessionId = resourceContext ? resourceContext.sessionId ?? null : activeSessionId;
  const repositoryId = resourceContext?.repositoryId;
  const fm = useMemo(() => (frontmatter ? splitFrontmatter(text) : null), [text, frontmatter]);
  const parseSource = fm ? fm.body : text;
  const blocks = useMemo(() => parseMarkdown(streaming ? holdBackStreamingTail(parseSource) : parseSource), [parseSource, streaming]);
  const images = useMemo(() => {
    return collectImages(blocks)
      .map((im) => {
        const src = sanitizeImageSrc(im.src, {
          ...(projectId !== undefined ? { projectId } : {}),
          sessionId,
          repositoryId,
        });
        return src === null ? null : { src, alt: im.alt };
      })
      .filter((x): x is MarkdownImage => x !== null);
  }, [blocks, projectId, sessionId, repositoryId]);
  const [galleryAt, setGalleryAt] = useState<number | null>(null);

  const ctx = useMemo<DocContextValue>(() => ({
    images,
    projectId,
    sessionId,
    repositoryId,
    ...(projectId ? { resourceContext: { projectId, sessionId, ...(repositoryId ? { repositoryId } : {}) } } : {}),
    ...(conversation ? { conversation: true, messageId: keyBase } : {}),
    openGallery: (src: string) => {
      const at = images.findIndex((im) => im.src === src);
      setGalleryAt(at >= 0 ? at : 0);
    },
  }), [images, projectId, sessionId, repositoryId, conversation, keyBase]);

  return (
    <DocContext.Provider value={ctx}>
      {fm && fm.properties.length > 0 && (
        <table className="md-frontmatter">
          <caption className="sr-only">{tr("markdown.render.properties")}</caption>
          <tbody>
            {fm.properties.map((p, i) => (
              <tr key={i}>
                <th scope="row">{p.key}</th>
                <td>{p.value}</td>
              </tr>
            ))}
            {fm.dropped > 0 && (
              <tr className="md-frontmatter-more">
                <th scope="row" colSpan={2}>{tr("markdown.render.moreProperties", { count: fm.dropped })}</th>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {renderBlocks(blocks, keyBase)}
      {showGalleryShortcut && images.length > 0 && (
        <Button size="sm" variant="ghost" className="gallery-shortcut" iconStart={ImageIcon} onClick={() => setGalleryAt(0)}>
          {tr("timeline.openAnswerImages")}
        </Button>
      )}
      {galleryAt !== null && images.length > 0 && (
        <ImageLightbox images={images} start={galleryAt} onClose={() => setGalleryAt(null)} />
      )}
    </DocContext.Provider>
  );
}

/** Compatibility face for existing call sites: same signature as Markdown-lite. */
export function renderMarkdown(text: string, keyBase = "md", opts: { showGalleryShortcut?: boolean; streaming?: boolean; conversation?: boolean; resourceContext?: DocContextValue["resourceContext"] } = {}): ReactNode[] {
  return [<MarkdownDoc key={keyBase} text={text} keyBase={keyBase} {...(opts.resourceContext ? { resourceContext: opts.resourceContext } : {})} {...(opts.showGalleryShortcut ? { showGalleryShortcut: true } : {})} {...(opts.streaming ? { streaming: true } : {})} {...(opts.conversation ? { conversation: true } : {})} />];
}

/** Escape hatch used by non-hook contexts. */
export function activeProjectId(): string | undefined {
  return getState().activeProjectId ?? undefined;
}
