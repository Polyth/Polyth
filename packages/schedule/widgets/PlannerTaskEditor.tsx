import { useEffect, useMemo, useState } from "react";
import type { Project } from "@polyth/contracts";
import { api, type ScheduleTaskDto } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ChevronRightIcon,
  confirmAlert,
  CopyIcon,
  DeleteIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  Notice,
  PlayIcon,
  ResponsiveOverlay,
  Switch,
  Tabs,
  Textarea,
  TextInput,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  cadencesEqual,
  cadenceToView,
  defaultOnceView,
  defaultWeeklyView,
  validateCadenceView,
  viewToCadence,
  weeklyViewFromOnce,
  type CadenceView,
} from "../src/cadenceView.ts";
import PlannerOnceSheet from "./PlannerOnceSheet.tsx";
import PlannerProjectPicker, { PlannerProjectMark } from "./PlannerProjectPicker.tsx";
import PlannerRecurrenceSheet from "./PlannerRecurrenceSheet.tsx";
import PlannerRunBehaviorSheet, { type Overlap, type TargetMode } from "./PlannerRunBehaviorSheet.tsx";
import { cadenceOfTask, formatOnceWhen, isLoopFile, recurrenceSummary } from "./plannerShared.ts";
import {
  canSubmitPlannerEditor,
  isCompletedOnce,
  sessionIdAfterProjectChange,
} from "../src/plannerTask.ts";
import {
  deletePlannerTask,
  duplicatePlannerTask,
  runPlannerTask,
} from "./plannerTaskActions.ts";

type RecurrenceView = Extract<CadenceView, { mode: "weekly" | "monthly" }>;

function behaviorSummary(targetMode: TargetMode, overlap: Overlap): string {
  const session = targetMode === "existing-session"
    ? tr("scheduleview.existingSession")
    : targetMode === "dedicated-session"
      ? tr("scheduleview.reuseSession")
      : tr("scheduleview.newSessionPerRun");
  const running = overlap === "queue"
    ? tr("scheduleview.queueAfter")
    : overlap === "parallel"
      ? tr("scheduleview.runAnyway")
      : tr("scheduleview.skipThisRun");
  return `${session} · ${running}`;
}

export default function PlannerTaskEditor({
  open,
  task,
  projects,
  defaultProjectId,
  onClose,
  onSaved,
  onViewRuns,
}: {
  open: boolean;
  task: ScheduleTaskDto | null;
  projects: readonly Project[];
  defaultProjectId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onViewRuns?: (task: ScheduleTaskDto) => void;
}) {
  const isEdit = task !== null;
  const loopFile = task ? isLoopFile(task) : false;
  const allSessions = useStore((state) => state.sessions);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [view, setView] = useState<CadenceView>(() => defaultOnceView());
  const [originalCadence, setOriginalCadence] = useState<ReturnType<typeof cadenceOfTask>>(null);
  const [converted, setConverted] = useState(false);
  const [targetMode, setTargetMode] = useState<TargetMode>("new-session-per-run");
  const [sessionId, setSessionId] = useState("");
  const [overlap, setOverlap] = useState<Overlap>("skip");
  const [projectOpen, setProjectOpen] = useState(false);
  const [onceOpen, setOnceOpen] = useState(false);
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const [hasRunning, setHasRunning] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState("");

  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === projectId && session.status !== "archived"),
    [allSessions, projectId],
  );
  const project = projects.find((item) => item.id === projectId);
  const locale = getLocale();
  const scheduleTab = view.mode === "once" ? "once" : "every";
  const showNormalSchedule = view.mode === "once" || view.mode === "weekly" || view.mode === "monthly" || converted;
  const validation = validateCadenceView(view);
  const snapshot = JSON.stringify({
    projectId, prompt, enabled, view, targetMode, sessionId, overlap,
  });
  const dirty = snapshot !== baseline;
  const canSubmit = canSubmitPlannerEditor({
    projectId,
    prompt,
    cadenceOk: validation.ok,
    targetMode,
    sessionId,
    sessionsInProject: sessions,
    isEdit,
    dirty,
  });

  const resetFrom = (next: ScheduleTaskDto | null) => {
    const cadence = next ? cadenceOfTask(next) : null;
    const nextView = next && cadence
      ? cadenceToView(cadence, locale)
      : defaultOnceView();
    const mode = next?.target?.mode ?? (next?.sessionId ? "existing-session" : "new-session-per-run");
    const nextProject = next?.projectId ?? defaultProjectId ?? "";
    const nextPrompt = next?.prompt ?? "";
    const nextEnabled = next?.enabled ?? true;
    const nextSession = next?.target?.sessionId ?? next?.sessionId ?? "";
    const nextOverlap = (next?.overlapPolicy ?? "skip") as Overlap;
    setProjectId(nextProject);
    setPrompt(nextPrompt);
    setEnabled(nextEnabled);
    setView(nextView);
    setOriginalCadence(cadence);
    setConverted(false);
    setTargetMode(mode);
    setSessionId(nextSession);
    setOverlap(nextOverlap);
    setError("");
    setHasRunning(false);
    setOnceOpen(false);
    setRecurrenceOpen(false);
    setBehaviorOpen(false);
    setProjectOpen(false);
    setBaseline(JSON.stringify({
      projectId: nextProject,
      prompt: nextPrompt,
      enabled: nextEnabled,
      view: nextView,
      targetMode: mode,
      sessionId: nextSession,
      overlap: nextOverlap,
    }));
  };

  useEffect(() => {
    if (!open) return;
    resetFrom(task);
  }, [open, task?.id]);

  useEffect(() => {
    if (!open || !task) {
      setHasRunning(false);
      return;
    }
    let active = true;
    void api.scheduleRuns(task.id, 20)
      .then((runs) => {
        if (active) setHasRunning(runs.some((run) => run.status === "running"));
      })
      .catch(() => {
        if (active) setHasRunning(false);
      });
    return () => { active = false; };
  }, [open, task]);

  const requestClose = async () => {
    if (dirty) {
      const discard = await confirmAlert(tr("scheduleview.unsavedChanges"), {
        title: tr("common.discardChanges"),
        confirmLabel: tr("common.discard"),
        destructive: true,
      });
      if (!discard) return;
    }
    onClose();
  };

  const convertToEvery = () => {
    setConverted(true);
    if (view.mode === "weekly" || view.mode === "monthly") return;
    if (view.mode === "once" && Number.isFinite(view.at)) {
      setView(weeklyViewFromOnce(view.at));
      return;
    }
    setView(defaultWeeklyView());
  };

  const save = async () => {
    if (!canSubmit || busy) return;
    if (loopFile && task) {
      setBusy(true);
      try {
        await api.schedulePause(task.id, !enabled);
        onSaved();
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    const cadence = viewToCadence(view);
    const payload = {
      projectId,
      prompt: prompt.trim(),
      target: {
        mode: targetMode,
        ...(targetMode === "existing-session" && sessionId ? { sessionId } : {}),
      } as const,
      overlapPolicy: overlap,
      enabled,
    };
    setBusy(true);
    setError("");
    try {
      if (!isEdit || !task) {
        await api.scheduleCreate({ ...payload, cadence });
      } else {
        const cadenceChanged = !originalCadence || !cadencesEqual(originalCadence, cadence);
        await api.scheduleUpdate(task.id, {
          ...payload,
          ...(cadenceChanged ? { cadence } : {}),
        });
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const title = isEdit ? tr("scheduleview.editTask") : tr("scheduleview.newTask");
  const actionLabel = isEdit ? tr("common.save") : tr("common.create");
  const pastOnce = view.mode === "once" && Number.isFinite(view.at) && view.at < Date.now();
  const recurrence = view.mode === "weekly" || view.mode === "monthly" ? view : null;
  const projectValue = project
    ? (project.name || project.path)
    : projectId
      ? tr("scheduleview.unavailableProject")
      : tr("scheduleview.pickAProject");
  const editEntries: MenuEntry[] = task && !loopFile
    ? [
        { id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void runPlannerTask(task.id).then((ok) => { if (ok) onSaved(); }) },
        ...(onViewRuns
          ? [{ id: "runs", label: tr("scheduleview.viewRuns"), onSelect: () => onViewRuns(task) }]
          : []),
        { id: "duplicate", label: tr("scheduleview.duplicate"), icon: CopyIcon, onSelect: () => void duplicatePlannerTask(task).then((ok) => { if (ok) onSaved(); }) },
        "separator" as const,
        { id: "delete", label: tr("scheduleview.deleteTask"), icon: DeleteIcon, danger: true, onSelect: () => void deletePlannerTask(task).then((ok) => { if (ok) { onSaved(); onClose(); } }) },
      ]
    : task && onViewRuns
      ? [
          { id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void runPlannerTask(task.id).then((ok) => { if (ok) onSaved(); }) },
          { id: "runs", label: tr("scheduleview.viewRuns"), onSelect: () => onViewRuns(task) },
        ]
      : [];

  return (
    <>
      <ResponsiveOverlay
        open={open}
        onClose={() => void requestClose()}
        title={title}
        desktop="dialog"
        dialogSize="md"
        className="planner-editor-overlay"
        initialFocus=".planner-editor textarea"
        sheetSize="tall"
        sheetAction={{
          label: actionLabel,
          onClick: () => void save(),
          disabled: !canSubmit || busy,
          busy,
        }}
        dialogFooter={(
          <Button variant="primary" disabled={!canSubmit || busy} busy={busy} onClick={() => void save()}>
            {actionLabel}
          </Button>
        )}
      >
        <div className="planner-editor">
          {isEdit && (
            <div className="planner-editor-top">
              {task && isCompletedOnce(task) && view.mode === "once" ? (
                <span className="planner-editor-status">{tr("scheduleview.taskCompleted")}</span>
              ) : (
                <label className="planner-enabled">
                  <span id="planner-active-label">{tr("scheduleview.taskActive")}</span>
                  <Switch
                    checked={enabled}
                    onChange={setEnabled}
                    labelledBy="planner-active-label"
                  />
                </label>
              )}
              {editEntries.length > 0 && (
                <Menu
                  label={tr("scheduleview.plannerActions")}
                  entries={editEntries}
                >
                  {(trigger) => (
                    <IconButton icon={MoreIcon} label={tr("scheduleview.plannerActions")} {...trigger} />
                  )}
                </Menu>
              )}
            </div>
          )}
          {hasRunning && dirty && (
            <Notice tone="info">{tr("scheduleview.changesApplyToFutureRuns")}</Notice>
          )}
          {loopFile && (
            <p className="planner-loop-note">{tr("scheduleview.loopFileLocked")}</p>
          )}
          <section className="planner-section">
            <span className="planner-section-label">{tr("scheduleview.project")}</span>
            <button
              type="button"
              className="planner-summary-row"
              onClick={() => setProjectOpen(true)}
              disabled={loopFile}
            >
              {project && (
                <span className="planner-project-mark" style={project.color ? { color: project.color } : undefined}>
                  <PlannerProjectMark project={project} />
                </span>
              )}
              <span className="planner-summary-v">{projectValue}</span>
              <Icon icon={ChevronRightIcon} size="sm" />
            </button>
          </section>
          <label className="planner-field planner-prompt-field">
            <span className="planner-section-label">{tr("scheduleview.task")}</span>
            <Textarea
              className="planner-prompt"
              autoGrow
              minRows={3}
              maxRows={10}
              value={prompt}
              disabled={loopFile}
              placeholder={tr("scheduleview.promptPlaceholder")}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <section className="planner-section">
            <span className="planner-section-label">{tr("scheduleview.schedule")}</span>
            {showNormalSchedule ? (
              <>
                <Tabs
                  size="sm"
                  className="planner-schedule-tabs"
                  label={tr("scheduleview.schedule")}
                  value={scheduleTab}
                  tabs={[
                    { id: "once", label: tr("scheduleview.once"), disabled: loopFile },
                    { id: "every", label: tr("scheduleview.every"), disabled: loopFile },
                  ]}
                  onChange={(id) => {
                    if (loopFile) return;
                    if (id === "once") setView(view.mode === "once" ? view : defaultOnceView());
                    else if (view.mode === "weekly" || view.mode === "monthly") { /* keep */ }
                    else if (view.mode === "once" && Number.isFinite(view.at)) setView(weeklyViewFromOnce(view.at));
                    else setView(defaultWeeklyView());
                    setConverted(true);
                  }}
                />
                {view.mode === "once" && (
                  <button
                    type="button"
                    className="planner-summary-row"
                    disabled={loopFile}
                    onClick={() => setOnceOpen(true)}
                  >
                    <span className="planner-summary-v">
                      {Number.isFinite(view.at) ? formatOnceWhen(view.at) : tr("scheduleview.once")}
                    </span>
                    <Icon icon={ChevronRightIcon} size="sm" />
                  </button>
                )}
                {(view.mode === "weekly" || view.mode === "monthly") && (
                  <button
                    type="button"
                    className="planner-summary-row"
                    disabled={loopFile}
                    onClick={() => setRecurrenceOpen(true)}
                  >
                    <span className="planner-summary-v">{recurrenceSummary(viewToCadence(view), { compact: true })}</span>
                    <Icon icon={ChevronRightIcon} size="sm" />
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="planner-legacy-summary">{recurrenceSummary(viewToCadence(view))}</div>
                {view.mode === "interval" && (
                  <label className="planner-field planner-inline">
                    <span>{tr("scheduleview.intervalMinutes", { minutes: view.everyMinutes })}</span>
                    <TextInput
                      className="planner-interval-input"
                      type="number"
                      min={1}
                      value={view.everyMinutes}
                      disabled={loopFile}
                      onChange={(event) => setView({
                        mode: "interval",
                        everyMinutes: Math.max(1, Number(event.target.value) || 1),
                      })}
                    />
                  </label>
                )}
                {!loopFile && (
                  <Button size="sm" onClick={convertToEvery}>{tr("scheduleview.changeSchedule")}</Button>
                )}
              </>
            )}
            {pastOnce && <p className="planner-hint">{tr("scheduleview.pastTimeAllowed")}</p>}
          </section>
          <section className="planner-section">
            <span className="planner-section-label">{tr("scheduleview.runBehavior")}</span>
            <button
              type="button"
              className="planner-summary-row"
              disabled={loopFile}
              onClick={() => setBehaviorOpen(true)}
            >
              <span className="planner-summary-v">{behaviorSummary(targetMode, overlap)}</span>
              <Icon icon={ChevronRightIcon} size="sm" />
            </button>
          </section>
          {error && <div className="form-error">{error}</div>}
        </div>
      </ResponsiveOverlay>
      <PlannerProjectPicker
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        projects={projects}
        value={projectId || null}
        onChange={(id) => {
          if (!id) return;
          const nextSessions = allSessions.filter(
            (session) => session.projectId === id && session.status !== "archived",
          );
          setProjectId(id);
          setSessionId((current) => sessionIdAfterProjectChange(current, targetMode, nextSessions));
        }}
        title={tr("scheduleview.project")}
      />
      {view.mode === "once" && (
        <PlannerOnceSheet
          open={onceOpen}
          onClose={() => setOnceOpen(false)}
          value={view.at}
          disabled={loopFile}
          onChange={(at) => setView({ mode: "once", at })}
        />
      )}
      {recurrence && (
        <PlannerRecurrenceSheet
          open={recurrenceOpen}
          onClose={() => setRecurrenceOpen(false)}
          value={recurrence}
          onChange={(next: RecurrenceView) => setView(next)}
        />
      )}
      <PlannerRunBehaviorSheet
        open={behaviorOpen}
        onClose={() => setBehaviorOpen(false)}
        targetMode={targetMode}
        sessionId={sessionId}
        overlap={overlap}
        sessions={sessions}
        onChange={(patch) => {
          if (patch.targetMode !== undefined) setTargetMode(patch.targetMode);
          if (patch.sessionId !== undefined) setSessionId(patch.sessionId);
          if (patch.overlap !== undefined) setOverlap(patch.overlap);
        }}
      />
    </>
  );
}
