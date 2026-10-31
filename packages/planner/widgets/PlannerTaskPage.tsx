import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { HarnessSelection, Project } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import {
  BackIcon,
  Button,
  ChevronDownIcon,
  CopyIcon,
  DeleteIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  Notice,
  PlayIcon,
  ProjectPicker,
  Select,
  Switch,
  Tabs,
  Textarea,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import type {
  CatchUpPolicy,
  OverlapPolicy,
  PlannerExecutionModel,
  PlannerTask,
  PlannerTargetMode,
} from "../src/model.ts";
import {
  cadencesEqual,
  cadenceToView,
  defaultOnceView,
  validateCadenceView,
  viewToCadence,
  type CadenceView,
} from "../src/cadenceView.ts";
import { cadenceOfTask, isCompletedOnce } from "../src/plannerTask.ts";
import { taskDisplayTitle } from "../src/plannerList.ts";
import { plannerApi } from "./plannerApi.ts";
import { deleteTask, duplicateTask, runTask, setTaskPaused } from "./plannerActions.ts";
import { cadenceSummary } from "./plannerFormat.ts";
import PlannerHistory from "./PlannerHistory.tsx";
import PlannerWhen from "./PlannerWhen.tsx";
import { t } from "./plannerText.ts";
import { isImeComposing } from "@polyth/web-sdk";

export interface PlannerSeed {
  title?: string;
  prompt?: string;
  view?: CadenceView;
  projectId?: string;
}

interface Draft {
  title: string;
  prompt: string;
  projectId: string;
  enabled: boolean;
  view: CadenceView;
  targetMode: PlannerTargetMode;
  sessionId: string;
  overlap: OverlapPolicy;
  catchUp: CatchUpPolicy;
  model?: PlannerExecutionModel;
  harness: HarnessSelection;
}

function initialDraft(task: PlannerTask | null, seed: PlannerSeed | undefined, locale: string): Draft {
  const cadence = task ? cadenceOfTask(task) : null;
  return {
    title: task?.title ?? seed?.title ?? "",
    prompt: task?.prompt ?? seed?.prompt ?? "",
    projectId: task?.projectId ?? seed?.projectId ?? "",
    enabled: task?.enabled ?? true,
    view: cadence ? cadenceToView(cadence, locale) : seed?.view ?? defaultOnceView(),
    targetMode: task?.target?.mode ?? (task?.sessionId ? "existing-session" : "new-session-per-run"),
    sessionId: task?.target?.sessionId ?? task?.sessionId ?? "",
    overlap: task?.overlapPolicy ?? "skip",
    catchUp: task?.catchUp ?? "once",
    ...(task?.model ? { model: task.model } : {}),
    harness: task?.harness ?? { mode: "auto" },
  };
}

const TARGET_HINT: Record<PlannerTargetMode, Parameters<typeof t>[0]> = {
  "new-session-per-run": "where.newEachRunHint",
  "dedicated-session": "where.keepOneHint",
  "existing-session": "where.existingHint",
};

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section className="planner-section" aria-labelledby={id}>
      <div className="planner-section-head">
        <h3 className="planner-section-title" id={id}>{title}</h3>
        {aside}
      </div>
      <div className="planner-section-body">{children}</div>
    </section>
  );
}

/**
 * One task as its own page: a new task, or an existing one with its history.
 * Mount with `key={task?.id ?? "new"}`; the draft initialises once per key, so
 * a background refresh of the list never touches what is being typed.
 */
export default function PlannerTaskPage({
  task,
  seed,
  projects,
  locale,
  now,
  host,
  onBack,
  onSaved,
  onDuplicated,
  onDirtyChange,
}: {
  task: PlannerTask | null;
  seed?: PlannerSeed;
  projects: readonly Project[];
  locale: string;
  now: number;
  host?: WebPackageHost;
  onBack: () => void;
  onSaved: (task: PlannerTask, created: boolean) => void;
  onDuplicated: (copy: PlannerTask) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const isEdit = task !== null;
  const [baseline, setBaseline] = useState(() => initialDraft(task, seed, locale));
  const [draft, setDraft] = useState(baseline);
  const [originalCadence, setOriginalCadence] = useState(() => (task ? cadenceOfTask(task) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeId = useId();
  const patch = useCallback((next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next })), []);

  const allSessions = useStore((state) => state.sessions);
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const sessions = useMemo(
    () => allSessions
      .filter((session) => session.projectId === draft.projectId && session.status !== "archived" && !session.parentId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [allSessions, draft.projectId],
  );
  const project = projects.find((item) => item.id === draft.projectId);
  const spaceId = project?.spaceId;
  const selectedHarnessId = draft.harness.mode === "pinned" ? draft.harness.harnessId : undefined;
  const routeCatalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(spaceId ? { spaceId } : {}),
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(selectedHarnessId ? { harnessId: selectedHarnessId } : {}),
  });
  const catalogHarnessId = selectedHarnessId ?? routeCatalog.harnessId ?? draft.model?.harnessId;
  const executionModels = useMemo(
    () => catalogHarnessId
      ? routeCatalog.models.filter((candidate) => !candidate.harnessId || candidate.harnessId === catalogHarnessId)
      : routeCatalog.models,
    [routeCatalog.models, catalogHarnessId],
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const cadenceOk = validateCadenceView(draft.view).ok;
  const targetOk = draft.targetMode !== "existing-session" || sessions.some((session) => session.id === draft.sessionId);
  const canSave = !!draft.projectId && !!draft.prompt.trim() && cadenceOk && targetOk && (!isEdit || dirty);
  const running = task?.history?.[0]?.status === "running";
  const completed = task ? isCompletedOnce(task) && draft.view.mode === "once" && !dirty : false;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // Desktop: a new task starts in its prompt. Touch: never summon the keyboard.
  useEffect(() => {
    if (!isEdit && typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) promptRef.current?.focus();
  }, [isEdit]);
  useEffect(() => {
    if (!savedFlash) return;
    const timer = setTimeout(() => setSavedFlash(false), 1600);
    return () => clearTimeout(timer);
  }, [savedFlash]);

  const save = async () => {
    if (!canSave || busy) return;
    const cadence = viewToCadence(draft.view);
    const payload = {
      projectId: draft.projectId,
      prompt: draft.prompt.trim(),
      title: draft.title.trim(),
      target: {
        mode: draft.targetMode,
        ...(draft.targetMode === "existing-session" && draft.sessionId ? { sessionId: draft.sessionId } : {}),
      },
      overlapPolicy: draft.overlap,
      catchUp: draft.catchUp,
      enabled: draft.enabled,
      model: draft.model ?? null,
      harness: draft.harness.mode === "pinned" ? draft.harness : null,
    };
    setBusy(true);
    setError("");
    try {
      if (!task) {
        const created = await plannerApi.create({ ...payload, cadence });
        onSaved(created, true);
        return;
      }
      const cadenceChanged = !originalCadence || !cadencesEqual(originalCadence, cadence);
      const updated = await plannerApi.update(task.id, { ...payload, ...(cadenceChanged ? { cadence } : {}) });
      const next = initialDraft(updated, undefined, locale);
      setBaseline(next);
      setDraft(next);
      setOriginalCadence(cadenceOfTask(updated));
      setSavedFlash(true);
      onSaved(updated, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // On an existing task the switch acts at once, like the list's; the rest of
  // the draft stays untouched.
  const toggleActive = async (enabled: boolean) => {
    if (!task) return patch({ enabled });
    setBaseline((current) => ({ ...current, enabled }));
    patch({ enabled });
    const updated = await setTaskPaused(task, !enabled);
    if (!updated) {
      setBaseline((current) => ({ ...current, enabled: !enabled }));
      patch({ enabled: !enabled });
      return;
    }
    onSaved(updated, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // Portaled pickers bubble through React; only keys typed in the form count.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (isImeComposing(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape" && !event.defaultPrevented) {
      // Escape never discards typed work and never closes the window under it.
      event.stopPropagation();
      if (!dirty) onBack();
    }
  };

  const entries: MenuEntry[] = task ? [
    { id: "run", label: t("action.runNow"), icon: PlayIcon, onSelect: () => void runTask(task) },
    { id: "duplicate", label: t("action.duplicate"), icon: CopyIcon, onSelect: () => void duplicateTask(task).then((copy) => { if (copy) onDuplicated(copy); }) },
    "separator",
    { id: "delete", label: t("action.delete"), icon: DeleteIcon, danger: true, onSelect: () => void deleteTask(task).then((ok) => { if (ok) onBack(); }) },
  ] : [];

  const heading = isEdit ? taskDisplayTitle({ title: baseline.title, prompt: baseline.prompt }) : t("editor.newTitle");
  const showFooter = !isEdit || dirty || busy;

  return (
    <form
      className={`planner-page${showFooter ? " has-footer" : ""}`}
      aria-label={heading}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="planner-page-bar">
        <IconButton icon={BackIcon} label={t("editor.back")} onClick={onBack} className="planner-back" />
        <h2 className="planner-page-heading">{heading}</h2>
        <div className="planner-page-tools">
          {isEdit && (completed ? (
            <span className="planner-status-pill" data-tone="done">{t("editor.completed")}</span>
          ) : (
            <span className="planner-active">
              <span id={activeId} className="planner-active-label">{t("editor.active")}</span>
              <Switch checked={draft.enabled} onChange={(enabled) => void toggleActive(enabled)} labelledBy={activeId} />
            </span>
          ))}
          {task && (
            <>
              <Button size="sm" iconStart={PlayIcon} className="planner-run-btn" onClick={() => void runTask(task)}>
                {t("action.runNow")}
              </Button>
              <Menu label={t("list.taskActions")} align="end" entries={entries}>
                {(trigger) => <IconButton icon={MoreIcon} label={t("list.taskActions")} {...trigger} />}
              </Menu>
            </>
          )}
        </div>
      </header>

      {running && dirty && <Notice tone="info">{t("editor.changesApplyNext")}</Notice>}

      <div className="planner-page-grid">
        <div className="planner-page-main">
          <div className="planner-compose ui-field-frame">
            <input
              className="planner-title-input"
              aria-label={t("editor.titleLabel")}
              placeholder={t("editor.titlePlaceholder")}
              value={draft.title}
              maxLength={120}
              onChange={(event) => patch({ title: event.target.value })}
            />
            <Textarea
              ref={promptRef}
              className="planner-prompt"
              aria-label={t("editor.promptLabel")}
              placeholder={t("editor.promptPlaceholder")}
              autoGrow
              minRows={4}
              maxRows={16}
              value={draft.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </div>

          <Section title={t("when.section")} aside={<span className="planner-section-meta">{cadenceSummary(viewToCadence(draft.view), locale)}</span>}>
            <PlannerWhen view={draft.view} locale={locale} onChange={(view) => patch({ view })} />
          </Section>
        </div>

        <div className="planner-page-side">
          <Section title={t("where.section")}>
            <div className="planner-field">
              <span className="planner-field-label">{t("where.project")}</span>
              <ProjectPicker
                className="planner-project-picker"
                label={t("where.project")}
                projects={projects}
                value={draft.projectId}
                emptyMessage={t("list.noProjects")}
                onPick={(projectId) => {
                  if (!projectId || projectId === draft.projectId) return;
                  const keep = allSessions.some((session) => session.id === draft.sessionId && session.projectId === projectId);
                  patch({ projectId, model: undefined, ...(keep ? {} : { sessionId: "" }) });
                }}
              />
            </div>
            <div className="planner-field">
              <span className="planner-field-label">{t("where.session")}</span>
              <Tabs
                size="sm"
                className="planner-target"
                label={t("where.session")}
                value={draft.targetMode}
                tabs={[
                  { id: "new-session-per-run", label: t("where.newEachRun") },
                  { id: "dedicated-session", label: t("where.keepOne") },
                  { id: "existing-session", label: t("where.existing") },
                ]}
                onChange={(mode) => patch({ targetMode: mode as PlannerTargetMode })}
              />
              <span className="planner-hint">{t(TARGET_HINT[draft.targetMode])}</span>
              {draft.targetMode === "existing-session" && (sessions.length > 0 ? (
                <Select
                  className="planner-session-select"
                  label={t("where.pickChat")}
                  placeholder={t("where.pickChat")}
                  {...(draft.sessionId ? { value: draft.sessionId } : {})}
                  options={sessions.map((session) => ({ value: session.id, label: session.title || session.id }))}
                  onChange={(sessionId) => patch({ sessionId })}
                />
              ) : (
                <span className="planner-hint is-warning">{t("where.noChats")}</span>
              ))}
            </div>
            <div className="planner-field">
              <span className="planner-field-label">{t("where.model")}</span>
              <div className="planner-model">
                <ModelPicker
                  models={executionModels}
                  {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
                  {...(draft.model ? { value: draft.model } : {})}
                  direction="down"
                  catalogLoading={routeCatalog.discovery.state === "pending"}
                  header={host ? (
                    <host.ui.Slot
                      slot="modelPicker.header"
                      context={{
                        ...(spaceId ? { spaceId } : {}),
                        ...(draft.projectId ? { projectId: draft.projectId } : {}),
                        ...(draft.targetMode === "existing-session" && draft.sessionId ? { sessionId: draft.sessionId } : {}),
                        harnessSelection: draft.harness,
                        ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
                        pendingHarnessSelection: draft.harness,
                        onSelectHarness: (harness: HarnessSelection) => patch({ harness }),
                      }}
                    />
                  ) : undefined}
                  onPick={(model) => {
                    if (!model) return;
                    patch({ model, ...(model.harnessId ? { harness: { mode: "pinned", harnessId: model.harnessId } } : {}) });
                  }}
                />
              </div>
            </div>
          </Section>

          <section className={`planner-disclosure${advancedOpen ? " is-open" : ""}`}>
            <button
              type="button"
              className="planner-disclosure-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>{t("advanced.section")}</span>
              <Icon icon={ChevronDownIcon} size="sm" />
            </button>
            {advancedOpen && (
              <div className="planner-disclosure-body">
                <div className="planner-field">
                  <span className="planner-field-label">{t("advanced.whenBusy")}</span>
                  <Tabs
                    size="sm"
                    label={t("advanced.whenBusy")}
                    value={draft.overlap}
                    tabs={[
                      { id: "skip", label: t("advanced.skip") },
                      { id: "queue", label: t("advanced.queue") },
                      { id: "parallel", label: t("advanced.parallel") },
                    ]}
                    onChange={(overlap) => patch({ overlap: overlap as OverlapPolicy })}
                  />
                </div>
                <div className="planner-field">
                  <span className="planner-field-label">{t("advanced.ifMissed")}</span>
                  <Tabs
                    size="sm"
                    label={t("advanced.ifMissed")}
                    value={draft.catchUp}
                    tabs={[
                      { id: "once", label: t("advanced.catchUpOnce") },
                      { id: "skip", label: t("advanced.catchUpSkip") },
                    ]}
                    onChange={(catchUp) => patch({ catchUp: catchUp as CatchUpPolicy })}
                  />
                </div>
              </div>
            )}
          </section>

          {task && (
            <Section
              title={t("history.section")}
              aside={task.runs > 0 ? <span className="planner-section-meta">{t("history.ranTimes", { count: task.runs })}</span> : undefined}
            >
              <PlannerHistory runs={task.history ?? []} locale={locale} now={now} {...(host ? { host } : {})} />
            </Section>
          )}
        </div>
      </div>

      {error && <div className="planner-form-error" role="alert">{error}</div>}

      {showFooter && (
        <footer className="planner-page-footer">
          <span className="planner-shortcut" aria-hidden="true">{t("editor.shortcut")}</span>
          <Button variant="ghost" onClick={() => (isEdit ? setDraft(baseline) : onBack())}>{t("editor.cancel")}</Button>
          <Button type="submit" variant="primary" className="planner-save" disabled={!canSave || busy} busy={busy}>
            {isEdit ? t("editor.save") : t("editor.create")}
          </Button>
        </footer>
      )}
      {savedFlash && !showFooter && (
        <div className="planner-saved" role="status">{t("editor.saved")}</div>
      )}
    </form>
  );
}
