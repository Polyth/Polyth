import { useMemo, useState } from "react";
import { useActiveModel, useStore, setActiveView, type AppView } from "../store.ts";
import { forkSession, exportSessionMarkdown } from "../init.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import type { RenderModel } from "../reduce.ts";
import type { SessionProjection, ModelDescriptor } from "@polyth/contracts";

const NAV: Array<[AppView, string]> = [
  ["session", "Session"],
  ["goals", "Goals"],
  ["multirun", "Multi-Run"],
  ["fusion", "Fusion"],
  ["walkthrough", "Walkthrough"],
  ["preview", "Preview"],
  ["git", "Git"],
  ["terminal", "Terminal"],
];

function contextUsage(
  model: RenderModel,
  session: SessionProjection | null,
  models: ModelDescriptor[],
): { pct: number; level: "green" | "yellow" | "red" } | null {
  const total = model.totals.input + model.totals.output;
  if (total <= 0 || !session?.model) return null;
  const desc = models.find(
    (m) => m.providerID === session.model!.providerID && m.modelID === session.model!.modelID,
  );
  if (!desc?.context) return null;
  const pct = Math.min(100, Math.round((total / desc.context) * 100));
  return { pct, level: pct < 60 ? "green" : pct < 85 ? "yellow" : "red" };
}

function ContextRing({ pct, level }: { pct: number; level: "green" | "yellow" | "red" }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg className={`ctx-ring ${level}`} width="30" height="30" viewBox="0 0 36 36" aria-label={`${pct}% context`}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="#343330" strokeWidth="2.6" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 18 18)"
      />
      <text x="18" y="19.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor">{pct}</text>
    </svg>
  );
}

export default function Header() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const branch = useStore((s) => s.gitBranch);
  const models = useStore((s) => s.models);
  const view = useStore((s) => s.activeView);
  const model = useActiveModel();
  const ctx = useMemo(() => contextUsage(model, session, models), [model, session, models]);
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const subtitle = [project?.name || project?.path, branch].filter(Boolean).join(" · ");

  return (
    <>
      <header className="header">
        {ctx && <ContextRing pct={ctx.pct} level={ctx.level} />}
        <div className="header-session">
          <span className="header-kicker">Session</span>
          <div className="header-title">{session?.title ?? "(untitled session)"}</div>
          {subtitle && <div className="header-sub">{subtitle}</div>}
        </div>
        <span className="header-spacer" />
        {session && <button className="header-action" onClick={() => setGoalFormOpen((v) => !v)}>Goal</button>}
        {session && (
          <button className="header-action" onClick={() => void forkSession(session.id).catch((e) => window.alert(`fork failed: ${e}`))}>
            Fork
          </button>
        )}
        {session && <button className="header-action" onClick={exportSessionMarkdown}>Export</button>}
      </header>
      <nav className="nav-tabs" aria-label="Views">
        {NAV.map(([id, label]) => (
          <button
            key={id}
            className={`nav-tab ${view === id ? "active" : ""}`}
            aria-pressed={view === id}
            onClick={() => setActiveView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
