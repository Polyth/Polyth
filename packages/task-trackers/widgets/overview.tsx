import { useEffect, useState } from "react";
import type {
  TaskTrackerProvider,
  TaskTrackerStatusCategory,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import { api } from "./api.ts";
import { PROVIDER_LABELS, ProviderMark, providerState, stateLabel } from "./brand.tsx";
import { tt } from "./i18n.ts";
import { resolveBoard, useProviderScope } from "./scope.ts";
import { TASK_TRACKER_CHANGED, taskTrackerHost, useManagement } from "./store.ts";
import { TASK_TRACKER_PROVIDERS } from "../src/types.ts";

export interface ProgressSummary {
  total: number;
  counts: Record<Exclude<TaskTrackerStatusCategory, "unknown">, number>;
  /** 0..1 share of done tasks. */
  done: number;
}

/** Unknown statuses count as open work: they are neither started nor finished. */
export function summarizeProgress(tasks: readonly TaskTrackerTaskDto[]): ProgressSummary {
  const counts = { todo: 0, in_progress: 0, done: 0 };
  for (const task of tasks) {
    const category = task.status.category === "unknown" ? "todo" : task.status.category;
    counts[category]++;
  }
  return { total: tasks.length, counts, done: tasks.length ? counts.done / tasks.length : 0 };
}

interface Row {
  board: string;
  summary: ProgressSummary;
}

function ProviderProgress({ provider, projectId }: { provider: TaskTrackerProvider; projectId: string | null }) {
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState(false);
  const scope = useProviderScope(projectId, provider);

  useEffect(() => {
    let active = true;
    const load = () => {
      void api.taskTrackerBoards(provider)
        .then(async (boards) => {
          // The project's default board, else the first one it shows.
          const boardId = resolveBoard(boards, scope);
          const board = boards.find((item) => item.id === boardId);
          if (!board) return active && setRow({ board: tt("tasktrackers.overview.noBoards"), summary: summarizeProgress([]) });
          const tasks = await api.taskTrackerTasks(provider, { boardId: board.id, limit: 100 });
          if (active) {
            setError(false);
            setRow({ board: board.name, summary: summarizeProgress(tasks) });
          }
        })
        .catch(() => { if (active) setError(true); });
    };
    load();
    window.addEventListener(TASK_TRACKER_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(TASK_TRACKER_CHANGED, load);
    };
  }, [provider, scope]);

  if (error) return <small className="tt-overview-muted">{tt("tasktrackers.overview.unavailable")}</small>;
  if (!row) return <span className="tt-overview-bar loading" aria-hidden="true" />;
  const { counts, total } = row.summary;
  const share = (value: number) => `${total ? (value / total) * 100 : 0}%`;
  return (
    <div className="tt-overview-progress">
      <span className="tt-overview-board">{row.board}</span>
      <span
        className="tt-overview-bar"
        role="img"
        aria-label={tt("tasktrackers.overview.progressAria", { done: counts.done, total, inProgress: counts.in_progress, todo: counts.todo })}
      >
        <i className="done" style={{ width: share(counts.done) }} />
        <i className="in_progress" style={{ width: share(counts.in_progress) }} />
        <i className="todo" style={{ width: share(counts.todo) }} />
      </span>
      <span className="tt-overview-counts" aria-hidden="true">
        <b>{tt("tasktrackers.overview.counts", { done: counts.done, total, active: counts.in_progress })}</b>
      </span>
    </div>
  );
}

/** Progress on each tracker's board in this Polyth project (no project: the account-wide choice). */
export function TaskTrackerOverview({ projectId = null }: { projectId?: string | null }) {
  const { data, preferences } = useManagement();
  const host = taskTrackerHost();
  const open = () => host?.navigation.openWorkspacePane("task-trackers");
  const manage = () => host?.navigation.openSettingsPage("task-trackers");
  // Trackers the server knows and the Space has on.
  const providers = TASK_TRACKER_PROVIDERS.filter((provider) =>
    preferences.providers[provider] && (data?.providers ?? []).some((item) => item.provider === provider));

  if (!data) return <div className="tt-overview" role="status"><span className="tt-spinner" /> {tt("tasktrackers.overview.loading")}</div>;
  if (providers.length === 0) {
    return (
      <div className="tt-overview empty">
        <span>{tt("tasktrackers.overview.allOff")}</span>
        <Button size="sm" onClick={manage}>{tt("tasktrackers.overview.manage")}</Button>
      </div>
    );
  }

  return (
    <div className="tt-overview">
      <ul>
        {providers.map((provider, index) => {
          const info = data.providers.find((item) => item.provider === provider);
          const state = providerState(info);
          const usable = state !== "disconnected" && state !== "off";
          return (
            <li key={provider} style={{ "--tt-i": index } as Record<string, number>}>
              <ProviderMark provider={provider} />
              <span className="tt-overview-name">
                <strong>{PROVIDER_LABELS[provider]}</strong>
                <small data-state={state}>{info?.account?.name ?? stateLabel(state)}</small>
              </span>
              {usable
                ? <ProviderProgress provider={provider} projectId={projectId} />
                : <Button size="sm" variant="primary" onClick={manage}>{tt("tasktrackers.overview.connect")}</Button>}
            </li>
          );
        })}
      </ul>
      <div className="tt-overview-foot">
        <Button size="sm" variant="ghost" onClick={open}>{tt("tasktrackers.overview.open")}</Button>
        <Button size="sm" variant="ghost" onClick={manage}>{tt("tasktrackers.overview.manage")}</Button>
      </div>
    </div>
  );
}
