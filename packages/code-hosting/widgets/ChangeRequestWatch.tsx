// A chat's change request watch, as the person sees it: one quiet line above
// the composer while the chat watches (state of the checks, Stop), and a
// timeline fact for each moment that matters (started, woke the agent,
// stopped). Provider-neutral: a provider passes its API base, presentation
// and `t`, whose `prwatch.*` keys it owns.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import type { ChangeRequestWatchView, HostingResult } from "@polyth/code-hosting";
import { watchState } from "./watchState.ts";
import { requestChangeRequestOpen } from "./openChangeRequest.ts";

export { watchState };

export interface ChangeRequestWatchPresentation {
  /** Event namespace and route base, e.g. `github` → `/api/github/pr/watch`. */
  provider: string;
  apiBase: string;
  abbreviation: string;
  numberPrefix: string;
  /** The provider's workspace surface: a reference opens there, in Polyth,
   *  instead of in the browser. */
  surfaceId?: string;
  icon: () => ReactNode;
  t(key: string, values?: Record<string, string | number>): string;
}

const REFRESH_MS = 20_000;
const transport = createApiTransport();

const query = (base: string, projectId: string, sessionId: string) =>
  `${base}/pr/watch?${new URLSearchParams({ projectId, sessionId })}`;

export const fetchChangeRequestWatch = (base: string, projectId: string, sessionId: string) =>
  transport.get<HostingResult<ChangeRequestWatchView | null>>(query(base, projectId, sessionId));

export const startChangeRequestWatch = (base: string, input: { projectId: string; sessionId: string; number: number }) =>
  transport.post<HostingResult<ChangeRequestWatchView>>(`${base}/pr/watch`, input);

export const stopChangeRequestWatch = (base: string, input: { projectId: string; sessionId: string }) =>
  transport.post<HostingResult<ChangeRequestWatchView | null>>(`${base}/pr/watch/stop`, input);

const https = (value: unknown): string | undefined => typeof value === "string" && /^https:\/\//i.test(value) ? value : undefined;

/** Show the change request in the provider's own view; the browser only when
 *  Polyth cannot (no surface, an older host). */
function openChangeRequest(host: WebPackageHost | undefined, p: ChangeRequestWatchPresentation, projectId: string | null, number: number, url: string | undefined) {
  if (host && p.surfaceId && projectId) {
    requestChangeRequestOpen({ provider: p.provider, projectId, number });
    if (host.navigation.openWorkspacePane(p.surfaceId)) return;
  }
  if (url && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}

/** The chat's watch, kept fresh: on mount, on every watch event of the chat
 *  and on a slow timer while the page is visible (the server answers from
 *  memory; it never calls the provider for this). */
export function useChangeRequestWatch(host: WebPackageHost, p: Pick<ChangeRequestWatchPresentation, "provider" | "apiBase">, projectId: string | null, sessionId: string | null) {
  const [view, setView] = useState<ChangeRequestWatchView | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) { setView(null); return; }
    const mine = ++generation.current;
    const result = await fetchChangeRequestWatch(p.apiBase, projectId, sessionId).catch(() => null);
    if (mine !== generation.current || !result) return;
    setView(result.ok ? result.data : null);
  }, [p.apiBase, projectId, sessionId]);
  useEffect(() => {
    setView(null);
    void refresh();
    if (!projectId || !sessionId) return;
    const offEvents = host.sessions.subscribeEvents((event) => {
      if (event.sessionId === sessionId && event.type === `${p.provider}/pr-watch`) void refresh();
    });
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => { generation.current++; offEvents(); clearInterval(timer); };
  }, [host, p.provider, projectId, sessionId, refresh]);
  return { view, setView, refresh };
}

/** The checks of the head commit as one hairline bar: passed, failed, still
 *  running, not started. Words carry the meaning; the bar is the glance. */
function ChecksMeter({ checks }: { checks: ChangeRequestWatchView["checks"] }) {
  if (!checks.total) return null;
  const waiting = Math.max(0, checks.total - checks.passed - checks.failed - checks.running);
  const parts = ([["passed", checks.passed], ["failed", checks.failed], ["running", checks.running], ["waiting", waiting]] as const)
    .filter(([, count]) => count > 0);
  return (
    <span className="hosting-watch-meter" aria-hidden="true">
      {parts.map(([kind, count]) => <i key={kind} data-kind={kind} style={{ flexGrow: count }} />)}
    </span>
  );
}

/** One line above the composer while the chat watches a change request. It
 *  grows in and folds away with the composer's other notice rows. */
export function ChangeRequestWatchLine({ host, presentation: p, projectId, sessionId }: {
  host: WebPackageHost;
  presentation: ChangeRequestWatchPresentation;
  projectId: string | null;
  sessionId: string | null;
}) {
  const { view, setView, refresh } = useChangeRequestWatch(host, p, projectId, sessionId);
  const [busy, setBusy] = useState(false);
  const NoticeRow = host.ui.components.ComposerNoticeRow;
  const showing = Boolean(view && view.state === "watching" && projectId && sessionId);
  const line = showing && view && projectId && sessionId ? (() => {
    const ref = `${p.abbreviation} ${p.numberPrefix}${view.number}`;
    const state = watchState(view, p.t);
    const live = state.tone === "running";
    const stop = async () => {
      setBusy(true);
      const result = await stopChangeRequestWatch(p.apiBase, { projectId, sessionId }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
      setBusy(false);
      if (result.ok) setView(null);
      else {
        host.errors.show?.(p.t("prwatch.stopFailed", { reason: result.reason }));
        void refresh();
      }
    };
    const title = [
      view.title,
      view.wakes ? p.t("prwatch.wakes", { count: view.wakes, max: view.maxWakes }) : p.t("prwatch.explain"),
      view.heldComments ? p.t("prwatch.heldTitle", { count: view.heldComments }) : "",
      view.lastError ?? "",
    ].filter(Boolean).join("\n");
    return (
      <div className="hosting-watch-line" data-tone={state.tone} role="status" aria-label={p.t("prwatch.lineLabel", { ref, state: state.text })}>
        <span className="hosting-watch-mark" aria-hidden="true">{p.icon()}{live && <i />}</span>
        <button
          type="button"
          className="hosting-watch-copy"
          title={title}
          aria-label={p.t("prwatch.open", { ref })}
          onClick={() => openChangeRequest(host, p, projectId, view.number, https(view.url))}
        >
          {/* A narrow line drops the abbreviation: the mark already says it. */}
          <strong><span className="hosting-watch-abbr">{p.abbreviation} </span>{p.numberPrefix}{view.number}</strong>
          <ChecksMeter checks={view.checks} />
          <span className="hosting-watch-state">
            {state.parts.map((part, index) => <span key={index} data-tone={part.tone}>{part.text}</span>)}
          </span>
          {view.heldComments > 0 && <span className="hosting-watch-held">{p.t("prwatch.held", { count: view.heldComments })}</span>}
        </button>
        <button type="button" className="hosting-watch-stop" disabled={busy} aria-busy={busy || undefined} aria-label={p.t("prwatch.stopLabel", { ref })} onClick={() => void stop()}>
          {p.t("prwatch.stop")}
        </button>
      </div>
    );
  })() : null;
  // An older host without the notice row still gets the line, unanimated.
  return NoticeRow ? <NoticeRow open={showing}>{line}</NoticeRow> : line;
}

/** The PR view's switch: watch this change request in the open chat. Its
 *  name stays the same in both states; the pressed look says it is on. */
export function ChangeRequestWatchToggle({ host, presentation: p, projectId, sessionId, number, className }: {
  host: WebPackageHost;
  presentation: ChangeRequestWatchPresentation;
  projectId: string;
  sessionId: string;
  number: number;
  className?: string;
}) {
  const { Button } = host.ui.components;
  const { view, setView } = useChangeRequestWatch(host, p, projectId, sessionId);
  const [busy, setBusy] = useState(false);
  const watching = view?.state === "watching" && view.number === number;
  const other = view?.state === "watching" && view.number !== number ? `${p.abbreviation} ${p.numberPrefix}${view.number}` : "";
  const toggle = async () => {
    setBusy(true);
    const result = await (watching
      ? stopChangeRequestWatch(p.apiBase, { projectId, sessionId })
      : startChangeRequestWatch(p.apiBase, { projectId, sessionId, number })
    ).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (result.ok) setView(watching ? null : result.data);
    else host.errors.show?.(p.t(watching ? "prwatch.stopFailed" : "prwatch.startFailed", { reason: result.reason }));
  };
  return (
    <Button
      size="sm"
      busy={busy}
      aria-pressed={watching}
      title={watching ? p.t("prwatch.watchingTitle") : other ? p.t("prwatch.replaceTitle", { ref: other }) : p.t("prwatch.explain")}
      className={["hosting-watch-toggle", className].filter(Boolean).join(" ")}
      onClick={() => void toggle()}
    >
      {watching && <span className="hosting-watch-toggle-dot" aria-hidden="true" />}
      {p.t("prwatch.watchInChat")}
    </Button>
  );
}

interface WatchEventData {
  phase?: unknown; number?: unknown; title?: unknown; url?: unknown; reason?: unknown; sha?: unknown;
  failedChecks?: unknown; comments?: unknown; commentCount?: unknown; wake?: unknown; maxWakes?: unknown; wakes?: unknown;
}

const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** A timeline fact for one moment of a watch. Malformed data renders nothing. */
export function ChangeRequestWatchEvent({ event, presentation: p, host, projectId }: {
  event: SessionEvent;
  presentation: ChangeRequestWatchPresentation;
  /** With a host, "Open" shows the change request in Polyth. */
  host?: WebPackageHost;
  projectId?: string | null;
}) {
  if (event.type !== `${p.provider}/pr-watch`) return null;
  const data = (event.data ?? {}) as WatchEventData;
  const number = positive(data.number);
  if (!number) return null;
  const ref = `${p.abbreviation} ${p.numberPrefix}${number}`;
  const url = https(data.url);
  const mark = <span className="hosting-watch-fact-mark" aria-hidden="true">{p.icon()}</span>;
  if (data.phase === "started") {
    return (
      <div className="hosting-watch-fact" data-phase="started" data-msg-id={event.id}>
        <p className="hosting-watch-fact-line">
          <span className="hosting-watch-fact-copy">
            <span className="hosting-watch-fact-title">{mark}<strong>{p.t("prwatch.startedTitle", { ref })}</strong></span>
            <span>{p.t("prwatch.startedBody")}</span>
          </span>
        </p>
      </div>
    );
  }
  if (data.phase === "ended") {
    const reason = text(data.reason);
    const known = ["merged", "closed", "stopped", "replaced", "wake-limit", "inactive", "unavailable"].includes(reason) ? reason : "stopped";
    return (
      <div className="hosting-watch-fact" data-phase="ended" data-reason={known} data-msg-id={event.id}>
        <p className="hosting-watch-fact-line">
          <span className="hosting-watch-fact-copy">
            <span className="hosting-watch-fact-title">{mark}<span>{p.t(`prwatch.ended.${known}`, { ref, count: positive(data.wakes) ?? 0 })}</span></span>
          </span>
        </p>
      </div>
    );
  }
  if (data.phase !== "woke") return null;
  const failed = (Array.isArray(data.failedChecks) ? data.failedChecks : [])
    .map((row) => row as { name?: unknown; url?: unknown })
    .filter((row) => text(row.name))
    .map((row) => ({ name: text(row.name), url: https(row.url) }));
  const comments = (Array.isArray(data.comments) ? data.comments : [])
    .map((row) => row as { author?: unknown; path?: unknown; line?: unknown; url?: unknown; excerpt?: unknown })
    .map((row) => ({ author: text(row.author), path: text(row.path), line: positive(row.line), url: https(row.url), excerpt: text(row.excerpt) }));
  const commentCount = positive(data.commentCount) ?? comments.length;
  const failedText = failed.length ? p.t("prwatch.wokeFailed", { names: failed.slice(0, 3).map((row) => row.name).join(", ") + (failed.length > 3 ? "…" : "") }) : "";
  const commentText = commentCount ? p.t("prwatch.wokeComments", { count: commentCount }) : "";
  const sha = text(data.sha);
  const wake = positive(data.wake);
  const maxWakes = positive(data.maxWakes);
  return (
    <details className="hosting-watch-fact" data-phase="woke" data-msg-id={event.id}>
      <summary className="hosting-watch-fact-line">
        <span className="hosting-watch-fact-copy">
          <span className="hosting-watch-fact-title">{mark}<strong>{p.t("prwatch.wokeTitle", { ref })}</strong></span>
          <span>
            {failedText && <span className="hosting-watch-fact-failed">{failedText}</span>}
            {/* The dot stays with the words before it when the line wraps. */}
            {failedText && commentText ? "\u00a0· " : ""}
            {commentText}
          </span>
        </span>
        <span className="hosting-watch-fact-chevron" aria-hidden="true" />
      </summary>
      <div className="hosting-watch-fact-detail">
        {failed.length > 0 && (
          <ul aria-label={p.t("prwatch.failedChecks")}>
            {failed.map((row) => (
              <li key={row.name}>
                <span className="hosting-watch-dot" data-tone="failure" aria-hidden="true" />
                <span className="hosting-watch-fact-row">
                  {row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.name}</a> : <span>{row.name}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {comments.length > 0 && (
          <ul aria-label={p.t("prwatch.newComments")}>
            {comments.map((row, index) => {
              const where = row.path ? `${row.path}${row.line ? `:${row.line}` : ""}` : "";
              return (
                <li key={`${row.author}-${index}`}>
                  <span className="hosting-watch-dot" data-tone="review" aria-hidden="true" />
                  <span className="hosting-watch-fact-row">
                    <span className="hosting-watch-fact-who">
                      <span>@{row.author || "?"}</span>
                      {where && (row.url
                        ? <a href={row.url} target="_blank" rel="noreferrer"><code>{where}</code></a>
                        : <code>{where}</code>)}
                    </span>
                    {row.excerpt && <span className="hosting-watch-fact-excerpt">{row.excerpt}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hosting-watch-fact-foot">
          <span>
            {[sha ? p.t("prwatch.onCommit", { sha }) : "", wake && maxWakes ? p.t("prwatch.wakes", { count: wake, max: maxWakes }) : ""].filter(Boolean).join(" · ")}
          </span>
          {host && p.surfaceId && projectId
            ? <button type="button" className="hosting-watch-fact-open" onClick={() => openChangeRequest(host, p, projectId, number, url)}>{p.t("prwatch.open", { ref })}</button>
            : url && <a href={url} target="_blank" rel="noreferrer">{p.t("prwatch.open", { ref })}</a>}
        </p>
      </div>
    </details>
  );
}
