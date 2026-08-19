import { useActiveModel, useStore } from "../store.ts";
import { PERSONAS, isCustomized, usePrefs } from "../prefs.ts";
import { fmtCost } from "../format.ts";

export default function StatusBar() {
  const branch = useStore((s) => s.gitBranch);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const model = useActiveModel();
  const prefs = usePrefs();
  const persona = prefs.persona ? PERSONAS[prefs.persona] : null;
  const custom = isCustomized(prefs);

  let left: string;
  if (persona?.id === "creator") {
    // No model jargon for creators — just what the workspace is doing.
    left = "Preview updates as you chat";
  } else if (persona?.id === "manager") {
    left = model.totals.cost > 0 ? `session spend ${fmtCost(model.totals.cost)}` : "no spend yet";
  } else {
    left = [
      prefs.plugins.includes("git") ? branch : "",
      session?.model ? `${session.model.providerID}/${session.model.modelID}` : "",
      session?.agent ?? "",
    ].filter(Boolean).join(" · ") || project?.name || project?.path || "polyth";
  }

  return (
    <div className="statusbar">
      <span className="statusbar-left">{left}</span>
      <span className="header-spacer" />
      {persona && <span className="statusbar-persona">{persona.label} workspace{custom ? " · custom" : ""}</span>}
    </div>
  );
}
