import { PERSONAS, applyPersona, isCustomized, usePrefs, type PersonaId } from "../prefs.ts";
import { getState, setOverlay } from "../store.ts";
import { Icon } from "../icons.tsx";
import type { JSX } from "react";

const ICONS: Record<Exclude<PersonaId, "blank">, () => JSX.Element> = {
  engineer: Icon.term,
  manager: Icon.usage,
  creator: Icon.globe,
};

export default function Onboarding() {
  const prefs = usePrefs();
  const { persona } = prefs;
  const pick = (id: PersonaId) => {
    if (
      persona &&
      isCustomized(prefs) &&
      !window.confirm("Switching resets your plugin customizations to the persona defaults. Continue?")
    ) return;
    applyPersona(id);
    // First run continues straight into the folder picker: a fresh workspace
    // has nowhere to work until a project folder is chosen.
    setOverlay(getState().projects.length === 0 ? "project-picker" : null);
  };
  return (
    <div className="onboard">
      <div className="onboard-inner">
        <span className="welcome-mark">p</span>
        <h1>Customize your workspace</h1>
        <p>Pick a starting point. The rail, the shortcuts and how much detail you see are all different by design — you can switch anytime.</p>
        <div className="onboard-grid">
          {(["engineer", "manager", "creator"] as const).map((id) => {
            const p = PERSONAS[id];
            const PIcon = ICONS[id];
            return (
              <button
                key={id}
                className={`onboard-card ${id === "engineer" ? "featured" : ""}`}
                onClick={() => pick(id)}
              >
                <div className="onboard-card-title">
                  <span className="onboard-card-name"><PIcon /> {p.label}</span>
                  {persona === id && <span className="tag">Current</span>}
                </div>
                <p>{p.blurb}</p>
                <div className="onboard-tags">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
                <span className={`onboard-cta ${id === "engineer" ? "primary-btn" : "small-btn"}`}>Choose {p.label}</span>
              </button>
            );
          })}
        </div>
        <button className="ghost-link" onClick={() => pick("blank")}>Start from a blank workspace →</button>
        {persona && (
          <button className="ghost-link" onClick={() => setOverlay(null)}>Keep my current setup (Esc)</button>
        )}
      </div>
    </div>
  );
}
