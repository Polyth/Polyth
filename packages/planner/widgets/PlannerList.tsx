import { memo, useEffect, useMemo, useState } from "react";
import type { Project } from "@polyth/contracts";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";
import {
  AddIcon,
  Button,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  ProjectPicker,
  ScheduleIcon,
  Switch,
  Tabs,
  WarningIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import type { PlannerTask } from "../src/model.ts";
import { formatRelative, viewToCadence } from "../src/cadenceView.ts";
import {
  groupPlannerTasks,
  isPlannerTaskActive,
  taskDisplayTitle,
  type PlannerGroup,
} from "../src/plannerList.ts";
import { cadenceOfTask, isCompletedOnce } from "../src/plannerTask.ts";
import { deleteTask, duplicateTask, runTask, setTaskPaused } from "./plannerActions.ts";
import { cadenceSummary, formatClockAt, formatDayHeading } from "./plannerFormat.ts";
import { PLANNER_TEMPLATES, type PlannerTemplate } from "./plannerTemplates.ts";
import { t } from "./plannerText.ts";

export type PlannerTab = "upcoming" | "paused" | "done";

function ProjectMark({ project }: { project: Project }) {
  return (
    <span className="planner-project-mark" style={project.color ? { color: project.color } : undefined}>
      <ProjectGlyph project={project} maskClassName="planner-project-mask project-glyph-mask" />
    </span>
  );
}

const PlannerRow = memo(function PlannerRow({
  task,
  project,
  showProject,
  dated,
  locale,
  fresh,
  onOpen,
  onChanged,
}: {
  task: PlannerTask;
  project: Project | undefined;
  showProject: boolean;
  dated: boolean;
  locale: string;
  fresh: boolean;
  onOpen: (task: PlannerTask) => void;
  onChanged: (task?: PlannerTask) => void;
}) {
  const [enabled, setEnabled] = useState(task.enabled);
  useEffect(() => { setEnabled(task.enabled); }, [task.enabled, task.id]);
  const completed = isCompletedOnce(task);
  const running = task.history?.[0]?.status === "running";
  const title = taskDisplayTitle(task);
  const summary = cadenceSummary(cadenceOfTask(task), locale, dated);
  const time = dated && task.nextRunAt !== null ? formatClockAt(task.nextRunAt, locale) : "";

  const toggle = async (next: boolean) => {
    setEnabled(next);
    const updated = await setTaskPaused(task, !next);
    if (!updated) setEnabled(!next);
    onChanged(updated);
  };
  const entries: MenuEntry[] = [
    { id: "run", label: t("action.runNow"), icon: PlayIcon, onSelect: () => void runTask(task).then(onChanged) },
    { id: "edit", label: t("action.edit"), icon: EditIcon, onSelect: () => onOpen(task) },
    { id: "duplicate", label: t("action.duplicate"), icon: CopyIcon, onSelect: () => void duplicateTask(task).then(onChanged) },
    ...(!completed ? [{
      id: "toggle",
      label: enabled ? t("action.pause") : t("action.resume"),
      icon: enabled ? PauseIcon : PlayIcon,
      onSelect: () => void toggle(!enabled),
    } satisfies MenuEntry] : []),
    "separator",
    { id: "delete", label: t("action.delete"), icon: DeleteIcon, danger: true, onSelect: () => void deleteTask(task).then((ok) => { if (ok) onChanged(); }) },
  ];

  return (
    <li
      className={`planner-row${enabled ? "" : " is-paused"}${completed ? " is-done" : ""}${fresh ? " is-fresh" : ""}`}
      data-running={running || undefined}
    >
      <button type="button" className="planner-row-main" data-dated={dated || undefined} onClick={() => onOpen(task)}>
        {dated && <span className="planner-row-time">{time}</span>}
        <span className="planner-row-body">
          <span className="planner-row-title">{title}</span>
          <span className="planner-row-meta">
            {running && <span className="planner-live"><span className="planner-live-dot" aria-hidden="true" />{t("list.running")}</span>}
            {running && <span className="planner-sep" aria-hidden="true">·</span>}
            <span className="planner-row-cadence">{summary}</span>
            {showProject && <span className="planner-sep" aria-hidden="true">·</span>}
            {showProject && (
              <span className="planner-row-project">
                {project && <ProjectMark project={project} />}
                <span className="planner-row-project-name">{project?.name || project?.path || t("list.unavailableProject")}</span>
              </span>
            )}
          </span>
          {task.lastError && !running && (
            <span className="planner-row-error">
              <Icon icon={WarningIcon} size="sm" />
              <span>{t("list.lastFailed")}</span>
            </span>
          )}
        </span>
      </button>
      <div className="planner-row-tools">
        {!completed && <Switch checked={enabled} onChange={(next) => void toggle(next)} label={t("list.active")} />}
        <Menu label={t("list.taskActions")} align="end" entries={entries}>
          {(trigger) => <IconButton icon={MoreIcon} size="sm" label={t("list.taskActions")} {...trigger} />}
        </Menu>
      </div>
    </li>
  );
});

function NextUp({ task, project, showProject, locale, now, onOpen, onChanged }: {
  task: PlannerTask;
  project: Project | undefined;
  showProject: boolean;
  locale: string;
  now: number;
  onOpen: (task: PlannerTask) => void;
  onChanged: (task?: PlannerTask) => void;
}) {
  const due = task.nextRunAt !== null && task.nextRunAt <= now + 30_000;
  const running = task.history?.[0]?.status === "running";
  return (
    <section className="planner-next" aria-label={t("list.nextUp")} data-running={running || undefined}>
      <button type="button" className="planner-next-main" onClick={() => onOpen(task)}>
        <span className="planner-next-eyebrow">
          {running && <span className="planner-live-dot" aria-hidden="true" />}
          {t("list.nextUp")}
        </span>
        <span className="planner-next-when">
          {running ? t("list.running") : due ? t("list.dueNow") : formatRelative(task.nextRunAt!, now, locale)}
        </span>
        <span className="planner-next-title">{taskDisplayTitle(task)}</span>
        <span className="planner-next-meta">
          <span className="planner-next-clock">{formatClockAt(task.nextRunAt!, locale)}</span>
          <span className="planner-sep" aria-hidden="true">·</span>
          <span>{cadenceSummary(cadenceOfTask(task), locale, true)}</span>
          {showProject && project && <span className="planner-sep" aria-hidden="true">·</span>}
          {showProject && project && (
            <span className="planner-next-project">
              <ProjectMark project={project} />
              <span className="planner-row-project-name">{project.name || project.path}</span>
            </span>
          )}
        </span>
      </button>
      <Button size="sm" iconStart={PlayIcon} className="planner-next-run" onClick={() => void runTask(task).then(onChanged)}>
        {t("action.runNow")}
      </Button>
    </section>
  );
}

function groupTitle(group: PlannerGroup<PlannerTask>, locale: string): string {
  if (group.kind === "today") return t("list.today");
  if (group.kind === "tomorrow") return t("list.tomorrow");
  if (group.kind === "unscheduled") return t("list.noNextRun");
  if (group.dateKey) return formatDayHeading(group.dateKey, locale);
  return "";
}

export function PlannerWelcome({ locale, onCreate, onTemplate }: {
  locale: string;
  onCreate: () => void;
  onTemplate: (template: PlannerTemplate) => void;
}) {
  return (
    <div className="planner-welcome">
      <span className="planner-welcome-mark" aria-hidden="true"><Icon icon={ScheduleIcon} size="xl" /></span>
      <h2 className="planner-welcome-title">{t("list.emptyTitle")}</h2>
      <p className="planner-welcome-body">{t("list.emptyBody")}</p>
      <Button variant="primary" size="lg" iconStart={AddIcon} onClick={onCreate}>{t("list.newTask")}</Button>
      <div className="planner-templates">
        <span className="planner-field-label">{t("list.startFrom")}</span>
        <ul className="planner-template-list">
          {PLANNER_TEMPLATES.map((template) => (
            <li key={template.id}>
              <button type="button" className="planner-template" onClick={() => onTemplate(template)}>
                <span className="planner-template-title">{t(template.title)}</span>
                <span className="planner-template-when">{cadenceSummary(viewToCadence(template.view()), locale)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PlannerList({
  tasks,
  projects,
  projectId,
  tab,
  locale,
  now,
  freshId,
  onProject,
  onTab,
  onOpen,
  onCreate,
  onTemplate,
  onChanged,
}: {
  tasks: readonly PlannerTask[];
  projects: readonly Project[];
  projectId: string | null;
  tab: PlannerTab;
  locale: string;
  now: number;
  freshId: string | null;
  onProject: (projectId: string | null) => void;
  onTab: (tab: PlannerTab) => void;
  onOpen: (task: PlannerTask) => void;
  onCreate: () => void;
  onTemplate: (template: PlannerTemplate) => void;
  onChanged: (task?: PlannerTask) => void;
}) {
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const scoped = useMemo(
    () => (projectId ? tasks.filter((task) => task.projectId === projectId) : tasks),
    [tasks, projectId],
  );
  const groups = useMemo(() => groupPlannerTasks(scoped, now), [scoped, now]);
  const upcoming = groups.filter((group) => group.kind !== "paused" && group.kind !== "completed");
  const paused = groups.find((group) => group.kind === "paused")?.tasks ?? [];
  const done = (groups.find((group) => group.kind === "completed")?.tasks ?? [])
    .slice()
    .sort((a, b) => (b.lastRunAt ?? b.updatedAt) - (a.lastRunAt ?? a.updatedAt));
  const upcomingCount = upcoming.reduce((sum, group) => sum + group.tasks.length, 0);
  const next = tab === "upcoming"
    ? scoped.filter(isPlannerTaskActive).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))[0]
    : undefined;
  const showProject = projectId === null && projects.length > 1;

  const row = (task: PlannerTask, dated: boolean) => (
    <PlannerRow
      key={task.id}
      task={task}
      project={projectById.get(task.projectId)}
      showProject={showProject}
      dated={dated}
      locale={locale}
      fresh={freshId === task.id}
      onOpen={onOpen}
      onChanged={onChanged}
    />
  );
  const count = (value: number) => value > 0 ? <span className="planner-tab-count">{value}</span> : null;

  return (
    <div className="planner-list-view">
      <div className="planner-toolbar">
        <ProjectPicker
          className="planner-scope"
          label={t("list.project")}
          projects={projects}
          value={projectId ?? ""}
          allLabel={t("list.allProjects")}
          emptyMessage={t("list.noProjects")}
          onPick={(id) => onProject(id || null)}
        />
        <Button variant="primary" size="sm" iconStart={AddIcon} className="planner-new" onClick={onCreate}>
          {t("list.new")}
        </Button>
      </div>

      {scoped.length === 0 ? (
        <>
          {tasks.length > 0 && (
            <div className="planner-elsewhere">
              <span>{t("list.elsewhere", { count: tasks.length })}</span>
              <button type="button" className="planner-link" onClick={() => onProject(null)}>{t("list.showAll")}</button>
            </div>
          )}
          <PlannerWelcome locale={locale} onCreate={onCreate} onTemplate={onTemplate} />
        </>
      ) : (
        <>
          <Tabs
            className="planner-tabs"
            label={t("list.filter")}
            value={tab}
            tabs={[
              { id: "upcoming", label: <span className="planner-tab-label"><span className="planner-tab-text">{t("list.upcoming")}</span>{count(upcomingCount)}</span> },
              { id: "paused", label: <span className="planner-tab-label"><span className="planner-tab-text">{t("list.paused")}</span>{count(paused.length)}</span> },
              { id: "done", label: <span className="planner-tab-label"><span className="planner-tab-text">{t("list.done")}</span>{count(done.length)}</span> },
            ]}
            onChange={(id) => onTab(id as PlannerTab)}
          />

          {next && (
            <NextUp
              task={next}
              project={projectById.get(next.projectId)}
              showProject={showProject}
              locale={locale}
              now={now}
              onOpen={onOpen}
              onChanged={onChanged}
            />
          )}

          {tab === "upcoming" && (upcoming.length === 0 ? (
            <div className="planner-quiet">
              <p className="planner-quiet-title">{t("list.noUpcoming")}</p>
              <p className="planner-quiet-body">{t("list.noUpcomingBody")}</p>
            </div>
          ) : upcoming.map((group) => (
            <section key={group.id} className="planner-group" aria-label={groupTitle(group, locale)}>
              <h3 className="planner-group-title">
                <span className="planner-group-label">{groupTitle(group, locale)}</span>
                <span className="planner-group-count">{group.tasks.length}</span>
              </h3>
              <ul className="planner-rows">
                {group.tasks.map((task) => row(task, group.kind !== "unscheduled"))}
              </ul>
            </section>
          )))}

          {tab === "paused" && (paused.length === 0
            ? <div className="planner-quiet"><p className="planner-quiet-title">{t("list.noPaused")}</p></div>
            : <ul className="planner-rows planner-rows--flat">{paused.map((task) => row(task, false))}</ul>)}

          {tab === "done" && (done.length === 0
            ? <div className="planner-quiet"><p className="planner-quiet-title">{t("list.noDone")}</p></div>
            : <ul className="planner-rows planner-rows--flat">{done.map((task) => row(task, false))}</ul>)}
        </>
      )}
    </div>
  );
}
