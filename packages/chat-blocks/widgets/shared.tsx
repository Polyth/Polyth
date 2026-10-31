// Pieces every view shares: the block head and its tools, the selection
// mark, media with a monogram fallback, the problems panel and the Markdown
// URL policy.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { MarkdownFenceContext, WebPackageHost } from "@polyth/web-sdk";
import { Button, CheckIcon, CodeIcon, IconButton, RefreshIcon, WarningIcon } from "../../../apps/web/src/components/ui/index.ts";
import type { ChatBlockProblem } from "../src/parse.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { sanitizeImageSrc, sanitizeLinkHref } from "../../../apps/web/src/markdown.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";

export interface BlockTools {
  markdown: string;
  t: ChatBlockStrings;
  toggleText(): void;
  /** Present for `from=` blocks: re-read the file. */
  reload?: () => void;
}

// The head is drawn by each view (it owns view-specific tools such as the
// table filter); the shared tools come from this context.
export const ToolsContext = createContext<BlockTools | null>(null);

export function BlockHead({ title, count, children }: { title: string; count?: string | undefined; children?: ReactNode }) {
  const tools = useContext(ToolsContext)!;
  return (
    <header className="chat-block-head">
      {title && <span className="chat-block-title">{title}</span>}
      {count && <span className="chat-block-count">{count}</span>}
      <div className="chat-block-tools">
        {children}
        {tools.reload && <IconButton icon={RefreshIcon} label={tools.t.reload} size="sm" onClick={tools.reload} />}
        <IconButton icon={CodeIcon} label={tools.t.showText} size="sm" onClick={tools.toggleText} />
        <CopyButton text={tools.markdown} label={tools.t.copy} />
      </div>
    </header>
  );
}

/** A value short enough to sit on one line beside the title (a price, a
 *  size, a rating). Anything longer is running text and wraps in the body. */
export const isCompactValue = (value: string): boolean => [...value.trim()].length <= 18;

export function Mark() {
  return <span className="chat-block-mark" aria-hidden="true"><CheckIcon strokeWidth={2.5} /></span>;
}

/** Image URL under the Markdown policy. Project-relative paths resolve in the
 *  block's own session checkout (an isolated worktree has its own files). */
export function imageUrl(
  src: string | undefined,
  context: Pick<MarkdownFenceContext, "projectId" | "sessionId"> & { repositoryId?: string | null },
): string | null {
  if (!src) return null;
  return sanitizeImageSrc(src, {
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    sessionId: context.sessionId,
    repositoryId: context.repositoryId,
  });
}

export const resolveSafeMediaSrc = imageUrl;

export const safeLink = (link: string | undefined): string | null => {
  if (!link) return null;
  const href = sanitizeLinkHref(link);
  return href && /^(https?:|mailto:)/i.test(href) ? href : null;
};

// An http(s) URL in running text, without the sentence punctuation after it.
const INLINE_URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}»]/gi;

/** Running cell text: `code` spans and http(s) URLs become code and links;
 *  everything else stays literal. A URL shows without its scheme. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={i}>{part.slice(1, -1)}</code>);
      return;
    }
    let last = 0;
    for (const m of part.matchAll(INLINE_URL_RE)) {
      const href = safeLink(m[0]);
      if (!href) continue;
      if (m.index > last) out.push(part.slice(last, m.index));
      out.push(
        <a key={`${i}-${m.index}`} className="chat-block-inline-link" href={href} target="_blank" rel="noopener noreferrer" title={m[0]}>
          {m[0].replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "")}
        </a>,
      );
      last = m.index + m[0].length;
    }
    if (last < part.length) out.push(part.slice(last));
  });
  return <>{out}</>;
}

function initials(title: string): string {
  const letters = title.trim().split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase();
}

export function Media({ src, title, className }: { src: string | null; title: string; className?: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <div className={`chat-block-media${className ? ` ${className}` : ""}`}>
      {src && state !== "failed" && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={state === "loaded" ? "is-loaded" : undefined}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
      <span className="chat-block-monogram" aria-hidden="true">{initials(title)}</span>
    </div>
  );
}

export function mediaRatio(value: string | undefined): string | null {
  const m = value ? /^(\d{1,2})[:/x](\d{1,2})$/.exec(value) : null;
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? `${m[1]} / ${m[2]}` : null;
}

const formatters = new Map<string, Intl.NumberFormat>();
/** Locale number with up to two decimals; `unit` is appended as written. */
export function formatNumber(value: number, locale: string, unit?: string): string {
  let format = formatters.get(locale);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    } catch {
      format = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
    }
    formatters.set(locale, format);
  }
  const text = format.format(value);
  if (!unit) return text;
  return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/** How many of a long collection to show, growing by `step` on request. */
export function usePaging(total: number, first: number, step: number) {
  const [shown, setShown] = useState(first);
  const visible = Math.min(total, shown);
  return {
    visible,
    remaining: total - visible,
    more: () => setShown((value) => value + step),
    reset: () => setShown(first),
    expanded: shown > first,
  };
}

// Blocks whose problems were already sent back, by block key, so a remount
// does not offer the same request twice. Presentation-only.
const askedFixes = new Set<string>();

/**
 * What the block dropped or ignored, folded under one quiet line. While the
 * conversation has not moved on, "Ask the agent to fix" sends the problems
 * with their hints as one message (a draft when it cannot be sent).
 */
export function ProblemsPanel({ problems, t, host, context, message }: {
  problems: readonly ChatBlockProblem[];
  t: ChatBlockStrings;
  host: Pick<WebPackageHost, "conversation">;
  context: MarkdownFenceContext;
  message: string;
}) {
  const [asked, setAsked] = useState(() => askedFixes.has(context.blockKey));
  const [sending, setSending] = useState(false);
  const canAsk = context.conversation === true && !context.reply;
  const ask = async () => {
    const sessionId = context.sessionId;
    let ok = false;
    if (sessionId) {
      setSending(true);
      try {
        ok = await host.conversation.send(sessionId, message);
      } catch {
        ok = false;
      } finally {
        setSending(false);
      }
    }
    if (!ok) {
      host.conversation.insert(message);
      return;
    }
    askedFixes.add(context.blockKey);
    setAsked(true);
  };
  return (
    <div className="chat-block-problems">
      <details>
        <summary>
          <WarningIcon aria-hidden="true" />
          <span>{fill(t.problems, { count: problems.length })}</span>
        </summary>
        <ul>
          {problems.map((problem, index) => (
            <li key={index}>
              {problem.line !== undefined && <span className="chat-block-problem-line">{fill(t.problemLine, { line: problem.line })}</span>}
              <code>{problem.text}</code>
              <span className="chat-block-problem-hint">{problem.hint}</span>
            </li>
          ))}
        </ul>
      </details>
      {canAsk && (asked
        ? <span className="chat-block-problems-asked" role="status"><CheckIcon strokeWidth={2.5} aria-hidden="true" />{t.fixAsked}</span>
        : <Button size="sm" variant="ghost" busy={sending} disabled={sending} title={message} onClick={() => { void ask(); }}>{t.askFix}</Button>)}
    </div>
  );
}
