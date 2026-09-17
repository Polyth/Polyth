import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ScheduleLoopErrorDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import { openSettingsPage, useStore } from "../../../apps/web/src/store.ts";
import { formatDate, tr } from "../../../apps/web/src/i18n/index.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import {
  AddIcon,
  ChevronDownIcon,
  CloseIcon,
  GlassIsland,
  Icon,
  IconButton,
  Menu,
  Notice,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  PLANNER_FILTERS_KEY,
  filterPlannerTasks,
  groupPlannerTasks,
  parsePlannerFilters,
  presentPlannerGroups,
  serializePlannerFilters,
  type PlannerFilters,
  type PlannerGroup,
} from "../src/plannerList.ts";
import PlannerProjectPicker from "./PlannerProjectPicker.tsx";
import PlannerRunHistory from "./PlannerRunHistory.tsx";
import PlannerTaskEditor from "./PlannerTaskEditor.tsx";
import PlannerTaskRow from "./PlannerTaskRow.tsx";
import { normalizeScheduleList, resolveScheduleProjectId } from "./scheduleData.ts";

function readFilters(): PlannerFilters {
  try {
    return parsePlannerFilters(sessionStorage.getItem(PLANNER_FILTERS_KEY));
  } catch {
    return parsePlannerFilters(null);
  }
}

function persistFilters(filters: PlannerFilters): void {
  try {
    sessionStorage.setItem(PLANNER_FILTERS_KEY, serializePlannerFilters(filters));
  } catch { /* private mode / quota — presentation-only */ }
}

function groupLabel(group: PlannerGroup<ScheduleTaskDto>): string {
  if (group.kind === "today") return tr("scheduleview.today");
  if (group.kind === "tomorrow") return tr("scheduleview.tomorrow");
  if (group.kind === "paused") return tr("scheduleview.paused");
  if (group.kind === "unscheduled") return tr("scheduleview.noUpcomingRun");
  if (group.kind === "completed") return tr("scheduleview.recentlyCompleted");
  if (group.dateKey) {
    return formatDate(`${group.dateKey}T12:00:00`, { month: "short", day: "numeric" });
  }
  return group.id;
}

function filteredEmptyTitle(status: PlannerFilters["status"]): string {
  if (status === "active") return tr("scheduleview.noActiveTasks");
  if (status === "paused") return tr("scheduleview.noPausedTasks");
  return tr("scheduleview.noMatchingTasks");
}

function PlannerGroupSection({
  group,
  defaultOpen,
  children,
}: {
  group: PlannerGroup<ScheduleTaskDto>;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const collapsible = group.kind === "paused" || group.kind === "completed";
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen, group.id]);
  const label = groupLabel(group);
  if (!collapsible) {
    return (
      <section className="planner-group">
        <h3 className="planner-group-title">{label}</h3>
        {children}
      </section>
    );
  }
  return (
    <section className={`planner-group is-secondary${open ? "" : " is-collapsed"}`}>
      <button
        type="button"
        className="planner-group-title is-toggle"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{label}</span>
        <span className="planner-group-trail">
          <span className="planner-group-count">{group.tasks.length}</span>
          <Icon icon={ChevronDownIcon} size="sm" />
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

export default function PlannerView() {
  const projects = useStore((state) => state.projectRegistry.projects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const [filters, setFilters] = useState<PlannerFilters>(readFilters);
  const [tasks, setTasks] = useState<ScheduleTaskDto[]>([]);
  const [loopErrors, setLoopErrors] = useState<ScheduleLoopErrorDto[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleTaskDto | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduleTaskDto | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const loadGen = useRef(0);
  const projectFilterRef = useRef<HTMLButtonElement>(null);

  const updateFilters = (next: PlannerFilters) => {
    setFilters(next);
    persistFilters(next);
  };

  const reload = useCallback(() => {
    const ticket = ++loadGen.current;
    void api.scheduleList()
      .then((response) => {
        if (ticket !== loadGen.current) return;
        const normalized = normalizeScheduleList(response);
        setTasks(normalized.tasks);
        setLoopErrors(normalized.loopErrors);
        setError("");
        setNotice("");
        setNow(Date.now());
      })
      .catch((cause) => {
        if (ticket !== loadGen.current) return;
        const message = tr("scheduleview.couldNotLoadValue", {
          value: cause instanceof Error ? cause.message : String(cause),
        });
        setError(message);
      });
    return () => {
      if (ticket === loadGen.current) loadGen.current += 1;
    };
  }, []);

  useEffect(() => {
    const cancel = reload();
    const timer = setInterval(() => { reload(); }, 15_000);
    return () => {
      cancel();
      clearInterval(timer);
    };
  }, [reload]);

  const visible = useMemo(() => filterPlannerTasks(tasks, filters), [tasks, filters]);
  const groups = useMemo(
    () => presentPlannerGroups(groupPlannerTasks(visible, now)),
    [visible, now],
  );
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const selectedProject = filters.projectId ? projectById.get(filters.projectId) : undefined;
  const projectTrigger = filters.projectId
    ? selectedProject?.name || selectedProject?.path || tr("scheduleview.unavailableProject")
    : tr("scheduleview.allProjects");
  const statusLabel = filters.status === "active"
    ? tr("scheduleview.active")
    : filters.status === "paused"
      ? tr("scheduleview.paused")
      : tr("scheduleview.all");

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (task: ScheduleTaskDto) => {
    setEditing(task);
    setEditorOpen(true);
  };

  const rescan = async () => {
    const ids = filters.projectId ? [filters.projectId] : projects.map((project) => project.id);
    try {
      const errors: ScheduleLoopErrorDto[] = [];
      for (const projectId of ids) {
        const result = await api.scheduleLoopsRescan(projectId);
        errors.push(...result.errors);
      }
      setLoopErrors(errors);
      setNotice("");
      reload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const dismissError = async (path: string) => {
    const ids = filters.projectId ? [filters.projectId] : projects.map((project) => project.id);
    for (const projectId of ids) {
      try {
        const result = await api.scheduleLoopErrorDismiss(projectId, path);
        if (result.ok) break;
      } catch { /* try the next known project */ }
    }
    reload();
  };

  const agendaEmpty = groups.every((group) => group.kind === "paused" || group.kind === "completed");
  const filterEntries: MenuEntry[] = [
    {
      id: "all",
      label: tr("scheduleview.all"),
      kind: "radio",
      checked: filters.status === "all",
      onSelect: () => updateFilters({ ...filters, status: "all" }),
    },
    {
      id: "active",
      label: tr("scheduleview.active"),
      kind: "radio",
      checked: filters.status === "active",
      onSelect: () => updateFilters({ ...filters, status: "active" }),
    },
    {
      id: "paused",
      label: tr("scheduleview.paused"),
      kind: "radio",
      checked: filters.status === "paused",
      onSelect: () => updateFilters({ ...filters, status: "paused" }),
    },
    "separator",
    {
      id: "rescan",
      label: tr("scheduleview.rescanLoops"),
      onSelect: () => void rescan(),
    },
  ];

  if (projects.length === 0) {
    return (
      <div className="schedule-page">
        <div className="planner-canvas">
          <EmptyState
            title={tr("scheduleview.noProjectsYet")}
            description={tr("scheduleview.openOrCreateAProjectToPlan")}
            actionLabel={tr("scheduleview.openProjects")}
            onAction={() => openSettingsPage("projects")}
          />
        </div>
      </div>
    );
  }

  if (error && tasks.length === 0) {
    return (
      <div className="schedule-page">
        <div className="planner-canvas">
          <EmptyState
            title={error}
            actionLabel={tr("common.retry")}
            onAction={() => reload()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="schedule-page">
      <div className="planner-canvas">
      <div className="planner-toolbar">
        <GlassIsland strength="chrome" className="planner-chrome">
        <button
          ref={projectFilterRef}
          type="button"
          className="planner-filter-btn"
          aria-haspopup="dialog"
          aria-expanded={projectOpen}
          onClick={() => setProjectOpen(true)}
        >
          <span className="planner-filter-label">{projectTrigger}</span>
          <Icon icon={ChevronDownIcon} size="sm" />
        </button>
        <Menu
          label={tr("scheduleview.status")}
          title={tr("scheduleview.status")}
          align="start"
          entries={filterEntries}
        >
          {(trigger) => (
            <button
              type="button"
              className={`planner-status-btn${filters.status === "all" ? " is-default" : ""}`}
              aria-label={tr("scheduleview.status")}
              {...trigger}
            >
              <span className="planner-status-label">{statusLabel}</span>
              <Icon icon={ChevronDownIcon} size="sm" />
            </button>
          )}
        </Menu>
        <div className="planner-toolbar-actions">
        <IconButton
          icon={AddIcon}
          label={tr("scheduleview.createATask")}
          onClick={openCreate}
        />
        </div>
        </GlassIsland>
      </div>
      {notice && (
        <Notice tone="error">{notice}</Notice>
      )}
      {error && tasks.length > 0 && (
        <Notice tone="error">{error}</Notice>
      )}
      {loopErrors.length > 0 && (
        <div className="planner-notices">
          {loopErrors.map((item) => (
            <Notice
              key={item.path}
              tone="warning"
              actions={(
                <IconButton
                  icon={CloseIcon}
                  label={tr("scheduleview.dismissLoopErrorForValue", { path: item.path })}
                  title={tr("scheduleview.dismissUntilThisFileSErrorChanges")}
                  onClick={() => void dismissError(item.path)}
                />
              )}
            >
              {item.error}
            </Notice>
          ))}
        </div>
      )}
      {tasks.length === 0 && (
        <EmptyState
          title={tr("scheduleview.noScheduledTasks")}
          actionLabel={tr("scheduleview.createATask")}
          onAction={openCreate}
        />
      )}
      {tasks.length > 0 && visible.length === 0 && (
        <EmptyState variant="compact" title={filteredEmptyTitle(filters.status)} />
      )}
      {tasks.length > 0 && visible.length > 0 && agendaEmpty && filters.status !== "paused" && (
        <EmptyState
          variant="compact"
          title={tr("scheduleview.noScheduledTasks")}
          actionLabel={tr("scheduleview.createATask")}
          onAction={openCreate}
        />
      )}
      {groups.map((group) => (
        <PlannerGroupSection
          key={group.id}
          group={group}
          defaultOpen={
            (group.kind !== "paused" && group.kind !== "completed")
            || (group.kind === "paused" && filters.status === "paused")
          }
        >
          {group.tasks.map((task) => (
            <PlannerTaskRow
              key={task.id}
              task={task}
              project={projectById.get(task.projectId)}
              groupKind={group.kind}
              now={now}
              onEdit={() => openEdit(task)}
              onViewRuns={() => setHistoryTask(task)}
              onChanged={() => reload()}
            />
          ))}
        </PlannerGroupSection>
      ))}
      </div>
      <PlannerProjectPicker
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        anchorRef={projectFilterRef}
        projects={projects}
        value={filters.projectId}
        includeAll
        onChange={(projectId) => updateFilters({ ...filters, projectId })}
        title={tr("scheduleview.project")}
      />
      <PlannerTaskEditor
        open={editorOpen}
        task={editing}
        projects={projects}
        defaultProjectId={resolveScheduleProjectId(projects, activeProjectId, filters.projectId) || null}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSaved={() => reload()}
        onViewRuns={(next) => setHistoryTask(next)}
      />
      <PlannerRunHistory task={historyTask} onClose={() => setHistoryTask(null)} />
    </div>
  );
}
