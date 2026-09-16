import { memo, useEffect, useMemo, useState } from "react";
import type { Project } from "@polyth/contracts";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Badge,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  IconButton,
  Menu,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  Switch,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { taskDisplayTitle, type PlannerGroupKind } from "../src/plannerList.ts";
import { cadenceOfTask, formatTaskTime, isLoopFile, recurrenceSummary } from "./plannerShared.ts";
import { PlannerProjectMark } from "./PlannerProjectPicker.tsx";
import { isCompletedOnce, plannerRowShowsActiveSwitch } from "../src/plannerTask.ts";
import {
  deletePlannerTask,
  duplicatePlannerTask,
  pausePlannerTask,
  runPlannerTask,
} from "./plannerTaskActions.ts";

function PlannerTaskRow({
  task,
  project,
  groupKind,
  now,
  onEdit,
  onViewRuns,
  onChanged,
}: {
  task: ScheduleTaskDto;
  project: Project | undefined;
  groupKind: PlannerGroupKind;
  now: number;
  onEdit: () => void;
  onViewRuns: () => void;
  onChanged: () => void;
}) {
  const loopFile = isLoopFile(task);
  const [enabled, setEnabled] = useState(task.enabled);
  useEffect(() => { setEnabled(task.enabled); }, [task.enabled, task.id]);

  const title = taskDisplayTitle(task);
  const cadence = cadenceOfTask(task);
  const summary = useMemo(() => recurrenceSummary(cadence, { includeTime: false }), [cadence]);
  const projectLabel = project?.name || project?.path || tr("scheduleview.unavailableProject");
  const completed = isCompletedOnce(task);
  const showActiveSwitch = plannerRowShowsActiveSwitch(task);
  const timeLabel = formatTaskTime(task.nextRunAt ?? 0, now, groupKind);

  const toggle = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    const ok = await pausePlannerTask(task.id, !next);
    if (!ok) setEnabled(previous);
    else onChanged();
  };

  const entries: MenuEntry[] = [
    { id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void runPlannerTask(task.id).then((ok) => { if (ok) onChanged(); }) },
    { id: "edit", label: tr("common.edit"), icon: EditIcon, onSelect: onEdit },
    { id: "runs", label: tr("scheduleview.viewRuns"), onSelect: onViewRuns },
    ...(!loopFile
      ? [{ id: "duplicate", label: tr("scheduleview.duplicate"), icon: CopyIcon, onSelect: () => void duplicatePlannerTask(task).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry]
      : []),
    ...(!completed
      ? [{
          id: "toggle",
          label: enabled ? tr("common.pause") : tr("scheduleview.activate"),
          icon: enabled ? PauseIcon : PlayIcon,
          onSelect: () => void toggle(!enabled),
        } satisfies MenuEntry]
      : []),
    ...(!loopFile
      ? [
          "separator" as const,
          { id: "delete", label: tr("common.delete"), icon: DeleteIcon, danger: true, onSelect: () => void deletePlannerTask(task).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry,
        ]
      : []),
  ];

  return (
    <div className={`planner-task${enabled ? "" : " is-paused"}${completed ? " is-completed" : ""}`}>
      <span className="planner-task-time">{timeLabel}</span>
      <button type="button" className="planner-task-main" onClick={onEdit}>
        <span className="planner-task-title" title={title}>
          {loopFile && (
            <span title={tr("scheduleview.managedByLoopFile")}>
              <Badge tone="accent">{tr("scheduleview.loop")}</Badge>
            </span>
          )}
          {title}
        </span>
        <span className={`planner-task-meta${project ? "" : " is-unavailable"}`}>
          {project && (
            <span className="planner-project-mark" style={project.color ? { color: project.color } : undefined}>
              <PlannerProjectMark project={project} />
            </span>
          )}
          <span className="planner-task-meta-copy">
            {projectLabel}
            <span aria-hidden="true"> · </span>
            {summary}
          </span>
        </span>
        {task.parseError && <span className="planner-task-error">{task.parseError}</span>}
        {task.lastError && <span className="planner-task-error">{tr("scheduleview.lastRunFailed")} {task.lastError}</span>}
      </button>
      <div className="planner-task-tools">
        {showActiveSwitch && (
          <Switch
            checked={enabled}
            onChange={(next) => void toggle(next)}
            label={tr("scheduleview.taskActive")}
          />
        )}
        <Menu label={tr("scheduleview.plannerActions")} align="end" entries={entries}>
          {(trigger) => (
            <IconButton icon={MoreIcon} label={tr("scheduleview.plannerActions")} {...trigger} />
          )}
        </Menu>
      </div>
    </div>
  );
}

export default memo(PlannerTaskRow);
