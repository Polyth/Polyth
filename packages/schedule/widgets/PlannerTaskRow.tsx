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
  reviewLoopVersion,
  runPlannerTask,
} from "./plannerTaskActions.ts";

type LoopTrustView = ScheduleTaskDto & {
  sourcePath?: string;
  sourceDigest?: string;
  trustState?: "untrusted" | "trusted-current-version" | "changed-since-trust";
  trustReceipt?: { contentDigest: string; approvedAt: number };
  pendingVersion?: { changedFields: string[]; observedAt: number };
  rejectedSourceDigest?: string;
};

function repositorySourceLabel(path: string | undefined): string {
  if (!path) return ".agents/loops";
  const normalized = path.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("/.agents/");
  return marker >= 0 ? normalized.slice(marker + 1) : normalized.split("/").at(-1) ?? path;
}

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
  const loopTask = task as LoopTrustView;
  const trustPending = loopFile && loopTask.trustState !== "trusted-current-version";
  const explicitlyBlocked = trustPending
    && !!loopTask.sourceDigest
    && loopTask.rejectedSourceDigest === loopTask.sourceDigest;
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

  const review = (action: "trust-current" | "run-once" | "reject") => {
    void reviewLoopVersion(task.id, action).then((ok) => { if (ok) onChanged(); });
  };

  const trustEntries: MenuEntry[] = trustPending
    ? [
        { id: "trust-current", label: "Trust this version", icon: PlayIcon, onSelect: () => review("trust-current") },
        { id: "run-once", label: "Run this version once", icon: PlayIcon, onSelect: () => review("run-once") },
        { id: "reject-version", label: "Keep blocked", icon: PauseIcon, onSelect: () => review("reject") },
        "separator",
      ]
    : [];

  const entries: MenuEntry[] = [
    ...trustEntries,
    ...(!trustPending
      ? [{ id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void runPlannerTask(task.id).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry]
      : []),
    { id: "edit", label: tr("common.edit"), icon: EditIcon, onSelect: onEdit },
    { id: "runs", label: tr("scheduleview.viewRuns"), onSelect: onViewRuns },
    ...(!loopFile
      ? [{ id: "duplicate", label: tr("scheduleview.duplicate"), icon: CopyIcon, onSelect: () => void duplicatePlannerTask(task).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry]
      : []),
    ...(!completed && !trustPending
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

  const oldDigest = loopTask.trustReceipt?.contentDigest;
  const newDigest = loopTask.sourceDigest;
  const changedFields = loopTask.pendingVersion?.changedFields ?? [];

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
          {trustPending && (
            <Badge tone="accent">{explicitlyBlocked ? "Blocked" : "Review required"}</Badge>
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
        {trustPending && (
          <span
            className="planner-task-error"
            title={loopTask.sourcePath}
          >
            {repositorySourceLabel(loopTask.sourcePath)}
            {oldDigest && newDigest ? ` · ${oldDigest.slice(0, 8)} → ${newDigest.slice(0, 8)}` : newDigest ? ` · ${newDigest.slice(0, 8)}` : ""}
            {changedFields.length ? ` · ${changedFields.join(", ")}` : ""}
          </span>
        )}
        {task.parseError && <span className="planner-task-error">{task.parseError}</span>}
        {task.lastError && <span className="planner-task-error">{tr("scheduleview.lastRunFailed")} {task.lastError}</span>}
      </button>
      <div className="planner-task-tools">
        {showActiveSwitch && !trustPending && (
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
