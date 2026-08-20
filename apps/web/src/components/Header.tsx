import { useEffect, useMemo, useRef, useState } from "react";
import { getState, useActiveModel, useStore, setActiveView, setRailPlugin, setSidebarOpen, setUiError, type AppView } from "../store.ts";
import { forkSession, exportSessionMarkdown } from "../init.ts";
import { displaySessionTitle } from "../format.ts";
import { friendlyError, shortcutLabel } from "../settings.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { contextGauge, type ContextGauge } from "../reduce.ts";
import { api } from "../api.ts";
import { useShellMode, type ShellMode } from "../responsiveShell.ts";
import { NarrowPanelTrigger } from "./ContextRail.tsx";
import Picker from "./Picker.tsx";
import type { PickerItem } from "../picker.ts";
import {
  GROUP_ORDER, TECHNICAL_GROUP_LABEL, capabilityGroup, useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { getPresetState, setMoreToolsOpen } from "../workspacePresets.ts";
import { PANEL_OF_CAPABILITY, VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import { Icon } from "../icons.tsx";

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

// Icons for capabilities that are not full views (panels, settings pages).
const EXTRA_ICONS: Record<string, React.ReactNode> = {
  usage: <Icon.usage />,
  events: <Icon.events />,
  context: <Icon.context />,
  knowledge: <Icon.book />,
  voice: <Icon.mic />,
  "models-agents": <Icon.gear />,
  diagnostics: <Icon.shield />,
};

function capabilityIcon(id: string): React.ReactNode {
  const view = VIEW_OF_CAPABILITY[id];
  if (view && ICONS[view]) return ICONS[view];
  return EXTRA_ICONS[id] ?? <Icon.context />;
}

/** Primary navigation + the named More tools disclosure. Every surface
 *  resolves the same capability list — nothing is filtered out here; items
 *  that don't fit overflow into More tools, and an active overflowed item
 *  stays named in the header. */
function CapabilityNav() {
  const resolved = useResolvedCapabilities();
  const view = useStore((s) => s.activeView);
  const rail = useStore((s) => s.railPlugin);
  const navRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState(8);
  const [moreOpen, setMoreOpen] = useState(() => getPresetState().moreToolsOpen);
  const [techOpen, setTechOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Overflow: primary items that don't fit move into More tools; they never
  // disappear. ~36px per icon button + room for the named trigger.
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const compute = () => setFit(Math.max(1, Math.floor((el.clientWidth - 96) / 36)));
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) toggleMore(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        toggleMore(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreOpen]);

  const toggleMore = (open: boolean) => {
    setMoreOpen(open);
    setMoreToolsOpen(open); // stored separately from the preset
  };

  const isActive = (c: ResolvedCapability): boolean => {
    const v = VIEW_OF_CAPABILITY[c.descriptor.id];
    if (v) return view === v;
    const panel = PANEL_OF_CAPABILITY[c.descriptor.id];
    return panel !== undefined && rail === panel;
  };

  const primaries = resolved.filter((c) => c.tier === "primary" && c.descriptor.available());
  let visible = primaries.slice(0, fit);
  const overflowedActive = primaries.slice(fit).find(isActive);
  if (overflowedActive) visible = [...visible.slice(0, Math.max(0, fit - 1)), overflowedActive];
  const visibleIds = new Set(visible.map((c) => c.descriptor.id));
  // Everything else (overflowed primaries + more + technical) stays reachable
  // through the named disclosure, grouped by user outcome.
  const rest = resolved.filter((c) => !visibleIds.has(c.descriptor.id));

  const groups = GROUP_ORDER
    .map((label) => ({
      label,
      items: rest.filter((c) => capabilityGroup(c.descriptor.id) === label),
    }))
    .filter((g) => g.items.length > 0);

  const itemButton = (c: ResolvedCapability) => {
    const available = c.descriptor.available();
    const reason = available ? null : c.descriptor.unavailableReason?.() ?? "Unavailable right now";
    const alias = c.descriptor.technicalLabel && c.descriptor.technicalLabel !== c.descriptor.label
      ? ` (${c.descriptor.technicalLabel})`
      : "";
    return (
      <button
        key={c.descriptor.id}
        role="menuitem"
        className="more-tools-item"
        disabled={!available}
        title={reason ?? c.descriptor.plainDescription}
        onClick={() => {
          toggleMore(false);
          c.descriptor.open();
        }}
      >
        <span>{c.descriptor.label}{alias}</span>
        {!available && reason && <span className="more-tools-reason">{reason}</span>}
      </button>
    );
  };

  return (
    <nav className="view-switcher" aria-label="Workspace tools" ref={navRef}>
      {visible.map((c) => {
        const overflowed = c === overflowedActive;
        return (
          <button
            key={c.descriptor.id}
            className={`view-icon ${isActive(c) ? "active" : ""} ${overflowed ? "view-icon-named" : ""}`}
            title={c.descriptor.label}
            aria-label={c.descriptor.label}
            aria-pressed={isActive(c)}
            onClick={() => c.descriptor.open()}
          >
            {capabilityIcon(c.descriptor.id)}
            {overflowed && <span className="view-icon-label">{c.descriptor.label}</span>}
          </button>
        );
      })}
      <div className="more-tools" ref={moreRef}>
        <button
          ref={triggerRef}
          className="more-tools-trigger"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => toggleMore(!moreOpen)}
        >
          More tools
        </button>
        {moreOpen && (
          <div className="more-tools-popup" role="menu" aria-label="More tools">
            {groups.map((g) =>
              g.label === TECHNICAL_GROUP_LABEL ? (
                <div className="more-tools-group" key={g.label}>
                  <button
                    className="more-tools-group-head"
                    aria-expanded={techOpen}
                    onClick={() => setTechOpen((v) => !v)}
                  >
                    <span className="more-tools-group-arrow" aria-hidden="true">{techOpen ? "▾" : "▸"}</span>
                    {TECHNICAL_GROUP_LABEL}
                  </button>
                  {techOpen && g.items.map(itemButton)}
                </div>
              ) : (
                <div className="more-tools-group" key={g.label}>
                  <div className="more-tools-group-label">{g.label}</div>
                  {g.items.map(itemButton)}
                </div>
              ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function ContextRing({ gauge }: { gauge: ContextGauge }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const pct = gauge.known ? gauge.percent : 0;
  const dash = (pct / 100) * c;
  const label = gauge.known
    ? `${pct}% context estimate (${gauge.inputTokens} of ${gauge.contextTokens} tokens)`
    : "Context estimate unknown — model metadata unavailable";
  return (
    <svg className={`ctx-ring ${gauge.level}`} width="30" height="30" viewBox="0 0 36 36" aria-label={label}>
      <title>{label}</title>
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
      <text x="18" y="19.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor">
        {gauge.known ? pct : "?"}
      </text>
    </svg>
  );
}

/** F18: loud auto-accept indicator + toggle. The server owns the policy; the
 *  effective value rides the projection so an inherited "on" (subagent under
 *  an enabled parent) lights up too. Session-scoped only — never global.
 *  UX-A390: at phone the label is visually hidden (icon-only 44px target) but
 *  the accessible name always carries the on/off state — never color alone. */
function AutoAcceptChip({ sessionId, effective }: { sessionId: string; effective: boolean }) {
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    // The response also reconciles pending requests server-side; the updated
    // projection broadcast flips `effective` here without local state.
    void api.autoAcceptSet(sessionId, effective ? "off" : "on")
      .catch((e) => setUiError(friendlyError("Couldn’t change auto-accept", e)))
      .finally(() => setBusy(false));
  };
  return (
    <button
      className={`auto-accept-chip ${effective ? "on" : ""}`}
      title={effective
        ? "Auto-accept is ON: permission requests in this session are approved automatically. Click to turn off."
        : "Auto-accept permission requests in this session"}
      aria-label={effective ? "Auto-accept on" : "Auto-accept off"}
      aria-pressed={effective}
      disabled={busy}
      onClick={toggle}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" {...STROKE}>
        <path d="M8 1.8 13.5 4v4.2c0 3.2-2.3 5.3-5.5 6-3.2-.7-5.5-2.8-5.5-6V4z" />
        {effective && <path d="M5.4 8.2 7.2 10l3.4-3.6" />}
      </svg>
      <span className="auto-accept-text">{effective ? "Auto-accept on" : "Auto-accept"}</span>
    </button>
  );
}

/** UX-A390: one bounded current-view trigger replacing the desktop switcher
 *  in compact mode. Items derive from the same resolved capability list as
 *  desktop navigation; presets reorder but never remove them. */
function CompactViewPicker({ view }: { view: AppView }) {
  const resolved = useResolvedCapabilities();
  const views = resolved.filter((c) => VIEW_OF_CAPABILITY[c.descriptor.id] !== undefined);
  const items: PickerItem[] = views.map((c) => ({
    id: VIEW_OF_CAPABILITY[c.descriptor.id]!,
    label: c.descriptor.label,
    group: c.tier === "primary" ? "" : c.tier === "more" ? "More tools" : TECHNICAL_GROUP_LABEL,
  }));
  const current = items.find((i) => i.id === view)?.label ?? view;
  return (
    <Picker
      className="header-view-picker"
      label="View"
      ariaLabel={`Change workspace view, current: ${current}`}
      triggerIcon={ICONS[view]}
      items={items}
      value={view}
      onPick={(id) => setActiveView(id as AppView)}
    />
  );
}

/** UX-A390: the drawer trigger is the compact-mode entry to projects and
 *  sessions. Opening the drawer closes an open panel first — there is at most
 *  one shell-modal surface. */
function DrawerTrigger() {
  const open = useStore((s) => s.sidebarOpen);
  return (
    <button
      className="icon-btn header-drawer-btn"
      title="Open projects and sessions"
      aria-label="Open projects and sessions"
      aria-controls="polyth-session-drawer"
      aria-expanded={open}
      onClick={() => {
        if (open) {
          setSidebarOpen(false);
          return;
        }
        if (getState().railPlugin !== null) setRailPlugin(null);
        setSidebarOpen(true);
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      </svg>
    </button>
  );
}

/** A resize that hides the focused control moves focus to the equivalent
 *  visible trigger; focus never remains in unmounted or hidden content. */
function useResizeFocusHandoff(mode: ShellMode) {
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el !== document.body) lastFocus.current = el;
    };
    document.addEventListener("focusin", remember);
    remember();
    return () => document.removeEventListener("focusin", remember);
  }, []);

  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.getClientRects().length > 0) return;
    const prev = lastFocus.current;
    if (!prev) return;
    const q = (sel: string) => document.querySelector<HTMLElement>(sel);
    let target: HTMLElement | null = null;
    if (prev.closest(".view-switcher")) target = q(".header-view-picker .picker-chip");
    else if (prev.closest(".header-view-picker")) target = q(".view-switcher .view-icon.active") ?? q(".view-switcher .view-icon");
    else if (prev.closest(".railbar")) target = q(".narrow-panel-trigger");
    else if (prev.closest(".narrow-panel-trigger")) target = q(".plugin-strip .strip-btn.active") ?? q(".plugin-strip .strip-btn");
    else if (prev.closest(".panel-sheet")) target = q(".plugin-strip .strip-btn.active") ?? q(".rail-toggle");
    else if (prev.closest(".header-drawer-btn")) target = q(".sidebar .side-icons .icon-btn");
    if (target && target.getClientRects().length > 0) target.focus();
  }, [mode]);
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
  const view = useStore((s) => s.activeView);
  const branch = useStore((s) => s.gitBranch);
  const models = useStore((s) => s.models);
  const model = useActiveModel();
  const ctx = useMemo(() => {
    const ref = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
    if (!ref) return null;
    const descriptor = models.find(
      (candidate) => candidate.providerID === ref.providerID && candidate.modelID === ref.modelID,
    );
    return contextGauge(model, descriptor?.context);
  }, [model, session?.model, models]);
  const [goalFormOpen, setGoalFormOpen] = useState(false);

  const firstUserText = useMemo(() => {
    const first = model.messages.find((m) => m.kind === "user");
    return first && first.kind === "user" ? (first.text || first.raw) : undefined;
  }, [model.messages]);

  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserText)
    : project?.name || project?.path || "Polyth";
  const subtitle = [project?.name || project?.path, branch].filter(Boolean).join(" · ");

  const mode = useShellMode();
  const compact = mode !== "wide";
  useResizeFocusHandoff(mode);

  return (
    <>
      <header className={`header${compact ? " header-compact" : ""}`}>
        {compact && <DrawerTrigger />}
        {ctx && <ContextRing gauge={ctx} />}
        <div className="header-session">
          <div className="header-title" title={title}>{title}</div>
          {subtitle && <div className="header-sub">{subtitle}</div>}
        </div>
        {session && <AutoAcceptChip sessionId={session.id} effective={!!session.autoAccept} />}
        {compact ? (
          <CompactViewPicker view={view} />
        ) : (
          <CapabilityNav />
        )}
        <OverflowMenu sessionId={session?.id ?? null} onGoal={() => setGoalFormOpen((v) => !v)} />
        {compact && <NarrowPanelTrigger />}
      </header>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
