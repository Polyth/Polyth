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

const MODE_COPY: Array<[WidgetAudience, string, string]> = [
  ["simple", "Simple", "A calm project with essential controls and friendly names."],
  ["standard", "Standard", "Everyday project tools with detail when you need it."],
  ["power", "Power", "All technical controls, advanced widgets, and status detail."],
];

const STEP_LABELS = ["Workflow", "Control", "Widgets", "Review"] as const;

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
    announce(`${workflowOption(draft.workflow).label} setup applied to this project with ${draft.widgetIds.length} widgets in ${draft.audience} mode.`);
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
            <span className="project-setup-kicker">Project setup</span>
            <h1 id="project-setup-heading">Set up this project</h1>
            <p id="project-setup-desc">Choose a starting canvas for this project. You can change everything later.</p>
          </div>
          <button className="project-setup-close" onClick={dismiss} aria-label="Close project setup">×</button>
        </header>

        <ol className="guided-setup-steps" aria-label="Setup progress">
          {STEP_LABELS.map((label, index) => (
            <li key={label} className={index === step ? "active" : index < step ? "done" : ""}>
              <span>{index < step ? "✓" : index + 1}</span><b>{label}</b>
            </li>
          ))}
        </ol>

        <div className="guided-setup-body">
          {step === 0 && (
            <section>
              <div className="guided-step-title"><span>Step 1 of 4</span><h2>What kind of work should stay nearby?</h2><p>This only chooses a starting arrangement for this project.</p></div>
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
              <div className="guided-step-title"><span>Step 2 of 4</span><h2>How much control do you want up front?</h2><p>This changes presentation, not what Polyth can do.</p></div>
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
                    {id === "standard" && <em>Recommended</em>}
                  </button>
                ))}
              </div>
            </section>
          )}

          {step === 2 && (
            <section>
              <div className="guided-step-title"><span>Step 3 of 4</span><h2>Pick the widgets you want nearby</h2><p>Choose 5–8 now, or keep the suggested set.</p></div>
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
                {draft.widgetIds.length} selected · {draft.widgetIds.length < MIN_SETUP_WIDGETS
                  ? `Choose at least ${MIN_SETUP_WIDGETS}.`
                  : "You can add any plugin widget later."}
              </p>
            </section>
          )}

          {step === 3 && (
            <section>
              <div className="guided-step-title"><span>Step 4 of 4</span><h2>Your project canvas</h2><p>Review the choices below. Nothing is locked.</p></div>
              <div className="guided-review">
                <article><span>Workflow</span><strong>{workflowOption(draft.workflow).label}</strong><button type="button" onClick={() => setStep(0)}>Edit</button></article>
                <article><span>Control</span><strong>{MODE_COPY.find(([id]) => id === draft.audience)?.[1]}</strong><button type="button" onClick={() => setStep(1)}>Edit</button></article>
                <article><span>Widgets</span><strong>{draft.widgetIds.length} selected</strong><button type="button" onClick={() => setStep(2)}>Edit</button></article>
                <div className="guided-review-widgets">
                  {draft.widgetIds.map((id) => {
                    const widget = widgets.find((item) => item.id === id);
                    return widget ? <span key={id}>{widget.title}</span> : null;
                  })}
                </div>
              </div>
              <div className="guided-review-note"><span aria-hidden="true">✦</span><p><strong>You can change everything later.</strong><small>Move, resize, hide, or add widgets from Settings → Widgets & Layout.</small></p></div>
            </section>
          )}
        </div>

        <footer className="guided-setup-foot">
          <button type="button" className="project-setup-skip" onClick={dismiss}>Skip for now</button>
          <span />
          {step > 0 && <button type="button" onClick={() => setStep((current) => current - 1)}>Back</button>}
          {step < 3
            ? <button type="button" className="btn-accent" onClick={() => setStep((current) => current + 1)}>Continue</button>
            : <button type="button" className="btn-accent" disabled={!validSetupWidgetCount(draft.widgetIds)} onClick={finish}>Finish setup</button>}
        </footer>
      </div>
    </div>
  );
}
