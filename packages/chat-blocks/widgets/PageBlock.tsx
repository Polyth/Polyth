// Host rendering of an agent's ```page fence: a self-contained HTML page in a
// sandboxed iframe (scripts only; no same-origin, navigation, popups, forms or
// modals) under a strict policy built by src/page.ts. The page can resize
// itself and offer a reply with polyth.send(text); the host shows that reply
// as a pending row and only the user's click sends it.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MarkdownFenceRendererProps, WebPackageHost } from "@polyth/web-sdk";
import { Button, CheckIcon, CodeIcon, Dialog, DownloadIcon, ExpandIcon, IconButton, Notice } from "../../../apps/web/src/components/ui/index.ts";
import {
  DEFAULT_PAGE_THEME,
  PAGE_CHANNEL,
  PAGE_MAX_FILE_BYTES,
  PAGE_MAX_INLINE_BYTES,
  PAGE_MIN_HEIGHT,
  PAGE_SANDBOX,
  buildPageDocument,
  pageByteLength,
  pageFileName,
  pageThemeCss,
  parsePageFence,
  parsePageMessage,
  type PageTheme,
} from "../src/page.ts";
import { chatBlockStrings, fill, type ChatBlockStrings } from "./strings.ts";
import { readProjectFile } from "./useBlockRecords.ts";

const SEND_GAP_MS = 300;
/** A page that keeps leaving (a self-refresh loop) stops being remounted. */
const MAX_RESETS = 3;
/** Grace for the bridge's "ready" to arrive after a load; the two are separate tasks. */
const READY_GRACE_MS = 400;
/** Per frame: documents the bridge announced, and how many loads used one up. */
const frameDocs = new WeakMap<HTMLIFrameElement, { readies: number; consumed: number }>();
const docsOf = (frame: HTMLIFrameElement) => {
  let docs = frameDocs.get(frame);
  if (!docs) { docs = { readies: 0, consumed: 0 }; frameDocs.set(frame, docs); }
  return docs;
};
const sentPages = new Map<string, string>();

export interface PageBlockProps extends MarkdownFenceRendererProps {
  host: Pick<WebPackageHost, "conversation" | "ui">;
}

type FileState =
  | { status: "idle" | "loading" }
  | { status: "ready"; html: string }
  | { status: "error"; error: "no-project" | "not-found" | "too-large" | "unavailable" };

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

function useProjectHtml(path: string | undefined, projectId: string | undefined, sessionId: string | null | undefined, enabled: boolean): FileState {
  const [state, setState] = useState<FileState>({ status: "idle" });
  useEffect(() => {
    if (!path || !enabled) { setState({ status: "idle" }); return; }
    if (!projectId) { setState({ status: "error", error: "no-project" }); return; }
    let live = true;
    setState({ status: "loading" });
    void readProjectFile(path, projectId, sessionId).then((read) => {
      if (!live) return;
      if ("error" in read) { setState({ status: "error", error: read.error }); return; }
      const html = read.file.content ?? "";
      const big = read.file.tooLarge || read.file.truncated || pageByteLength(html) > PAGE_MAX_FILE_BYTES;
      setState(big ? { status: "error", error: "too-large" } : { status: "ready", html });
    });
    return () => { live = false; };
  }, [path, projectId, sessionId, enabled]);
  return state;
}

export default function PageBlock({ text, info, closed, context, host }: PageBlockProps): ReactNode {
  const t = chatBlockStrings(host.ui.locale.get());
  const fence = useMemo(() => parsePageFence(text, info), [text, info]);
  const file = useProjectHtml(fence.from, context.projectId, context.sessionId, closed);
  const title = fence.title || t.page;
  const frameProps = { section: "chat-block chat-block--page", label: title };

  if (!closed) {
    return (
      <section className={frameProps.section} aria-busy="true" aria-label={t.pageDrawing}>
        <header className="chat-block-head"><span className="chat-block-title">{title}</span></header>
        <div className="chat-block-pending chat-block-page-drawing" role="status">{t.pageDrawing}</div>
      </section>
    );
  }
  let html: string | null = null;
  let notice: string | null = null;
  if (fence.badFrom !== undefined) notice = fill(t.pageBadPath, { path: fence.badFrom });
  else if (fence.from) {
    if (file.status === "ready") html = file.html;
    else if (file.status === "error") {
      notice = file.error === "too-large" ? t.pageTooLarge
        : file.error === "no-project" ? fill(t.fileNoProject, { path: fence.from })
        : file.error === "not-found" ? fill(t.fileNotFound, { path: fence.from })
        : fill(t.fileUnavailable, { path: fence.from });
    }
  } else if (pageByteLength(fence.body) > PAGE_MAX_INLINE_BYTES) notice = t.pageTooLarge;
  else html = fence.body;

  if (notice) {
    return (
      <section className={frameProps.section} aria-label={title}>
        <header className="chat-block-head"><span className="chat-block-title">{title}</span></header>
        <Notice tone="warning">{notice}</Notice>
      </section>
    );
  }
  if (html === null) {
    return (
      <section className={frameProps.section} aria-busy="true" aria-label={title}>
        <header className="chat-block-head"><span className="chat-block-title">{title}</span></header>
        <div className="chat-block-pending chat-block-page-drawing" role="status">{t.pageDrawing}</div>
      </section>
    );
  }
  return <PageFrame html={html} title={title} t={t} host={host} blockKey={context.blockKey} sessionId={context.sessionId} conversation={context.conversation === true} />;
}

function PageFrame({ html, title, t, host, blockKey, sessionId, conversation }: {
  html: string;
  title: string;
  t: ChatBlockStrings;
  host: PageHostAlias;
  blockKey: string;
  sessionId: string | null | undefined;
  /** An agent's answer in this chat. Anywhere else (a file, an issue, a
   *  prompt) the page is someone else's code and waits for a click. */
  conversation: boolean;
}) {
  const [armed, setArmed] = useState(conversation);
  const [asSource, setAsSource] = useState(false);
  const [dialogFull, setDialogFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(160);
  const [pending, setPending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(() => sentPages.get(blockKey) ?? null);
  const [sending, setSending] = useState(false);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [generation, setGeneration] = useState(0);
  const [wasReset, setWasReset] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const frames = useRef(new Set<HTMLIFrameElement>());
  const lastAccepted = useRef(0);
  const fullButton = useRef<HTMLElement | null>(null);

  // The theme is read once for the document; later changes are posted into the
  // running page so it never reloads.
  const srcDoc = useMemo(() => buildPageDocument(html, readPageTheme()), [html]);

  // The Fullscreen API keeps the same iframe running, so the page keeps its
  // state; the Dialog fallback (no API, e.g. iPhone Safari) mounts a second
  // iframe. Support is read once per render pass.
  const supportsFullscreen = typeof document !== "undefined" && document.fullscreenEnabled === true;

  const exitFullscreen = useCallback(() => {
    if (typeof document === "undefined" || !document.fullscreenElement) return;
    void Promise.resolve(document.exitFullscreen()).catch(() => {});
  }, []);

  // Sync from the real fullscreen state so Escape (and any other native exit)
  // clears the toggle. Exiting on unmount leaves no orphan fullscreen element.
  useEffect(() => {
    if (!supportsFullscreen || typeof document === "undefined") return;
    const section = sectionRef.current;
    const onChange = () => setExpanded(document.fullscreenElement !== null && document.fullscreenElement === section);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === section && typeof document.exitFullscreen === "function") void Promise.resolve(document.exitFullscreen()).catch(() => {});
    };
  }, [supportsFullscreen]);

  useEffect(() => {
    if (near) return;
    const node = sectionRef.current;
    if (!node || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "400px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const source = event.source;
      let from: HTMLIFrameElement | null = null;
      for (const frame of frames.current) if (frame.contentWindow !== null && frame.contentWindow === source) from = frame;
      if (!from) return;
      const message = parsePageMessage(event.data);
      if (!message) return;
      if (message.kind === "ready") { docsOf(from).readies += 1; return; }
      if (message.kind === "height") {
        if (from.dataset.pageFull !== "true") setHeight(message.value);
        return;
      }
      const now = Date.now();
      if (now - lastAccepted.current < SEND_GAP_MS) return;
      lastAccepted.current = now;
      setPending(message.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
  }, []);

  // A sandboxed page may still navigate its own frame (a link, a meta refresh,
  // `location.href`). Every document built here announces itself through the
  // bridge before it finishes loading, so a load with no announcement is a
  // foreign document and the frame is put back on its own. This is a UX
  // guard; the policy and the sandbox are the security boundary.
  const navigated = useCallback(() => {
    setGeneration((value) => value + 1);
    setWasReset(true);
  }, []);

  const register = useCallback((node: HTMLIFrameElement | null, previous: { current: HTMLIFrameElement | null }) => {
    if (previous.current) frames.current.delete(previous.current);
    previous.current = node;
    if (node) frames.current.add(node);
  }, []);

  const deliver = async (message: string) => {
    if (!sessionId) { host.conversation.insert(message); setPending(null); return; }
    setSending(true);
    let ok = false;
    try { ok = await host.conversation.send(sessionId, message); } catch { ok = false; } finally { setSending(false); }
    if (!ok) { host.conversation.insert(message); setPending(null); return; }
    sentPages.delete(blockKey);
    sentPages.set(blockKey, message);
    setSent(message);
    setPending(null);
  };

  const download = () => {
    const doc = /^\s*<!doctype/i.test(html) ? html : `<!doctype html><meta charset=utf-8>${html}`;
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = pageFileName(title);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleFullscreen = (event: { currentTarget: HTMLElement }) => {
    fullButton.current = event.currentTarget;
    const section = sectionRef.current;
    if (expanded) {
      if (dialogFull) setDialogFull(false);
      exitFullscreen();
      return;
    }
    setArmed(true);
    // Native full screen keeps this iframe; the Dialog is the no-API fallback.
    if (supportsFullscreen && section && typeof section.requestFullscreen === "function") {
      void Promise.resolve(section.requestFullscreen()).catch(() => { setDialogFull(true); });
      return;
    }
    setDialogFull(true);
  };

  const pendingRow = pending !== null && (
    <div className="chat-block-page-pending" role="status">
      <span className="chat-block-page-pending-text" title={t.pageSendHint}>{fill(t.pageSendPrompt, { text: pending })}</span>
      <Button size="sm" variant="quiet" onClick={() => setPending(null)}>{t.pageDismiss}</Button>
      <Button size="sm" variant="primary" disabled={sending} busy={sending} onClick={() => { void deliver(pending); }}>{t.send}</Button>
    </div>
  );

  return (
    <section ref={sectionRef} className="chat-block chat-block--page" aria-label={title}>
      <header className="chat-block-head">
        <span className="chat-block-title">{title}</span>
        <div className="chat-block-tools">
          <IconButton icon={ExpandIcon} label={expanded || dialogFull ? t.pageClose : t.pageFullScreen} size="sm" pressed={expanded} onClick={toggleFullscreen} />
          <IconButton icon={DownloadIcon} label={t.pageDownload} size="sm" onClick={download} />
          <IconButton icon={CodeIcon} label={asSource ? t.pageRender : t.pageSource} size="sm" pressed={asSource} onClick={() => setAsSource(!asSource)} />
        </div>
      </header>
      {asSource ? (
        <pre className="chat-block-page-source"><code>{html}</code></pre>
      ) : !armed ? (
        <div className="chat-block-page-gate">
          <p className="chat-block-sub">{t.pageExternal}</p>
          <Button size="sm" variant="primary" onClick={() => setArmed(true)}>{t.pageRun}</Button>
        </div>
      ) : near && generation < MAX_RESETS ? (
        <PageIframe key={generation} srcDoc={srcDoc} title={title} register={register} onNavigated={navigated} full={expanded} style={{ blockSize: expanded ? "100%" : `${Math.max(PAGE_MIN_HEIGHT, height)}px` }} />
      ) : (
        <div className="chat-block-pending chat-block-page-drawing" style={{ blockSize: `${height}px` }} />
      )}
      {wasReset && <Notice tone="warning">{t.pageReset}</Notice>}
      {pendingRow}
      {sent && !pending && (
        <p className="chat-block-sub chat-block-page-sent">
          <CheckIcon strokeWidth={2.5} aria-hidden="true" /> {fill(t.pageSentNote, { text: sent })}
        </p>
      )}
      {dialogFull && armed && generation < MAX_RESETS && (
        <Dialog
          title={title}
          size="full"
          className="chat-block-page-dialog"
          onClose={() => setDialogFull(false)}
          resolveRestoreFocus={() => fullButton.current}
          footer={pendingRow || undefined}
        >
          <PageIframe key={generation} srcDoc={srcDoc} title={title} register={register} onNavigated={navigated} full style={{ blockSize: "100%" }} />
        </Dialog>
      )}
    </section>
  );
}

type PageHostAlias = Pick<WebPackageHost, "conversation" | "ui">;

function PageIframe({ srcDoc, title, register, onNavigated, style, full }: {
  srcDoc: string;
  title: string;
  register(node: HTMLIFrameElement | null, previous: { current: HTMLIFrameElement | null }): void;
  onNavigated(): void;
  style: CSSProperties;
  full?: boolean;
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
      className="chat-block-page-frame"
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
