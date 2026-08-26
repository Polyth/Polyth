import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  JsonObject,
  TaskTrackerBoardDto,
  TaskTrackerBoardType,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerSessionTaskDto,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { friendlyError } from "../settings.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "./catalog.ts";

type BoardView = "kanban" | "list";

const PROVIDER_LABELS: Record<TaskTrackerProvider, string> = {
  jira: "Jira",
  trello: "Trello",
};

const CATEGORY_LABELS: Record<TaskTrackerStatusCategory, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  unknown: "Other",
};

const CATEGORY_ORDER: Record<TaskTrackerStatusCategory, number> = {
  todo: 0,
  in_progress: 1,
  unknown: 2,
  done: 3,
};

const BOARD_SETTINGS = {
  type: "object",
  properties: {
    defaultView: {
      type: "string",
      title: "Default board view",
      enum: ["kanban", "list"],
      default: "kanban",
    },
    hideCompleted: {
      type: "boolean",
      title: "Hide completed tasks",
      default: false,
    },
  },
} as const;

const changed = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("polyth:task-tracker-changed"));
  }
};

const messageOf = (action: string, cause: unknown): string =>
  friendlyError(action, cause);

export const defaultViewForBoard = (type: TaskTrackerBoardType): BoardView =>
  type === "simple" || type === "unknown" ? "list" : "kanban";

export interface TaskStatusGroup {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
  tasks: TaskTrackerTaskDto[];
}

export function groupTasksByStatus(tasks: readonly TaskTrackerTaskDto[]): TaskStatusGroup[] {
  const groups = new Map<string, TaskStatusGroup>();
  for (const task of tasks) {
    const key = `${task.status.category}:${task.status.id || task.status.name}`;
    const current = groups.get(key) ?? {
      id: key,
      name: task.status.name || CATEGORY_LABELS[task.status.category],
      category: task.status.category,
      tasks: [],
    };
    current.tasks.push(task);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) =>
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    || left.name.localeCompare(right.name));
}

function providerMark(provider: TaskTrackerProvider): ReactNode {
  return <span className={`tt-provider-mark ${provider}`} aria-hidden="true">
    {provider === "jira" ? "J" : "T"}
  </span>;
}

function StatusPill({ status }: { status: TaskTrackerStatusDto }) {
  return <span className={`tt-status ${status.category}`}>{status.name}</span>;
}

function dueLabel(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function TaskMeta({ task }: { task: TaskTrackerTaskDto }) {
  const due = dueLabel(task.dueAt);
  return (
    <div className="tt-task-meta">
      <span className="tt-task-key">{task.key}</span>
      {task.labels.slice(0, 2).map((label) => <span className="tt-label" key={label}>{label}</span>)}
      {task.assignees[0] && <span className="tt-assignee" title={task.assignees.join(", ")}>
        {task.assignees[0].slice(0, 1).toUpperCase()}
      </span>}
      {due && <time className="tt-due" dateTime={task.dueAt}>{due}</time>}
    </div>
  );
}

function TaskCard({
  task,
  linked,
  onOpen,
}: {
  task: TaskTrackerTaskDto;
  linked: boolean;
  onOpen: (task: TaskTrackerTaskDto) => void;
}) {
  return (
    <button
      type="button"
      className={`tt-task-card${linked ? " linked" : ""}`}
      onClick={() => onOpen(task)}
      aria-label={`Open ${task.key}: ${task.title}`}
    >
      <span className="tt-card-top">
        <StatusPill status={task.status} />
        {linked && <span className="tt-linked-chip"><Icon.link /> Linked</span>}
      </span>
      <strong>{task.title}</strong>
      <TaskMeta task={task} />
    </button>
  );
}

function BoardEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="tt-empty">
      <span className="tt-empty-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

function TaskDetail({
  task,
  sessionId,
  linked,
  loading,
  onClose,
  onTaskChanged,
}: {
  task: TaskTrackerTaskDto;
  sessionId: string | null;
  linked: boolean;
  loading: boolean;
  onClose: () => void;
  onTaskChanged: (task: TaskTrackerTaskDto, linked?: boolean) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [statusId, setStatusId] = useState(task.status.id);
  const [busy, setBusy] = useState<"link" | "select" | "status" | "complete" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setNotice("");
    setError("");
    setInstructions("");
  }, [task.id]);

  useEffect(() => {
    setStatusId(task.status.id);
  }, [task.id, task.status.id]);

  const statuses = task.availableStatuses ?? [];
  const doneStatus = statuses.find((status) => status.category === "done");
  const mutate = async (action: "status" | "complete", nextStatusId: string) => {
    if (!sessionId || !nextStatusId || nextStatusId === task.status.id) return;
    setBusy(action);
    setError("");
    try {
      const updated = await api.taskTrackerUpdateStatus(task.provider, task.id, {
        sessionId,
        statusId: nextStatusId,
      });
      onTaskChanged(updated);
      setNotice(updated.status.category === "done" ? "Task marked complete." : `Moved to ${updated.status.name}.`);
      changed();
    } catch (cause) {
      setError(messageOf("Couldn’t update task status", cause));
    } finally {
      setBusy(null);
    }
  };
  const link = async (startAgent: boolean) => {
    if (!sessionId) return;
    setBusy(startAgent ? "link" : "select");
    setError("");
    try {
      const result = await api.taskTrackerLink(task.provider, task.id, {
        sessionId,
        startAgent,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      onTaskChanged(result.task, true);
      setNotice(startAgent ? "Linked. The agent is starting work." : "Task linked to this session.");
      changed();
    } catch (cause) {
      setError(messageOf("Couldn’t link this task", cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="tt-detail" aria-label={`${task.key} task details`}>
      <header className="tt-detail-header">
        <div>
          <span className="tt-eyebrow">{providerMark(task.provider)} {PROVIDER_LABELS[task.provider]} · {task.key}</span>
          <h3>{task.title}</h3>
        </div>
        <button type="button" className="tt-icon-btn" onClick={onClose} aria-label="Close task details">
          <Icon.close />
        </button>
      </header>

      <div className="tt-detail-scroll">
        <div className="tt-detail-summary">
          <StatusPill status={task.status} />
          {linked && <span className="tt-linked-chip"><Icon.link /> Linked to session</span>}
          {loading && <span className="tt-detail-loading" role="status">Refreshing…</span>}
        </div>
        {task.description
          ? <p className="tt-description">{task.description}</p>
          : <p className="tt-description muted">No description provided.</p>}

        {(task.labels.length > 0 || task.assignees.length > 0 || task.dueAt) && (
          <dl className="tt-facts">
            {task.assignees.length > 0 && <><dt>Assigned</dt><dd>{task.assignees.join(", ")}</dd></>}
            {task.labels.length > 0 && <><dt>Labels</dt><dd>{task.labels.join(", ")}</dd></>}
            {task.dueAt && <><dt>Due</dt><dd>{dueLabel(task.dueAt) ?? task.dueAt}</dd></>}
          </dl>
        )}

        <section className="tt-detail-section">
          <div className="tt-section-heading">
            <span className="tt-step">1</span>
            <div><strong>Hand off to the agent</strong><small>Task context is logged before work starts.</small></div>
          </div>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Optional instructions for the agent…"
            rows={3}
            disabled={busy !== null}
          />
          <div className="tt-action-row">
            <button
              type="button"
              className="tt-primary"
              disabled={!sessionId || busy !== null}
              onClick={() => void link(true)}
            >
              <Icon.send /> {busy === "link" ? "Starting…" : linked ? "Start agent" : "Link & start agent"}
            </button>
            <button
              type="button"
              disabled={!sessionId || busy !== null}
              onClick={() => void link(false)}
            >
              <Icon.link /> {busy === "select" ? "Linking…" : linked ? "Link again" : "Link only"}
            </button>
          </div>
          {!sessionId && <small className="tt-inline-hint">Open a session to link this task.</small>}
        </section>

        <section className="tt-detail-section">
          <div className="tt-section-heading">
            <span className="tt-step">2</span>
            <div><strong>Update the tracker</strong><small>Move the task when the work is ready.</small></div>
          </div>
          {statuses.length > 0 ? (
            <>
              <div className="tt-status-row">
                <label>
                  <span className="sr-only">Task status</span>
                  <select
                    value={statusId}
                    onChange={(event) => setStatusId(event.target.value)}
                    disabled={!sessionId || busy !== null}
                  >
                    <option value={task.status.id}>{task.status.name}</option>
                    {statuses.filter((status) => status.id !== task.status.id).map((status) => (
                      <option key={status.id} value={status.id}>{status.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!sessionId || busy !== null || statusId === task.status.id}
                  onClick={() => void mutate("status", statusId)}
                >
                  {busy === "status" ? "Updating…" : "Update status"}
                </button>
              </div>
              {doneStatus && task.status.category !== "done" && (
                <button
                  type="button"
                  className="tt-complete"
                  disabled={!sessionId || busy !== null}
                  onClick={() => void mutate("complete", doneStatus.id)}
                >
                  <Icon.check /> {busy === "complete" ? "Completing…" : "Mark complete"}
                </button>
              )}
            </>
          ) : (
            <p className="tt-inline-hint">No status transitions are available for this task.</p>
          )}
        </section>

        {task.url && (
          <a className="tt-external" href={task.url} target="_blank" rel="noreferrer">
            Open in {PROVIDER_LABELS[task.provider]} <Icon.external />
          </a>
        )}
        {notice && <p className="tt-notice" role="status">{notice}</p>}
        {error && <p className="tt-error" role="alert">{error}</p>}
      </div>
    </aside>
  );
}

export function TaskTrackerBoard({
  sessionId,
  config,
  updateConfig,
}: Pick<WidgetRenderContext, "sessionId" | "config" | "updateConfig">) {
  const configuredDefault = config.defaultView === "list" ? "list" : "kanban";
  const [providers, setProviders] = useState<TaskTrackerProviderDto[] | null>(null);
  const [provider, setProvider] = useState<TaskTrackerProvider>("jira");
  const [projects, setProjects] = useState<TaskTrackerProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [boards, setBoards] = useState<TaskTrackerBoardDto[]>([]);
  const [boardId, setBoardId] = useState("");
  const [tasks, setTasks] = useState<TaskTrackerTaskDto[]>([]);
  const [linkedTasks, setLinkedTasks] = useState<TaskTrackerSessionTaskDto[]>([]);
  const [selected, setSelected] = useState<TaskTrackerTaskDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<BoardView>(configuredDefault);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState<"providers" | "boards" | "tasks" | null>("providers");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const providerInfo = providers?.find((item) => item.provider === provider);
  const board = boards.find((item) => item.id === boardId) ?? null;

  useEffect(() => {
    let active = true;
    setLoading("providers");
    setError("");
    void api.taskTrackerProviders()
      .then((items) => {
        if (!active) return;
        setProviders(items);
        const firstConfigured = items.find((item) => item.configured);
        if (firstConfigured) setProvider(firstConfigured.provider);
      })
      .catch((cause) => {
        if (active) setError(messageOf("Couldn’t load task tracker providers", cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "providers" ? null : current);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!providerInfo?.configured) {
      setProjects([]);
      setBoards([]);
      setBoardId("");
      setTasks([]);
      return;
    }
    let active = true;
    setProjectId("");
    setBoardId("");
    setTasks([]);
    setSelected(null);
    void api.taskTrackerProjects(provider)
      .then((items) => { if (active) setProjects(items); })
      .catch((cause) => { if (active) setError(messageOf("Couldn’t load projects", cause)); });
    return () => { active = false; };
  }, [provider, providerInfo?.configured]);

  useEffect(() => {
    if (!providerInfo?.configured) return;
    let active = true;
    setLoading("boards");
    setError("");
    setBoards([]);
    setBoardId("");
    setTasks([]);
    void api.taskTrackerBoards(provider, projectId || undefined)
      .then((items) => {
        if (!active) return;
        setBoards(items);
        setBoardId(items[0]?.id ?? "");
      })
      .catch((cause) => {
        if (active) setError(messageOf("Couldn’t load boards", cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "boards" ? null : current);
      });
    return () => { active = false; };
  }, [provider, projectId, providerInfo?.configured]);

  useEffect(() => {
    if (!boardId || !providerInfo?.configured) return;
    let active = true;
    setLoading("tasks");
    setError("");
    void api.taskTrackerTasks(provider, { boardId, limit: 100 })
      .then((items) => { if (active) setTasks(items); })
      .catch((cause) => {
        if (active) setError(messageOf("Couldn’t load tasks", cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "tasks" ? null : current);
      });
    return () => { active = false; };
  }, [boardId, provider, providerInfo?.configured, refreshKey]);

  useEffect(() => {
    if (!sessionId) {
      setLinkedTasks([]);
      return;
    }
    let active = true;
    const load = () => {
      void api.taskTrackerSessionTasks(sessionId)
        .then((items) => { if (active) setLinkedTasks(items); })
        .catch(() => { if (active) setLinkedTasks([]); });
    };
    load();
    window.addEventListener("polyth:task-tracker-changed", load);
    return () => {
      active = false;
      window.removeEventListener("polyth:task-tracker-changed", load);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!board) return;
    const next = config.defaultView === "kanban" || config.defaultView === "list"
      ? config.defaultView
      : defaultViewForBoard(board.type);
    setView(next);
  }, [board?.id, board?.type, config.defaultView]);

  const linkedIds = useMemo(
    () => new Set(linkedTasks.map((task) => `${task.provider}:${task.taskId}`)),
    [linkedTasks],
  );
  const statuses = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      if (config.hideCompleted === true && task.status.category === "done") return false;
      if (statusFilter !== "all" && task.status.id !== statusFilter) return false;
      return !needle || `${task.key} ${task.title} ${task.labels.join(" ")}`
        .toLocaleLowerCase().includes(needle);
    });
  }, [config.hideCompleted, query, statusFilter, tasks]);
  const visibleGroups = useMemo(() => groupTasksByStatus(visibleTasks), [visibleTasks]);

  const openTask = (task: TaskTrackerTaskDto) => {
    setSelected(task);
    setDetailLoading(true);
    void api.taskTrackerTask(task.provider, task.id)
      .then((detail) => {
        setSelected((current) => current?.id === task.id ? detail : current);
      })
      .catch((cause) => setError(messageOf(`Couldn’t refresh ${task.key}`, cause)))
      .finally(() => setDetailLoading(false));
  };
  const updateTask = (updated: TaskTrackerTaskDto, linked = false) => {
    setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    setSelected(updated);
    if (linked) {
      setLinkedTasks((current) => current.some((task) =>
        task.provider === updated.provider && task.taskId === updated.id)
        ? current
        : [...current, {
            provider: updated.provider,
            taskId: updated.id,
            taskKey: updated.key,
            title: updated.title,
            statusId: updated.status.id,
            statusName: updated.status.name,
            completed: updated.status.category === "done",
            selectedAtSeq: 0,
            updatedAtSeq: 0,
          }]);
    }
  };
  const chooseView = (next: BoardView) => {
    setView(next);
    updateConfig({ ...config, defaultView: next });
  };

  if (providers === null && loading === "providers") {
    return <div className="tt-board tt-loading-state" role="status"><span className="tt-spinner" /> Loading task trackers…</div>;
  }

  return (
    <div className="tt-board">
      <header className="tt-board-header">
        <div className="tt-provider-tabs" role="tablist" aria-label="Task tracker provider">
          {(["jira", "trello"] as const).map((id) => {
            const info = providers?.find((item) => item.provider === id);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={provider === id}
                className={provider === id ? "active" : ""}
                onClick={() => setProvider(id)}
              >
                {providerMark(id)}
                <span>{PROVIDER_LABELS[id]}</span>
                <i className={info?.configured ? "configured" : ""} title={info?.configured ? "Configured" : "Not configured"} />
              </button>
            );
          })}
        </div>
        <div className="tt-header-actions">
          <div className="tt-view-toggle" aria-label="Board view">
            <button
              type="button"
              className={view === "kanban" ? "active" : ""}
              aria-pressed={view === "kanban"}
              onClick={() => chooseView("kanban")}
              title="Kanban view"
            ><Icon.widgets /><span>Board</span></button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              aria-pressed={view === "list"}
              onClick={() => chooseView("list")}
              title="List view"
            ><Icon.list /><span>List</span></button>
          </div>
          <button
            type="button"
            className="tt-icon-btn"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={!boardId || loading !== null}
            aria-label="Refresh tasks"
          ><Icon.refresh /></button>
        </div>
      </header>

      {!providerInfo?.configured ? (
        <BoardEmpty
          icon={providerMark(provider)}
          title={`Connect ${PROVIDER_LABELS[provider]}`}
          body={`Restart Polyth after setting ${providerInfo?.requiredEnv.join(", ") || "the required environment variables"}. Credential values never appear in the app.`}
        />
      ) : (
        <>
          <div className="tt-board-picker">
            <label>
              <span>Workspace</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">All workspaces</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>
              <span>Board</span>
              <select
                value={boardId}
                onChange={(event) => setBoardId(event.target.value)}
                disabled={loading === "boards" || boards.length === 0}
              >
                {boards.length === 0 && <option value="">No boards found</option>}
                {boards.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.type}</option>
                ))}
              </select>
            </label>
          </div>

          {boardId && (
            <div className="tt-filters">
              <label className="tt-search">
                <Icon.search />
                <span className="sr-only">Search tasks</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search tasks"
                />
              </label>
              <label className="tt-filter-select">
                <Icon.filter />
                <span className="sr-only">Filter by status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">All statuses · {tasks.length}</option>
                  {statuses.map((status) => (
                    <option key={status.id} value={status.tasks[0]?.status.id}>
                      {status.name} · {status.tasks.length}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className={`tt-board-content${selected ? " has-detail" : ""}`}>
            <main className="tt-task-surface">
              {loading === "tasks" && tasks.length === 0 ? (
                <div className="tt-loading-state" role="status"><span className="tt-spinner" /> Loading tasks…</div>
              ) : boards.length === 0 && loading !== "boards" ? (
                <BoardEmpty icon={<Icon.widgets />} title="No boards found" body="Try another workspace or provider." />
              ) : tasks.length === 0 && boardId ? (
                <BoardEmpty icon={<Icon.check />} title="Board is clear" body="There are no open tasks on this board." />
              ) : visibleTasks.length === 0 ? (
                <BoardEmpty
                  icon={<Icon.search />}
                  title="No matching tasks"
                  body="Clear the search or choose another status."
                  action={<button type="button" onClick={() => { setQuery(""); setStatusFilter("all"); }}>Clear filters</button>}
                />
              ) : view === "kanban" ? (
                <div className="tt-kanban" aria-label={`${board?.name ?? "Task"} kanban board`}>
                  {visibleGroups.map((group) => (
                    <section className={`tt-column ${group.category}`} key={group.id}>
                      <header>
                        <span className="tt-column-dot" />
                        <strong>{group.name}</strong>
                        <span>{group.tasks.length}</span>
                      </header>
                      <div className="tt-column-cards">
                        {group.tasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            linked={linkedIds.has(`${task.provider}:${task.id}`)}
                            onOpen={openTask}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="tt-list" aria-label={`${board?.name ?? "Task"} list`}>
                  <div className="tt-list-head" aria-hidden="true">
                    <span>Task</span><span>Status</span><span>Assignee</span>
                  </div>
                  {visibleTasks.map((task) => (
                    <button
                      type="button"
                      className="tt-list-row"
                      key={task.id}
                      onClick={() => openTask(task)}
                    >
                      <span className="tt-list-title">
                        <small>{task.key}</small>
                        <strong>{task.title}</strong>
                        {linkedIds.has(`${task.provider}:${task.id}`) && <i><Icon.link /> Linked</i>}
                      </span>
                      <StatusPill status={task.status} />
                      <span className="tt-list-assignee">{task.assignees.join(", ") || "Unassigned"}</span>
                    </button>
                  ))}
                </div>
              )}
            </main>
            {selected && (
              <TaskDetail
                task={selected}
                sessionId={sessionId}
                linked={linkedIds.has(`${selected.provider}:${selected.id}`)}
                loading={detailLoading}
                onClose={() => setSelected(null)}
                onTaskChanged={updateTask}
              />
            )}
          </div>
        </>
      )}
      {error && <div className="tt-board-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>Dismiss</button></div>}
    </div>
  );
}

export function LinkedTaskWidget({ sessionId }: Pick<WidgetRenderContext, "sessionId">) {
  const [linked, setLinked] = useState<TaskTrackerSessionTaskDto | null>(null);
  const [task, setTask] = useState<TaskTrackerTaskDto | null>(null);
  const [statusId, setStatusId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId) {
      setLinked(null);
      setTask(null);
      return;
    }
    let active = true;
    const load = () => {
      setLoading(true);
      setError("");
      void api.taskTrackerSessionTasks(sessionId)
        .then(async (items) => {
          const latest = [...items].sort((a, b) => b.updatedAtSeq - a.updatedAtSeq)[0] ?? null;
          if (!active) return;
          setLinked(latest);
          if (!latest) {
            setTask(null);
            return;
          }
          const detail = await api.taskTrackerTask(latest.provider, latest.taskId);
          if (active) {
            setTask(detail);
            setStatusId(detail.status.id);
          }
        })
        .catch((cause) => {
          if (active) setError(messageOf("Couldn’t load the linked task", cause));
        })
        .finally(() => { if (active) setLoading(false); });
    };
    load();
    window.addEventListener("polyth:task-tracker-changed", load);
    return () => {
      active = false;
      window.removeEventListener("polyth:task-tracker-changed", load);
    };
  }, [sessionId]);

  const update = async (nextStatusId: string) => {
    if (!sessionId || !task || !nextStatusId || nextStatusId === task.status.id) return;
    setLoading(true);
    setError("");
    try {
      const updated = await api.taskTrackerUpdateStatus(task.provider, task.id, {
        sessionId,
        statusId: nextStatusId,
      });
      setTask(updated);
      setStatusId(updated.status.id);
      setLinked((current) => current ? {
        ...current,
        statusId: updated.status.id,
        statusName: updated.status.name,
        completed: updated.status.category === "done",
      } : current);
      changed();
    } catch (cause) {
      setError(messageOf("Couldn’t update the linked task", cause));
    } finally {
      setLoading(false);
    }
  };

  if (!sessionId) return <div className="tt-linked-empty"><Icon.link /><span>Open a session to link a Jira or Trello task.</span></div>;
  if (loading && !linked) return <div className="tt-linked-empty" role="status"><span className="tt-spinner" /> Loading linked task…</div>;
  if (!linked) return <div className="tt-linked-empty"><Icon.link /><span>No task is linked to this session yet.</span></div>;

  const status: TaskTrackerStatusDto = task?.status ?? {
    id: linked.statusId,
    name: linked.statusName,
    category: linked.completed ? "done" : "unknown",
  };
  const statuses = task?.availableStatuses ?? [];
  const doneStatus = statuses.find((item) => item.category === "done");
  return (
    <div className="tt-linked-widget">
      <div className="tt-linked-main">
        {providerMark(linked.provider)}
        <div>
          <span>{linked.taskKey}</span>
          <strong>{linked.title}</strong>
        </div>
        <StatusPill status={status} />
      </div>
      {task && statuses.length > 0 && !linked.completed && (
        <div className="tt-linked-actions">
          <select
            aria-label="Linked task status"
            value={statusId}
            disabled={loading}
            onChange={(event) => setStatusId(event.target.value)}
          >
            <option value={task.status.id}>{task.status.name}</option>
            {statuses.filter((item) => item.id !== task.status.id).map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={loading || statusId === task.status.id}
            onClick={() => void update(statusId)}
          >Update</button>
          {doneStatus && <button
            type="button"
            className="tt-complete"
            disabled={loading}
            onClick={() => void update(doneStatus.id)}
          ><Icon.check /><span>Complete</span></button>}
          {task.url && <a href={task.url} target="_blank" rel="noreferrer" aria-label={`Open ${task.key} in ${PROVIDER_LABELS[task.provider]}`}>
            <Icon.external />
          </a>}
        </div>
      )}
      {linked.completed && <div className="tt-linked-done"><Icon.check /> Completed</div>}
      {error && <p className="tt-error" role="alert">{error}</p>}
    </div>
  );
}

function TaskTrackerSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label="Task board settings">
      <label>
        <span><strong>Default view</strong></span>
        <select
          value={config.defaultView === "list" ? "list" : "kanban"}
          onChange={(event) => updateConfig({ ...config, defaultView: event.target.value })}
        >
          <option value="kanban">Kanban board</option>
          <option value="list">Task list</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.hideCompleted === true}
          onChange={(event) => updateConfig({ ...config, hideCompleted: event.target.checked })}
        />
        <span><strong>Hide completed tasks</strong></span>
      </label>
    </div>
  );
}

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "task-trackers.board": (context) => <TaskTrackerBoard {...context} />,
  "task-trackers.linked-task": (context) => <LinkedTaskWidget sessionId={context.sessionId} />,
};

export const TASK_TRACKER_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "task-trackers",
  name: "Jira & Trello",
  widgets: [
    {
      id: "task-trackers.board",
      title: "Task board",
      description: "Project-scoped Jira and Trello boards with agent handoff controls.",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right", "workspace.bottom"],
      category: "Task trackers",
      capabilities: ["polyth.taskTrackers", "jira", "trello", "kanban"],
      defaultSize: { w: 8, h: 7 },
      minSize: { w: 4, h: 4 },
      maxSize: { w: 12, h: 12 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      settingsSchema: BOARD_SETTINGS,
      render: RENDERERS["task-trackers.board"]!,
      settingsRender: (context) => <TaskTrackerSettings {...context} />,
    },
    {
      id: "task-trackers.linked-task",
      title: "Linked task",
      description: "The task selected for this coding-agent session and its current status.",
      kind: "mini-widget",
      defaultSlot: "session.composer.before",
      supportedSlots: ["session.composer.before", "workspace.header", "workspace.left", "workspace.right"],
      category: "Task trackers",
      capabilities: ["polyth.taskTrackers", "agent handoff"],
      defaultSize: { w: 5, h: 2 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 5 },
      audience: "standard",
      scope: "plugin",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["task-trackers.linked-task"]!,
      settingsRender: () => (
        <div className="builtin-widget-settings">
          <span>Uses the active session.</span>
          <small>Status changes are written to the tracker and the session event log.</small>
        </div>
      ),
    },
  ] satisfies readonly PluginWidgetDef[],
});

let uninstall: (() => void) | null = null;

export function installTaskTrackerPlugin(): () => void {
  if (uninstall) return uninstall;
  const unregister = registerWidgetPlugin(TASK_TRACKER_WIDGET_PLUGIN);
  const current = () => {
    unregister();
    if (uninstall === current) uninstall = null;
  };
  uninstall = current;
  return current;
}
