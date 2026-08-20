import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveModel, useStore, setActiveView, setUiError, type AppView } from "../store.ts";
import { forkSession, exportSessionMarkdown } from "../init.ts";
import { displaySessionTitle } from "../format.ts";
import { friendlyError, shortcutLabel } from "../settings.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import type { RenderModel } from "../reduce.ts";
import type { SessionProjection, ModelDescriptor } from "@polyth/contracts";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS: Record<AppView, React.ReactNode> = {
  session: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <path d="M2.5 3.5h11v7h-6l-2.8 2.6v-2.6h-2.2z" />
    </svg>
  ),
  git: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="4.5" cy="4" r="1.7" /><circle cx="4.5" cy="12" r="1.7" /><circle cx="11.5" cy="5.5" r="1.7" />
      <path d="M4.5 5.7v4.6M11.5 7.2c0 2.3-2.5 2.6-5 3" />
    </svg>
  ),
  terminal: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="M4.5 6.2 6.8 8l-2.3 1.8M8.4 10.2h3" />
    </svg>
  ),
  preview: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="M1.8 5.6h12.4" /><circle cx="4" cy="4.2" r="0.3" />
    </svg>
  ),
  goals: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.5" />
    </svg>
  ),
  multirun: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <rect x="2" y="3" width="3.2" height="10" rx="1" /><rect x="6.4" y="3" width="3.2" height="10" rx="1" /><rect x="10.8" y="3" width="3.2" height="10" rx="1" />
    </svg>
  ),
  fusion: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="6" cy="8" r="4.2" /><circle cx="10" cy="8" r="4.2" />
    </svg>
  ),
  walkthrough: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <path d="M3 4h2M3 8h2M3 12h2M8 4h5M8 8h5M8 12h5" />
    </svg>
  ),
  files: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <path d="M4 2.5h5l3 3v8h-8z" /><path d="M9 2.5v3h3" />
    </svg>
  ),
  schedule: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2.2 1.3" />
    </svg>
  ),
  github: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="5" cy="4.5" r="1.7" /><circle cx="5" cy="11.5" r="1.7" /><circle cx="11" cy="11.5" r="1.7" />
      <path d="M5 6.2v3.6M11 9.8V7.5a2 2 0 0 0-2-2H8.2" />
    </svg>
  ),
};

// Groups separated by a thin divider: chat · workspace · workflows.
const VIEW_GROUPS: Array<Array<[AppView, string]>> = [
  [["session", "Chat"]],
  [["files", "Files"], ["git", "Git"], ["terminal", "Terminal"], ["preview", "Preview"]],
  [["goals", "Goals"], ["multirun", "Multi-run"], ["fusion", "Fusion"], ["walkthrough", "Walkthrough"], ["schedule", "Schedule"], ["github", "GitHub"]],
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

function OverflowMenu({ sessionId, onGoal }: { sessionId: string | null; onGoal: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="overflow-menu" ref={ref}>
      <button
        className="icon-btn overflow-trigger"
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >···</button>
      {open && (
        <div className="menu-popup" role="menu">
          {sessionId !== null && (
            <>
              <button role="menuitem" onClick={() => { setOpen(false); onGoal(); }}>Attach goal…</button>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void forkSession(sessionId).catch((e) => setUiError(friendlyError("Couldn’t fork the session", e)));
                }}
              >Fork session</button>
              <button role="menuitem" onClick={() => { setOpen(false); exportSessionMarkdown(); }}>Export Markdown</button>
              <div className="menu-sep" />
            </>
          )}
          <button
            role="menuitem"
            onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("polyth:open-settings")); }}
          >Settings<span className="menu-kbd">{shortcutLabel(",")}</span></button>
        </div>
      )}
    </div>
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

  const firstUserText = useMemo(() => {
    const first = model.messages.find((m) => m.kind === "user");
    return first && first.kind === "user" ? (first.text || first.raw) : undefined;
  }, [model.messages]);

  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserText)
    : project?.name || project?.path || "Polyth";
  const subtitle = [project?.name || project?.path, branch].filter(Boolean).join(" · ");

  return (
    <>
      <header className="header">
        {ctx && <ContextRing pct={ctx.pct} level={ctx.level} />}
        <div className="header-session">
          <div className="header-title" title={title}>{title}</div>
          {subtitle && <div className="header-sub">{subtitle}</div>}
        </div>
        <nav className="view-switcher" aria-label="Views">
          {VIEW_GROUPS.map((group, gi) => (
            <span className="view-group" key={gi}>
              {group.map(([id, label]) => (
                <button
                  key={id}
                  className={`view-icon ${view === id ? "active" : ""}`}
                  title={label}
                  aria-label={label}
                  aria-pressed={view === id}
                  onClick={() => setActiveView(id)}
                >
                  {ICONS[id]}
                </button>
              ))}
            </span>
          ))}
        </nav>
        <OverflowMenu sessionId={session?.id ?? null} onGoal={() => setGoalFormOpen((v) => !v)} />
      </header>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
