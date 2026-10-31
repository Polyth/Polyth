import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { WebPackageHost, WidgetRenderContext } from "@polyth/web-sdk";
import { EmptyState } from "../../../apps/web/src/components/ui/index.ts";
import {
  progressElapsed,
  sessionProgress,
  summarizeSubagents,
  type SubagentRow,
} from "../src/progress.ts";
import { useMoreBelow } from "./scrollFade.ts";
import { fill, todoFormat, todoStrings } from "./strings.ts";

type Props = Pick<WidgetRenderContext, "sessionId"> & { host: WebPackageHost };

/** Re-render on any session change; the key only changes when displayed data does. */
function useSessionKey(host: WebPackageHost, key: () => string): void {
  useSyncExternalStore(host.sessions.subscribe, key, key);
}

const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

/**
 * Package root: the container every layout rule queries, in any slot, and the
 * widget's own scroll region. A clipped tail fades instead of cutting a row.
 */
function Root({ children }: { children: ReactNode }) {
  const [ref, more] = useMoreBelow<HTMLDivElement>();
  return <div ref={ref} className="todos-widget" data-more={more || undefined}>{children}</div>;
}

const Empty = ({ title, hint }: { title: string; hint?: string }) => (
  <Root><div className="todos-widget__empty"><EmptyState variant="compact" title={title} {...(hint ? { description: hint } : {})} /></div></Root>
);

export function SessionProgressBar({ host, sessionId }: Props) {
  const locale = host.ui.locale.get();
  const t = todoStrings(locale);
  const f = todoFormat(locale);
  const compute = () => (sessionId ? sessionProgress(host.sessions.events(sessionId)) : undefined);
  useSessionKey(host, () => JSON.stringify(compute()));
  const progress = compute();
  const now = useNow(!!progress && progress.total > 0 && !progress.settled);

  if (!sessionId) return <Empty title={t.noSession} hint={t.progressNoSession} />;
  if (!progress || progress.total === 0) return <Empty title={t.progressEmpty} hint={t.progressEmptyHint} />;

  const percent = Math.round((progress.done / progress.total) * 100);
  const elapsed = progressElapsed(progress, now);
  const label = fill(t.progressLabel, { done: f.count(progress.done), total: f.count(progress.total) });
  return (
    <Root>
      <section className="todos-progress" data-settled={progress.settled} aria-label={t.progressTitle}>
        <div className="todos-progress__head">
          <span className="todos-progress__count">{fill(t.progressCount, { done: f.count(progress.done), total: f.count(progress.total) })}</span>
          {progress.failed > 0 && <span className="todos-progress__failed">{fill(t.progressFailed, { failed: f.count(progress.failed) })}</span>}
          {elapsed !== undefined && <span className="todos-progress__elapsed">{fill(t.elapsed, { time: f.elapsed(elapsed) })}</span>}
        </div>
        <div
          className="todos-progress__bar"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <span className="todos-progress__fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="todos-progress__current" aria-live="polite">
          {progress.current
            ? <><span className="todos-progress__now">{t.progressCurrent}</span> <bdi className="todos-progress__text" title={progress.current.text}>{progress.current.text}</bdi></>
            : <span className="todos-progress__text">{t.progressDone}</span>}
        </p>
      </section>
    </Root>
  );
}

export function SubagentPanel({ host, sessionId }: Props) {
  const locale = host.ui.locale.get();
  const t = todoStrings(locale);
  const f = todoFormat(locale);
  const compute = () => {
    if (!sessionId) return undefined;
    return summarizeSubagents(sessionId, {
      events: (id) => host.sessions.events(id),
      session: (id) => host.sessions.get(id),
    });
  };
  useSessionKey(host, () => JSON.stringify(compute()));
  const summary = compute();

  if (!sessionId) return <Empty title={t.noSession} hint={t.subagentsNoSession} />;
  if (!summary || summary.rows.length === 0) return <Empty title={t.subagentsEmpty} hint={t.subagentsEmptyHint} />;

  const stateLabel = (row: SubagentRow) => t[row.state];
  return (
    <Root>
      <section className="todos-agents" aria-label={t.subagentsTitle}>
        <div className="todos-agents__head">
          <span>{fill(t.subagentsSummary, { running: f.count(summary.running), total: f.count(summary.rows.length) })}</span>
          <span className="todos-agents__total">
            {fill(t.tokens, { count: f.tokens(summary.tokens) })}
            {summary.cost > 0 && ` · ${f.cost(summary.cost)}`}
          </span>
        </div>
        {summary.partial && <p className="todos-agents__note">{t.usagePartial}</p>}
        <ul className="todos-agents__list">
          {summary.rows.map((row) => (
            <li key={row.sessionId} className="todos-agents__row" data-state={row.state} style={{ "--todos-depth": row.depth } as CSSProperties}>
              <button
                type="button"
                className="todos-agents__open"
                title={fill(t.open, { label: row.label })}
                onClick={() => { void host.conversation.openSession(row.sessionId); }}
              >
                <span className="todos-agents__dot" aria-hidden="true" />
                <span className="todos-agents__main">
                  <bdi className="todos-agents__label">{row.label}</bdi>
                  {row.currentTask && <bdi className="todos-agents__task">{row.currentTask}</bdi>}
                </span>
                <span className="todos-agents__meta">
                  <span className="todos-agents__state">{stateLabel(row)}</span>
                  {row.tokens !== undefined && (
                    <span className="todos-agents__usage">
                      {f.tokens(row.tokens)}{row.cost !== undefined && row.cost > 0 ? ` · ${f.cost(row.cost)}` : ""}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Root>
  );
}
