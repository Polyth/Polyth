import { useEffect, useMemo, useRef, useState } from "react";
import {
  closeWorkspacePane, getState, setActiveView, useActiveModel, useStore,
  openSettingsPage, setOverlay, setRailPlugin, setSidebarOpen, setUiError, type AppView,
} from "../store.ts";
import { forkSession, exportSessionMarkdown, refreshSessions } from "../init.ts";
import { displaySessionTitle } from "../format.ts";
import { friendlyError, shortcutLabel } from "../settings.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { contextGauge, type ContextGauge } from "../reduce.ts";
import { useShellMode, type ShellMode } from "../responsiveShell.ts";
import { NarrowPanelTrigger } from "./ContextRail.tsx";
import Picker from "./Picker.tsx";
import type { PickerItem } from "../picker.ts";
import {
  TECHNICAL_GROUP_LABEL, useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import SlotHost from "./slots/SlotHost.ts";
import { Icon } from "../icons.tsx";
import CapabilityMenu from "./CapabilityMenu.tsx";
import { setWorkspaceMode, useWorkspaceMode } from "../widgets/workspaceMode.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import ChatMetrics from "./ChatMetrics.tsx";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { setPlacementOverride } from "../capabilityLayout.ts";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS: Record<AppView, React.ReactNode> = {
  session: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <path d="M2.5 3.5h11v7h-6l-2.8 2.6v-2.6h-2.2z" />
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
  workflow: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="3.5" cy="4" r="1.5" /><circle cx="3.5" cy="12" r="1.5" /><circle cx="12.5" cy="8" r="1.5" />
      <path d="M5 4h2a2 2 0 0 1 2 2v.5M5 12h2a2 2 0 0 0 2-2v-.5M9 8h2" />
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
  files: <Icon.files />,
  preview: <Icon.globe />,
  git: <Icon.tree />,
  terminal: <Icon.term />,
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

/** Primary navigation + its responsive overflow. Capabilities configured for
 *  the right rail or technical menu are owned by those surfaces; only primary
 *  header icons that do not fit create the More tools disclosure. */
function CapabilityNav() {
  const resolved = useResolvedCapabilities();
  const view = useStore((s) => s.activeView);
  const rail = useStore((s) => s.railPlugin);
  const paneFullscreen = useStore((s) => s.paneFullscreen);
  const navRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState(8);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Overflow: primary items that don't fit move into More tools; they never
  // disappear. The nav is a flex-grow container whose width tracks the free
  // header space (never its own contents — measuring content width would
  // oscillate). ~36px per icon button + room for the named trigger.
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const compute = () => setFit(Math.max(1, Math.floor((el.clientWidth - 110) / 36)));
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
  };

  const isActive = (c: ResolvedCapability): boolean => {
    const v = VIEW_OF_CAPABILITY[c.descriptor.id];
    if (v) return view === v && !(v === "session" && paneFullscreen);
    const pane = PANE_OF_CAPABILITY[c.descriptor.id];
    if (pane) return rail === pane;
    const panel = PANEL_OF_CAPABILITY[c.descriptor.id];
    return panel !== undefined && rail === panel;
  };

  const primaries = resolved.filter((c) => c.tier === "primary" && c.descriptor.available());
  let visible = primaries.slice(0, fit);
  const overflowedActive = primaries.slice(fit).find(isActive);
  if (overflowedActive) visible = [...visible.slice(0, Math.max(0, fit - 1)), overflowedActive];
  const visibleIds = new Set(visible.map((c) => c.descriptor.id));
  // The disclosure is a real overflow of configured header icons, not a
  // permanent duplicate of right-rail and technical-menu capabilities. When
  // every configured header icon fits, no empty More tools control is mounted.
  const rest = primaries.filter((c) => !visibleIds.has(c.descriptor.id));
  const reorderPrimary = (draggedId: string, targetId: string) => {
    const ids = primaries.map((capability) => capability.descriptor.id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    ids.forEach((id, rank) => setPlacementOverride(id, { tier: "primary", rank }));
  };

  return (
    <nav className="view-switcher" aria-label="Workspace tools" ref={navRef}>
      <div className="view-switcher-pill">
        {visible.map((c) => {
          const overflowed = c === overflowedActive;
          return (
            <button
              key={c.descriptor.id}
              className={`view-icon ${isActive(c) ? "active" : ""} ${overflowed ? "view-icon-named" : ""}`}
              title={c.descriptor.label}
              aria-label={c.descriptor.label}
              aria-pressed={isActive(c)}
              draggable
              onDragStart={(event) => event.dataTransfer.setData("text/polyth-capability", c.descriptor.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = event.dataTransfer.getData("text/polyth-capability");
                if (primaries.some((item) => item.descriptor.id === draggedId)) {
                  reorderPrimary(draggedId, c.descriptor.id);
                }
              }}
              onClick={() => c.descriptor.open()}
            >
              {capabilityIcon(c.descriptor.id)}
              {overflowed && <span className="view-icon-label">{c.descriptor.label}</span>}
            </button>
          );
        })}
        {rest.length > 0 && <div className="more-tools" ref={moreRef}>
          <button
            ref={triggerRef}
            className="more-tools-trigger"
            aria-expanded={moreOpen}
            aria-controls="header-capability-menu"
            onClick={() => toggleMore(!moreOpen)}
          >
            More tools
          </button>
          {moreOpen && (
            <CapabilityMenu
              id="header-capability-menu"
              className="more-tools-popup"
              capabilities={rest}
              collapseTechnical
              onClose={() => toggleMore(false)}
            />
          )}
        </div>}
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
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--border)" strokeWidth="2.6" />
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

/** UX-A390: one bounded current-view trigger replacing the desktop switcher
 *  in compact mode. Items derive from the same resolved capability list as
 *  desktop navigation. */
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
      onPick={(id) => views.find((c) => VIEW_OF_CAPABILITY[c.descriptor.id] === id)?.descriptor.open()}
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

function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onMenuKey = useDismissibleMenu({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });
  const go = (page: "access" | "about") => {
    setOpen(false);
    openSettingsPage(page);
  };
  return (
    <div className="header-user-menu">
      <button
        ref={triggerRef}
        className="header-profile"
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>PO</span><b aria-hidden="true">⌄</b>
      </button>
      {open && (
        <div className="menu-popup user-menu-popup" role="menu" aria-label="User and system" ref={menuRef} onKeyDown={onMenuKey}>
          <button role="menuitem" onClick={() => go("access")}>Access &amp; security</button>
          <button role="menuitem" onClick={() => go("about")}>About Polyth</button>
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => { setOpen(false); setOverlay("settings"); }}>All settings</button>
        </div>
      )}
    </div>
  );
}

function MobileComposerControlsMenu() {
  const ui = useUiSettings();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onMenuKey = useDismissibleMenu({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });
  const controls = [
    {
      id: "dictation",
      label: "Microphone",
      on: ui.showDictate,
      icon: <Icon.mic />,
      toggle: () => setUiSettings({ showDictate: !ui.showDictate }),
    },
  ];
  return (
    <div className="mobile-composer-menu">
      <button
        ref={triggerRef}
        className="icon-btn mobile-header-action"
        aria-label="Composer controls"
        title="Composer controls"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon.sliders />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="menu-popup mobile-composer-popup"
          role="menu"
          aria-label="Composer controls"
          onKeyDown={onMenuKey}
        >
          <div className="mobile-composer-popup-title">Composer controls</div>
          {controls.map((control) => (
            <button
              key={control.id}
              role="menuitemcheckbox"
              aria-checked={control.on}
              onClick={control.toggle}
            >
              <span className="mobile-control-icon" aria-hidden="true">{control.icon}</span>
              <span>{control.label}</span>
              <span className={`mobile-control-switch${control.on ? " on" : ""}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("polyth:open-settings"));
            }}
          >
            <span className="mobile-control-icon" aria-hidden="true"><Icon.gear /></span>
            <span>All settings</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default function Header() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const model = useActiveModel();
  const view = useStore((s) => s.activeView);
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const workspaceMode = useWorkspaceMode();

  const mode = useShellMode();
  const compact = mode !== "wide";
  const chatSurface = workspaceMode === "chat" && view === "session";
  const firstUserText = model.messages.find((message) => message.kind === "user")?.text;
  const mobileTitle = session
    ? displaySessionTitle(session.title, session.id, firstUserText)
    : "New session";
  useResizeFocusHandoff(mode);
  const switchWorkspaceMode = (next: "chat" | "widgets" | "edit") => {
    closeWorkspacePane();
    setActiveView("session");
    setWorkspaceMode(next);
  };

  // The mock's phone header replaces the compact header only at phone widths;
  // tablets (481–820px) keep the compact header with metrics and overflow.
  if (mode === "phone" && chatSurface) {
    return (
      <header className="header header-compact header-chat mobile-chat-header">
        <DrawerTrigger />
        <button
          className="mobile-session-title"
          title={mobileTitle}
          aria-label={`${mobileTitle}. Open projects and sessions`}
          onClick={() => setSidebarOpen(true)}
        >
          <span>{mobileTitle}</span>
          <Icon.chevronDown />
        </button>
        <span className="header-spacer" />
        <button
          className="icon-btn mobile-header-action"
          aria-label="Refresh sessions"
          title="Refresh sessions"
          disabled={!project}
          onClick={() => {
            if (!project) return;
            void refreshSessions(project.id).catch((error) =>
              setUiError(friendlyError("Couldn’t refresh sessions", error)));
          }}
        >
          <Icon.refresh />
        </button>
        <MobileComposerControlsMenu />
      </header>
    );
  }

  return (
    <>
      <header className={`header${compact ? " header-compact" : ""}${chatSurface ? " header-chat" : ""}`}>
        {compact && <DrawerTrigger />}
        {compact && chatSurface && (
          <button
            className="icon-btn header-project-btn"
            aria-label={compact ? "Open projects and sessions" : "Add or open a project"}
            title={compact ? project?.name || "Projects" : "Add or open a project"}
            onClick={() => compact ? setSidebarOpen(true) : setOverlay("project-picker")}
          >
            <Icon.files />
          </button>
        )}
        {(!compact || !chatSurface) && (
          <button className="header-brand" aria-label="Polyth home" onClick={() => switchWorkspaceMode("chat")}>
            <span className="polyth-mark">p</span>
            <strong>polyth</strong>
          </button>
        )}
        {(!compact || !chatSurface) && (
          <div className="workspace-mode-switch" role="group" aria-label="Workspace view">
            <button
              className={workspaceMode === "chat" ? "active" : ""}
              aria-pressed={workspaceMode === "chat"}
              onClick={() => switchWorkspaceMode("chat")}
            >Focus</button>
            <button
              className={workspaceMode !== "chat" ? "active" : ""}
              aria-pressed={workspaceMode !== "chat"}
              onClick={() => switchWorkspaceMode("widgets")}
            >Canvas</button>
          </div>
        )}
        {workspaceMode === "chat" && !compact && <CapabilityNav />}
        {chatSurface && <ChatMetrics session={session} model={model} />}
        <span className="header-spacer" />
        {workspaceMode === "chat" && !compact && session && (
          <SlotHost
            slot="session.header.actions"
            context={{ sessionId: session.id, status: session.status, working: model.turn?.status === "working" }}
          />
        )}
        {(!compact || !chatSurface) && (
          <div className="header-actions" aria-label="Application">
            <SlotHost
              slot="app.header.actions"
              context={{ projectId: project?.id ?? null, sessionId: session?.id ?? null, workspaceMode }}
            />
          </div>
        )}
        {workspaceMode === "chat" && (
          <OverflowMenu sessionId={session?.id ?? null} onGoal={() => setGoalFormOpen((value) => !value)} />
        )}
        {(!compact || !chatSurface) && <UserMenu />}
      </header>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
