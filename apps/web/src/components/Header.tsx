import { Fragment, useEffect, useMemo, useState } from "react";
import { useActiveModel, useStore, setActiveView, setMoreOpen, setOverlay, setSidebarOpen } from "../store.ts";
import { forkSession, exportSessionMarkdown } from "../init.ts";
import { NAV, usePrefs } from "../prefs.ts";
import { MOD, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";
import { renderSlot } from "../slots.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import type { RenderModel } from "../reduce.ts";
import type { SessionProjection, ModelDescriptor } from "@polyth/contracts";

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
  const moreOpen = useStore((s) => s.moreOpen);
  const firstUser = useStore((s) => firstUserText(s.activeSessionId ? s.events[s.activeSessionId] : undefined));
  const prefs = usePrefs();
  const model = useActiveModel();
  const ctx = useMemo(() => contextUsage(model, session, models), [model, session, models]);
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  // The branch belongs to the git plugin (UX-32).
  const gitOn = prefs.plugins.includes("git");
  const subtitle = [project?.name || project?.path, gitOn ? branch : ""].filter(Boolean).join(" · ");
  const title = session ? deriveSessionTitle(session.title, firstUser) : "(untitled session)";

  const tabs = NAV.filter(([, plugin]) => prefs.plugins.includes(plugin));
  const viewAllowed = tabs.some(([v]) => v === view);
  useEffect(() => {
    if (!viewAllowed) setActiveView("session");
  }, [viewAllowed]);

  const slotActions = renderSlot("session.header.actions", { sessionId: session?.id });
  const navSlot = renderSlot("app.nav", { view });
  const menu = (label: string, run: () => void, hint?: string) => (
    <button onClick={() => { setMoreOpen(false); run(); }}>
      {label}
      {hint && <kbd>{hint}</kbd>}
    </button>
  );

  return (
    <>
      <header className="header">
        <button className="icon-btn hamburger" aria-label="Projects and sessions" onClick={() => setSidebarOpen(true)}>☰</button>
        {ctx && <ContextRing pct={ctx.pct} level={ctx.level} />}
        <div className="header-session">
          <div className="header-title">{title}</div>
          {subtitle && <div className="header-sub">{subtitle}</div>}
        </div>
        <nav className="header-nav" aria-label="Views">
          {tabs.map(([id, , label]) => (
            <button
              key={id}
              className={`nav-tab ${view === id ? "active" : ""}`}
              aria-pressed={view === id}
              onClick={() => setActiveView(id)}
            >
              {label}
            </button>
          ))}
          {navSlot.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
        </nav>
        {slotActions.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
        <div className="more-wrap">
          <button className="header-action" aria-label="More" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>···</button>
          {moreOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMoreOpen(false)} />
              <div className="more-menu" role="menu">
                {session && prefs.plugins.includes("goals") && menu("Attach goal", () => setGoalFormOpen((v) => !v))}
                {session && menu("Fork session", () => void forkSession(session.id).catch((e) => window.alert(`fork failed: ${e}`)))}
                {session && menu("Export markdown", exportSessionMarkdown)}
                {menu("Settings", () => setOverlay("settings"), `${MOD} ,`)}
                {menu("Customize workspace", () => setOverlay("onboarding"))}
                {menu("Search sessions", () => setOverlay("search"), `${MOD} P`)}
                {menu("Command palette", () => setOverlay("palette"), `${MOD} K`)}
              </div>
            </>
          )}
        </div>
      </header>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
