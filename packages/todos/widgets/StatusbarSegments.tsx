// The package's status-bar segments: the session's todo progress and its
// background work (running sub-agents, queued messages). Mini-widgets in the
// bar's two widget areas, so they hide, reorder and move between the ends
// like the shell's own segments. They read canonical events through
// `host.sessions` only and render nothing when there is nothing to say; a
// click opens a popover with the detail instead of leaving the chat.
import { useRef, useState, useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { BotIcon, Icon, Popover, TasksIcon } from "../../../apps/web/src/components/ui/index.ts";
import { queuedMessageIds } from "../src/background.ts";
import { sessionProgress, summarizeSubagents } from "../src/progress.ts";
import type { TodoItem } from "../src/index.ts";
import { SubagentPanel } from "./SessionProgress.tsx";
import { fill, todoFormat, todoStrings } from "./strings.ts";

interface SegmentProps {
  host: WebPackageHost;
  sessionId: string | null;
}

/** Re-render on any session change; the key only changes when shown data does. */
function useSessionKey(host: WebPackageHost, key: () => string): void {
  useSyncExternalStore(host.sessions.subscribe, key, key);
}

const ITEM_GLYPH: Record<TodoItem["status"], string> = { pending: "○", active: "◐", done: "●", failed: "✕" };

export function TodoProgressSegment({ host, sessionId }: SegmentProps) {
  const locale = host.ui.locale.get();
  const t = todoStrings(locale);
  const f = todoFormat(locale);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const compute = () => (sessionId ? sessionProgress(host.sessions.events(sessionId)) : undefined);
  useSessionKey(host, () => JSON.stringify(compute()));
  const progress = compute();
  if (!progress || progress.total === 0) return null;
  const count = fill(t.progressCount, { done: f.count(progress.done), total: f.count(progress.total) });
  const label = fill(t.progressLabel, { done: f.count(progress.done), total: f.count(progress.total) });
  const current = progress.current?.text;
  const stateLabel = (status: TodoItem["status"]) =>
    status === "active" ? t.running : status === "done" ? t.done : status === "failed" ? t.failed : t.pending;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="sb sb-action todos-sb todos-sb-progress"
        data-settled={progress.settled}
        {...(progress.failed > 0 ? { "data-failed": "" } : {})}
        title={current ? `${label} · ${current}` : label}
        aria-label={current ? `${label}. ${t.progressCurrent}: ${current}` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={TasksIcon} size="sm" />
        <span className="todos-sb-count">{count}</span>
        {current && <bdi className="sb-text todos-sb-current">{current}</bdi>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} side="up" align="start" className="todos-sb-pop" ariaLabel={t.progressTitle}>
        <div className="todos-sb-list">
          <div className="todos-sb-list__head">
            <strong>{t.progressTitle}</strong>
            <span>{count}</span>
          </div>
          <ol>
            {progress.items.map((item) => (
              <li key={item.id} data-status={item.status}>
                <span className="todos-sb-list__glyph" aria-hidden="true">{ITEM_GLYPH[item.status]}</span>
                <bdi>{item.text}</bdi>
                <span className="sr-only">{stateLabel(item.status)}</span>
              </li>
            ))}
          </ol>
        </div>
      </Popover>
    </>
  );
}

export function BackgroundWorkSegment({ host, sessionId }: SegmentProps) {
  const locale = host.ui.locale.get();
  const t = todoStrings(locale);
  const f = todoFormat(locale);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const compute = () => {
    if (!sessionId) return undefined;
    const agents = summarizeSubagents(sessionId, {
      events: (id) => host.sessions.events(id),
      session: (id) => host.sessions.get(id),
    });
    return { running: agents.running, agents: agents.rows.length, queued: queuedMessageIds(host.sessions.events(sessionId)).length };
  };
  const key = () => JSON.stringify(compute() ?? null);
  useSessionKey(host, key);
  const work = compute();
  if (!work || (work.running === 0 && work.queued === 0)) return null;
  const parts = [
    work.running > 0 ? fill(t.backgroundRunning, { count: f.count(work.running) }) : null,
    work.queued > 0 ? fill(t.backgroundQueued, { count: f.count(work.queued) }) : null,
  ].filter((part): part is string => part !== null);
  const label = `${t.statusbarBackgroundTitle}: ${parts.join(", ")}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="sb sb-action todos-sb todos-sb-background"
        {...(work.running > 0 ? { "data-running": "" } : {})}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={BotIcon} size="sm" />
        <span className="sb-text">{parts.join(" · ")}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} side="up" align="end" className="todos-sb-pop todos-sb-pop--agents" ariaLabel={t.statusbarBackgroundTitle}>
        {work.agents > 0 && <SubagentPanel host={host} sessionId={sessionId} />}
        {work.queued > 0 && <p className="todos-sb-queue">{fill(t.backgroundQueuedLong, { count: f.count(work.queued) })}</p>}
      </Popover>
    </>
  );
}
