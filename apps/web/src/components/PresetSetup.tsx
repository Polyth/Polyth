// UX-PERSONAS: optional workspace preset setup. Shown over the mounted, ready
// workspace — never a gate. Close, Escape, and Skip all lead to the complete
// workspace and record setup as completed with no disguised default. A card
// click is a draft selection only; nothing persists or rearranges until the
// confirmation action is activated.
import { useMemo, useRef, useState } from "react";
import {
  NO_PRESET_CARD, OPTIONAL_SETUP_COPY, WORKSPACE_PRESETS,
  applyPreset, completePresetSetup, formatPresetSummary, getPresentation,
  getPresetState, presetSummary, type WorkspacePresetId,
} from "../workspacePresets.ts";
import { listCapabilities } from "../capabilities.ts";
import { focusComposer, setOverlay } from "../store.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { announce } from "./a11y/live.tsx";

type DraftChoice = WorkspacePresetId | "no-preset" | null;

interface CardDef {
  choice: Exclude<DraftChoice, null>;
  label: string;
  description: string;
  confirmationLabel: string;
}

export default function PresetSetup() {
  const [draft, setDraft] = useState<DraftChoice>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const exitFocus = useRef<"restore" | "composer">("restore");

  // Close, Escape, and Skip: setup completed, no preset written, workspace
  // unchanged. On a reopen the existing preset is left exactly as it is.
  const dismiss = () => {
    completePresetSetup();
    setOverlay(null);
  };

  useModalSurface({
    open: true,
    onClose: dismiss,
    containerRef: panelRef,
    initialFocus: ".preset-card",
    resolveRestoreFocus: (opener) => {
      if (exitFocus.current === "composer" || opener === null) {
        focusComposer();
        return null;
      }
      return opener;
    },
  });

  // Cards are generated from the schema; `No preset` from the standard
  // arrangement. Order: Build & debug, Plan & coordinate, Design & explore,
  // No preset, then the persistent Skip action.
  const cards: CardDef[] = [
    ...WORKSPACE_PRESETS.map((p): CardDef => ({
      choice: p.id, label: p.label, description: p.description, confirmationLabel: p.confirmationLabel,
    })),
    { choice: "no-preset", ...NO_PRESET_CARD },
  ];

  // Confirmation preview: the exact effective changes, generated from the
  // schema against the current state. Unavailable capabilities are omitted.
  const summary = useMemo(() => {
    if (draft === null) return null;
    const state = getPresetState();
    return presetSummary({
      presetId: draft === "no-preset" ? null : draft,
      currentPresetId: state.presetId,
      caps: listCapabilities().map((d) => ({
        id: d.id,
        standardTier: d.standardTier,
        standardRank: d.standardRank,
        label: d.label,
        available: d.available(),
      })),
      overrides: getPresentation().placements,
      starterOverride: getPresentation().starterOrder,
      explicitComposerDetail: state.composerDetail,
    });
  }, [draft]);

  const confirm = () => {
    if (draft === null || !summary) return;
    applyPreset(draft === "no-preset" ? null : draft);
    announce(
      `${summary.label} applied. ${summary.bullets.length} visible arrangement ${summary.bullets.length === 1 ? "change" : "changes"}.`,
    );
    exitFocus.current = "composer";
    setOverlay(null);
  };

  return (
    <div className="preset-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div
        className="preset-setup"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-setup-heading"
        aria-describedby="preset-setup-desc"
        tabIndex={-1}
      >
        <div className="preset-setup-top">
          <div className="preset-setup-head">
            <span className="preset-kicker">{OPTIONAL_SETUP_COPY.kicker}</span>
            <h1 id="preset-setup-heading">{OPTIONAL_SETUP_COPY.heading}</h1>
            <p id="preset-setup-desc">{OPTIONAL_SETUP_COPY.description}</p>
          </div>
          <div className="preset-setup-actions">
            <button className="preset-skip" onClick={dismiss}>{OPTIONAL_SETUP_COPY.skip}</button>
            <button className="preset-close" onClick={dismiss} aria-label="Close preset setup">×</button>
          </div>
        </div>
        <div className="preset-setup-scroll">
          <div className="preset-cards" role="group" aria-label="Workspace preset choices">
            {cards.map((card) => {
              const selected = draft === card.choice;
              return (
                <button
                  key={card.choice}
                  className={`preset-card ${selected ? "selected" : ""}`}
                  aria-pressed={selected}
                  aria-describedby={`preset-card-desc-${card.choice}`}
                  onClick={() => setDraft(selected ? null : card.choice)}
                >
                  <span className="preset-card-title">
                    {card.label}
                    <span className="preset-card-state" aria-hidden="true">{selected ? "✓ Selected" : ""}</span>
                  </span>
                  <span className="preset-card-desc" id={`preset-card-desc-${card.choice}`}>
                    {card.description}
                  </span>
                </button>
              );
            })}
          </div>
          {draft !== null && summary && (
            <div className="preset-preview" role="region" aria-label="What this preset changes">
              <pre className="preset-preview-text">{formatPresetSummary(summary)}</pre>
              {summary.maskedByOverrides.length > 0 && (
                <p className="preset-preview-note">
                  Your explicit layout choices are kept — they win over preset suggestions.
                </p>
              )}
              <button className="preset-confirm" onClick={confirm}>
                {summary.confirmationLabel}
              </button>
            </div>
          )}
          <p className="preset-persistence-note">{OPTIONAL_SETUP_COPY.persistenceNote}</p>
        </div>
      </div>
    </div>
  );
}
