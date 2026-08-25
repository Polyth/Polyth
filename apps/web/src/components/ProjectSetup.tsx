import { useEffect, useMemo, useRef, useState } from "react";
import { completeProjectSetup } from "../projectSetup.ts";
import { focusComposer, setOverlay } from "../store.ts";
import { useWidgetCatalog } from "../widgets/catalog.ts";
import { ensureWidgets, updateWidgetLayout, type WidgetAudience } from "../widgets/widgetLayout.ts";
import {
  MAX_SETUP_WIDGETS,
  MIN_SETUP_WIDGETS,
  WORKFLOW_OPTIONS,
  applyProjectSetup,
  createSetupDraft,
  validSetupWidgetCount,
  workflowOption,
  type ProjectSetupDraft,
  type SetupWorkflow,
} from "../widgets/projectSetupLayout.ts";
import "../widgets/builtinWidgets.tsx";
import { announce } from "./a11y/live.tsx";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { tr } from "../i18n/index.ts";

const MODE_COPY: Array<[WidgetAudience, string, string]> = [
  ["simple", tr("projectsetup.simple"), tr("projectsetup.simpleDescription")],
  ["standard", tr("projectsetup.standard"), tr("projectsetup.standardDescription")],
  ["power", tr("projectsetup.power"), tr("projectsetup.powerDescription")],
];

const STEP_LABELS = [tr("projectsetup.workflow"), tr("projectsetup.control"), tr("projectsetup.widgets"), tr("projectsetup.review")] as const;

export default function ProjectSetup() {
  const widgets = useWidgetCatalog();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProjectSetupDraft>(() => createSetupDraft());
  const panelRef = useRef<HTMLDivElement>(null);
  const exitFocus = useRef<"restore" | "composer">("restore");

  const suggestedIds = (workflow: SetupWorkflow, audience: WidgetAudience): string[] => {
    const preferred = workflowOption(workflow).suggestedWidgetIds;
    const rank: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
    const available = widgets.filter(
      (widget) => rank[widget.audience ?? "standard"] <= rank[audience],
    );
    return [
      ...available.filter((widget) => preferred.includes(widget.id)),
      ...available.filter((widget) => !preferred.includes(widget.id) && widget.recommended),
      ...available.filter((widget) => !preferred.includes(widget.id) && !widget.recommended),
    ].map((widget) => widget.id).slice(0, MAX_SETUP_WIDGETS);
  };

  useEffect(() => {
    ensureWidgets(widgets);
    if (widgets.length === 0) return;
    setDraft((current) => {
      const available = new Set(widgets.map((widget) => widget.id));
      const retained = current.widgetIds.filter((id) => available.has(id));
      const filled = [...new Set([
        ...retained,
        ...suggestedIds(current.workflow, current.audience),
      ])].slice(0, MAX_SETUP_WIDGETS);
      return filled.join("|") === current.widgetIds.join("|")
        ? current
        : { ...current, widgetIds: filled };
    });
    // Catalog registration is the only dependency; the draft is reconciled
    // inside the updater so a user choice is never replaced by a stale render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets]);

  const dismiss = () => {
    completeProjectSetup();
    setOverlay(null);
  };

  useModalSurface({
    open: true,
    onClose: dismiss,
    containerRef: panelRef,
    initialFocus: ".setup-choice",
    resolveRestoreFocus: (opener) => {
      if (exitFocus.current === "composer" || opener === null) {
        focusComposer();
        return null;
      }
      return opener;
    },
  });

  const availableSuggestions = useMemo(() => {
    const ids = new Set([
      ...draft.widgetIds,
      ...suggestedIds(draft.workflow, draft.audience),
    ]);
    return [...ids]
      .map((id) => widgets.find((widget) => widget.id === id))
      .filter((widget) => widget !== undefined)
      .slice(0, MAX_SETUP_WIDGETS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.workflow, draft.audience, draft.widgetIds, widgets]);

  const chooseWorkflow = (workflow: SetupWorkflow) => {
    setDraft((current) => ({
      ...current,
      workflow,
      widgetIds: suggestedIds(workflow, current.audience),
    }));
  };

  const finish = () => {
    if (!validSetupWidgetCount(draft.widgetIds)) return;
    updateWidgetLayout(
      (current) => applyProjectSetup(current, draft, widgets),
      { immediate: true },
    );
    completeProjectSetup();
    announce(tr("projectsetup.valueSetupAppliedToThisProjectWith", { label: workflowOption(draft.workflow).label, length: draft.widgetIds.length, audience: draft.audience }));
    exitFocus.current = "composer";
    setOverlay(null);
  };

  const toggleWidget = (id: string) => {
    setDraft((current) => {
      const selected = current.widgetIds.includes(id);
      if (selected) return { ...current, widgetIds: current.widgetIds.filter((item) => item !== id) };
      if (current.widgetIds.length >= MAX_SETUP_WIDGETS) return current;
      return { ...current, widgetIds: [...current.widgetIds, id] };
    });
  };

  return (
    <div className="project-setup-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div
        className="project-setup guided-setup"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-setup-heading"
        aria-describedby="project-setup-desc"
        tabIndex={-1}
      >
        <header className="guided-setup-head">
          <div>
            <span className="project-setup-kicker">{tr("projectsetup.projectSetup")}</span>
            <h1 id="project-setup-heading">{tr("projectsetup.setUpThisProject")}</h1>
            <p id="project-setup-desc">{tr("projectsetup.chooseAStartingCanvasForThisProject")}</p>
          </div>
          <button className="project-setup-close" onClick={dismiss} aria-label={tr("projectsetup.closeProjectSetup")}>{tr("projectsetup.message")}</button>
        </header>

        <ol className="guided-setup-steps" aria-label={tr("projectsetup.setupProgress")}>
          {STEP_LABELS.map((label, index) => (
            <li key={label} className={index === step ? "active" : index < step ? "done" : ""}>
              <span>{index < step ? "✓" : index + 1}</span><b>{label}</b>
            </li>
          ))}
        </ol>

        <div className="guided-setup-body">
          {step === 0 && (
            <section>
              <div className="guided-step-title"><span>{tr("projectsetup.step1Of4")}</span><h2>{tr("projectsetup.whatKindOfWorkShouldStayNearby")}</h2><p>{tr("projectsetup.thisOnlyChoosesAStartingArrangementFor")}</p></div>
              <div className="guided-workflow-grid">
                {WORKFLOW_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`setup-choice${draft.workflow === option.id ? " selected" : ""}`}
                    aria-pressed={draft.workflow === option.id}
                    onClick={() => chooseWorkflow(option.id)}
                  >
                    <i aria-hidden="true">{option.id === "build-debug" ? "⌘" : option.id === "plan-coordinate" ? "✓" : option.id === "research" ? "⌕" : option.id === "design-explore" ? "◇" : option.id === "write" ? "✎" : "✦"}</i>
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    <b aria-hidden="true">{draft.workflow === option.id ? "✓" : ""}</b>
                  </button>
                ))}
              </div>
            </section>
          )}

          {step === 1 && (
            <section>
              <div className="guided-step-title"><span>{tr("projectsetup.step2Of4")}</span><h2>{tr("projectsetup.howMuchControlDoYouWantUp")}</h2><p>{tr("projectsetup.thisChangesPresentationNotWhatPolythCan")}</p></div>
              <div className="guided-mode-grid">
                {MODE_COPY.map(([id, label, description]) => (
                  <button
                    type="button"
                    key={id}
                    className={`setup-choice${draft.audience === id ? " selected" : ""}`}
                    aria-pressed={draft.audience === id}
                    onClick={() => setDraft((current) => ({
                      ...current,
                      audience: id,
                      widgetIds: suggestedIds(current.workflow, id),
                    }))}
                  >
                    <span className={`guided-mode-preview mode-${id}`} aria-hidden="true"><i /><i /><i /><i /></span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                    {id === "standard" && <em>{tr("projectsetup.recommended")}</em>}
                  </button>
                ))}
              </div>
            </section>
          )}

          {step === 2 && (
            <section>
              <div className="guided-step-title"><span>{tr("projectsetup.step3Of4")}</span><h2>{tr("projectsetup.pickTheWidgetsYouWantNearby")}</h2><p>{tr("projectsetup.choose58NowOrKeepThe")}</p></div>
              <div className="guided-widget-grid">
                {availableSuggestions.map((widget) => {
                  const selected = draft.widgetIds.includes(widget.id);
                  return (
                    <button
                      type="button"
                      key={widget.id}
                      className={`setup-choice${selected ? " selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => toggleWidget(widget.id)}
                    >
                      <i aria-hidden="true">{widget.title.slice(0, 1)}</i>
                      <span><strong>{widget.title}</strong><small>{widget.description}</small></span>
                      <b aria-hidden="true">{selected ? "✓" : "+"}</b>
                    </button>
                  );
                })}
              </div>
              <p className="guided-selection-count" role={!validSetupWidgetCount(draft.widgetIds) ? "alert" : undefined}>
                {draft.widgetIds.length} {tr("projectsetup.selected")}{" "}{draft.widgetIds.length < MIN_SETUP_WIDGETS
                  ? tr("projectsetup.chooseAtLeastValue", { MIN_SETUP_WIDGETS: MIN_SETUP_WIDGETS })
                  : tr("projectsetup.youCanAddAnyPluginWidgetLater")}
              </p>
            </section>
          )}

          {step === 3 && (
            <section>
              <div className="guided-step-title"><span>{tr("projectsetup.step4Of4")}</span><h2>{tr("projectsetup.yourProjectCanvas")}</h2><p>{tr("projectsetup.reviewTheChoicesBelowNothingIsLocked")}</p></div>
              <div className="guided-review">
                <article><span>{tr("projectsetup.workflow")}</span><strong>{workflowOption(draft.workflow).label}</strong><button type="button" onClick={() => setStep(0)}>{tr("common.edit")}</button></article>
                <article><span>{tr("projectsetup.control")}</span><strong>{MODE_COPY.find(([id]) => id === draft.audience)?.[1]}</strong><button type="button" onClick={() => setStep(1)}>{tr("common.edit")}</button></article>
                <article><span>{tr("projectsetup.widgets")}</span><strong>{draft.widgetIds.length} {tr("projectsetup.selected2")}</strong><button type="button" onClick={() => setStep(2)}>{tr("common.edit")}</button></article>
                <div className="guided-review-widgets">
                  {draft.widgetIds.map((id) => {
                    const widget = widgets.find((item) => item.id === id);
                    return widget ? <span key={id}>{widget.title}</span> : null;
                  })}
                </div>
              </div>
              <div className="guided-review-note"><span aria-hidden="true">✦</span><p><strong>{tr("projectsetup.youCanChangeEverythingLater")}</strong><small>{tr("projectsetup.moveResizeHideOrAddWidgetsFrom")}</small></p></div>
            </section>
          )}
        </div>

        <footer className="guided-setup-foot">
          <button type="button" className="project-setup-skip" onClick={dismiss}>{tr("projectsetup.skipForNow")}</button>
          <span />
          {step > 0 && <button type="button" onClick={() => setStep((current) => current - 1)}>{tr("common.back")}</button>}
          {step < 3
            ? <button type="button" className="btn-accent" onClick={() => setStep((current) => current + 1)}>{tr("common.continue")}</button>
            : <button type="button" className="btn-accent" disabled={!validSetupWidgetCount(draft.widgetIds)} onClick={finish}>{tr("projectsetup.finishSetup")}</button>}
        </footer>
      </div>
    </div>
  );
}
