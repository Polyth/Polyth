import { useEffect, useMemo, useRef, useState } from "react";
import { applyPreset, completePresetSetup } from "../workspacePresets.ts";
import { focusComposer, setOverlay } from "../store.ts";
import { useWidgetCatalog } from "../widgets/catalog.ts";
import { ensureWidgets, updateWidgetLayout, type WidgetAudience } from "../widgets/widgetLayout.ts";
import {
  WORKFLOW_OPTIONS,
  applyWorkspaceSetup,
  createSetupDraft,
  workflowOption,
  type SetupWorkflow,
  type WorkspaceSetupDraft,
} from "../widgets/workspaceSetup.ts";
import "../widgets/builtinWidgets.tsx";
import { announce } from "./a11y/live.tsx";
import { useModalSurface } from "./a11y/Dialog.tsx";

const MODE_COPY: Array<[WidgetAudience, string, string]> = [
  ["simple", "Simple", "A calm workspace with essential controls and friendly names."],
  ["standard", "Standard", "Everyday project tools with detail when you need it."],
  ["power", "Power", "All technical controls, advanced widgets, and status detail."],
];

const STEP_LABELS = ["Workflow", "Control", "Widgets", "Review"] as const;

function workflowPreset(workflow: SetupWorkflow): "build-debug" | "plan-coordinate" | "design-explore" | null {
  if (workflow === "build-debug") return "build-debug";
  if (workflow === "plan-coordinate") return "plan-coordinate";
  if (workflow === "design-explore") return "design-explore";
  return null;
}

export default function PresetSetup() {
  const widgets = useWidgetCatalog();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WorkspaceSetupDraft>(() => createSetupDraft());
  const panelRef = useRef<HTMLDivElement>(null);
  const exitFocus = useRef<"restore" | "composer">("restore");

  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);

  const dismiss = () => {
    completePresetSetup();
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
    const preferred = workflowOption(draft.workflow).suggestedWidgetIds;
    const rank: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
    return widgets
      .filter((widget) => preferred.includes(widget.id) || widget.recommended)
      .filter((widget) => rank[widget.audience ?? "standard"] <= rank[draft.audience])
      .slice(0, 8);
  }, [draft.workflow, draft.audience, widgets]);

  const chooseWorkflow = (workflow: SetupWorkflow) => {
    const option = workflowOption(workflow);
    setDraft((current) => ({
      ...current,
      workflow,
      widgetIds: option.suggestedWidgetIds.filter((id) => widgets.some((widget) => widget.id === id)).slice(0, 8),
    }));
  };

  const apply = () => {
    updateWidgetLayout((current) => applyWorkspaceSetup(current, draft, widgets));
    applyPreset(workflowPreset(draft.workflow));
    announce(`${workflowOption(draft.workflow).label} setup applied with ${draft.widgetIds.length} widgets in ${draft.audience} mode.`);
    exitFocus.current = "composer";
    setOverlay(null);
  };

  const toggleWidget = (id: string) => {
    setDraft((current) => {
      const selected = current.widgetIds.includes(id);
      if (selected) return { ...current, widgetIds: current.widgetIds.filter((item) => item !== id) };
      if (current.widgetIds.length >= 8) return current;
      return { ...current, widgetIds: [...current.widgetIds, id] };
    });
  };

  return (
    <div className="preset-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div
        className="preset-setup guided-setup"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-setup-heading"
        aria-describedby="preset-setup-desc"
        tabIndex={-1}
      >
        <header className="guided-setup-head">
          <div>
            <span className="preset-kicker">Optional setup</span>
            <h1 id="preset-setup-heading">Choose a setup</h1>
            <p id="preset-setup-desc">Start close to what you need. You can change everything later.</p>
          </div>
          <button className="preset-close" onClick={dismiss} aria-label="Close workspace setup">×</button>
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
              <div className="guided-step-title"><span>Step 1 of 4</span><h2>What kind of work should stay nearby?</h2><p>This only chooses a starting arrangement.</p></div>
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
                    onClick={() => setDraft((current) => ({ ...current, audience: id }))}
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
              <p className="guided-selection-count">{draft.widgetIds.length} selected · You can add any plugin widget later.</p>
            </section>
          )}

          {step === 3 && (
            <section>
              <div className="guided-step-title"><span>Step 4 of 4</span><h2>Your starting workspace</h2><p>Review the choices below. Nothing is locked.</p></div>
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
          <button type="button" className="preset-skip" onClick={dismiss}>Skip for now</button>
          <span />
          {step > 0 && <button type="button" onClick={() => setStep((current) => current - 1)}>Back</button>}
          {step < 3
            ? <button type="button" className="btn-accent" onClick={() => setStep((current) => current + 1)}>Continue</button>
            : <button type="button" className="btn-accent" disabled={draft.widgetIds.length === 0} onClick={apply}>Apply setup</button>}
        </footer>
      </div>
    </div>
  );
}
