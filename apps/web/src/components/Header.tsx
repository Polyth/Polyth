import { useEffect, useRef, useState } from "react";
import { formatCombo } from "@polyth/hotkeys";
import {
  closeWorkspacePane, getState, setActiveView, useActiveModel, useStore,
  openSettingsPage, setOverlay, setRailPlugin, setSidebarOpen,
  toggleWorkspacePane, type AppView,
} from "../store.ts";
import { displaySessionTitle, MOD } from "../format.ts";
import { useShellMode, type ShellMode } from "../responsiveShell.ts";
import Picker from "./Picker.tsx";
import type { PickerItem } from "../picker.ts";
import {
  TECHNICAL_GROUP_LABEL, useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import SlotHost from "./slots/SlotHost.ts";
import { Icon } from "../icons.tsx";
import { setWorkspaceMode, useWorkspaceMode } from "../widgets/workspaceMode.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { dismissKeyboard } from "../mobileViewport.ts";
import SessionMenu from "./mobile/SessionMenu.tsx";
import Sheet, { SheetSection } from "./mobile/Sheet.tsx";
import { useSheetTrigger } from "./mobile/sheetTrigger.ts";
import { api, type GithubStatusDto } from "@polyth/session/web-api";
import { tr } from "../i18n/index.ts";
import { useKeymap } from "../../../../packages/hotkeys/widgets/hotkeys.ts";
import { listSurfaces } from "../surfaces.ts";
import { getWorkspaceSurface } from "../workspace/surfaceRegistry.ts";

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
  workflow: <Icon.workflow />,
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
  browser: <Icon.globe />,
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

/** The centered top rail renders primary capabilities plus the permanent
 *  Terminal launcher. Terminal must remain alongside the primary controls
 *  instead of depending on a customizable app.header.actions placement. */
function CapabilityNav() {
  const resolved = useResolvedCapabilities();
  const ui = useUiSettings();
  const keymap = useKeymap();
  const view = useStore((s) => s.activeView);
  const rail = useStore((s) => s.railPlugin);
  const paneFullscreen = useStore((s) => s.paneFullscreen);

  const isActive = (c: ResolvedCapability): boolean => {
    const v = VIEW_OF_CAPABILITY[c.descriptor.id];
    if (v) return view === v && !(v === "session" && paneFullscreen);
    const pane = PANE_OF_CAPABILITY[c.descriptor.id];
    if (pane) return rail === pane;
    const panel = PANEL_OF_CAPABILITY[c.descriptor.id];
    if (panel) return rail === panel;
    const packageSurface = listSurfaces().find((surface) =>
      (surface.capabilityId ?? surface.id) === c.descriptor.id);
    if (packageSurface) return rail === packageSurface.id;
    return getWorkspaceSurface(c.descriptor.id) !== undefined
      && view === c.descriptor.id;
  };

  const eligiblePrimaries = resolved.filter((c) =>
    (c.tier === "primary" || c.descriptor.id === "workflow")
    && c.descriptor.id !== "terminal"
    && c.descriptor.available());
  // Workflows is package-owned and may retain its default "more" placement.
  // Keep it beside Chat instead of at the clipped end of a busy session
  // header, so enabling the package always creates a discoverable top-rail
  // destination before the user has visited the builder.
  const workflow = eligiblePrimaries.find((c) => c.descriptor.id === "workflow");
  const primaries = workflow
    ? [
        ...eligiblePrimaries.filter((c) => c.descriptor.id === "session"),
        workflow,
        ...eligiblePrimaries.filter((c) =>
          c.descriptor.id !== "session" && c.descriptor.id !== "workflow"),
      ]
    : eligiblePrimaries;
  const terminal = resolved.find((c) =>
    c.descriptor.id === "terminal" && c.descriptor.available());
  const filesIndex = primaries.findIndex((c) => c.descriptor.id === "files");
  const terminalIndex = filesIndex < 0 ? primaries.length : filesIndex + 1;
  const topRail = terminal
    ? [...primaries.slice(0, terminalIndex), terminal, ...primaries.slice(terminalIndex)]
    : primaries;
  const terminalLabel = tr("terminalview.openTerminalShortcut", {
    shortcut: formatCombo(keymap.viewTerminal, MOD === "⌘"),
  });

  return (
    <nav
      className={`view-switcher top-rail-${ui.topRailAlignment}`}
      aria-label={ui.topRailAlignment === "left" ? tr("header.workspaceToolsLeftOfCenter") : tr("header.workspaceToolsCentered")}
    >
      <div className="view-switcher-pill">
        {topRail.map((c) => {
          const terminalAction = c.descriptor.id === "terminal";
          const label = terminalAction ? terminalLabel : c.descriptor.label;
          return (
            <button
              key={c.descriptor.id}
              className={`view-icon ${isActive(c) ? "active" : ""}`}
              title={label}
              aria-label={label}
              aria-pressed={isActive(c)}
              onClick={() => terminalAction ? toggleWorkspacePane("terminal") : c.descriptor.open()}
            >
              {capabilityIcon(c.descriptor.id)}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** One bounded workspace picker for compact layouts. Pane capabilities belong
 * here too: otherwise primary tools such as Browser disappear below 821px. */
function CompactViewPicker({ view }: { view: AppView }) {
  const resolved = useResolvedCapabilities();
  const rail = useStore((s) => s.railPlugin);
  const destination = (capability: ResolvedCapability):
    { kind: "view" | "rail"; id: string } | null => {
    const id = capability.descriptor.id;
    const builtInView = VIEW_OF_CAPABILITY[id];
    if (builtInView) return { kind: "view", id: builtInView };
    const builtInRail = PANE_OF_CAPABILITY[id] ?? PANEL_OF_CAPABILITY[id];
    if (builtInRail) return { kind: "rail", id: builtInRail };
    if (getWorkspaceSurface(id)) return { kind: "view", id };
    const packageSurface = listSurfaces().find((surface) =>
      (surface.capabilityId ?? surface.id) === id);
    return packageSurface ? { kind: "rail", id: packageSurface.id } : null;
  };
  const eligibleDestinations = resolved.filter((c) =>
    c.descriptor.available()
    && destination(c) !== null);
  // Match the desktop rail's discoverability guarantee: Workflows is
  // package-owned and normally belongs to More, but compact layouts have only
  // this picker. Keep it immediately after Chat so phones and tablets never
  // lose the destination among lower-priority tools.
  const workflow = eligibleDestinations.find((c) => c.descriptor.id === "workflow");
  const destinations = workflow
    ? [
        ...eligibleDestinations.filter((c) => c.descriptor.id === "session"),
        workflow,
        ...eligibleDestinations.filter((c) =>
          c.descriptor.id !== "session" && c.descriptor.id !== "workflow"),
      ]
    : eligibleDestinations;
  const items: PickerItem[] = destinations.map((c) => ({
    id: c.descriptor.id,
    label: c.descriptor.label,
    group: c.tier === "primary" ? "" : c.tier === "more" ? tr("header.moreTools") : TECHNICAL_GROUP_LABEL,
  }));
  const currentId = destinations.find((capability) => {
    const target = destination(capability);
    return target?.kind === "rail" ? target.id === rail : target?.id === view;
  })?.descriptor.id
    ?? "session";
  const current = items.find((i) => i.id === currentId)?.label ?? tr("header.workspace");
  return (
    <Picker
      className="header-view-picker"
      label={tr("header.view")}
      ariaLabel={tr("header.changeWorkspaceViewCurrentValue", { current: current })}
      triggerIcon={<Icon.widgets />}
      items={items}
      value={currentId}
      onPick={(id) => destinations.find((c) => c.descriptor.id === id)?.descriptor.open()}
      mobileSheet
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
      title={tr("header.openProjectsAndSessions")}
      aria-label={tr("header.openProjectsAndSessions")}
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

function UserMenu({ githubUser }: { githubUser: GithubStatusDto["user"] }) {
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
        aria-label={githubUser ? tr("header.valueSUserMenu", { login: githubUser.login }) : tr("header.userMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="header-profile-avatar">
          {githubUser
            ? <img src={githubUser.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : <Icon.session />}
        </span>
        <b aria-hidden="true">⌄</b>
      </button>
      {open && (
        <div className="menu-popup user-menu-popup" role="menu" aria-label={tr("header.userAndSystem")} ref={menuRef} onKeyDown={onMenuKey}>
          <button role="menuitem" onClick={() => go("access")}>{tr("header.accessAmpSecurity")}</button>
          <button role="menuitem" onClick={() => go("about")}>{tr("header.aboutPolyth")}</button>
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => { setOpen(false); setOverlay("settings"); }}>{tr("header.allSettings")}</button>
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
  const workspaceMode = useWorkspaceMode();
  const [githubUser, setGithubUser] = useState<GithubStatusDto["user"]>(null);

  const mode = useShellMode();
  const compact = mode !== "wide";
  const chatSurface = workspaceMode === "chat" && view === "session";
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  // §22: pointer-down activation — a click can be lost to the keyboard-dismiss
  // reflow (see components/mobile/sheetTrigger.ts).
  const sessionMenuTrigger = useSheetTrigger(mode === "phone", () => {
    setSessionMenuOpen(true);
    void dismissKeyboard();
  });
  const mobileActionsTrigger = useSheetTrigger(mode === "phone" && chatSurface, () => {
    setMobileActionsOpen(true);
    void dismissKeyboard();
  });
  const firstUserText = model.messages.find((message) => message.kind === "user")?.text;
  const mobileTitle = session
    ? displaySessionTitle(session.title, session.id, firstUserText)
    : tr("header.newSession");
  useResizeFocusHandoff(mode);
  const switchWorkspaceMode = (next: "chat" | "widgets" | "edit") => {
    closeWorkspacePane();
    setActiveView("session");
    setWorkspaceMode(next);
  };

  // The fixed user menu uses the public profile reported by gh when available.
  // It remains a local account icon when GitHub is unavailable or unsigned-in.
  useEffect(() => {
    if (!project?.id) {
      setGithubUser(null);
      return;
    }
    let stale = false;
    void api.githubStatus(project.id).then((status) => {
      if (!stale) setGithubUser(status.authenticated ? status.user : null);
    });
    return () => { stale = true; };
  }, [project?.id]);

  // The mock's phone header replaces the compact header only at phone widths;
  // tablets (481–820px) keep the compact header with metrics and overflow.
  if (mode === "phone" && chatSurface) {
    return (
      <header className="header header-compact header-chat mobile-chat-header">
        <DrawerTrigger />
        {/* UX-MOBILE-01 §21: the whole title is the target and it opens a real
            session menu (new / rename / fork / archive / recent). */}
        <button
          className="mobile-session-title"
          title={mobileTitle}
          aria-label={tr("header.valueSessionMenu", { mobileTitle: mobileTitle })}
          aria-haspopup="dialog"
          aria-expanded={sessionMenuOpen}
          {...sessionMenuTrigger}
        >
          <span>{mobileTitle}</span>
          <Icon.chevronDown />
        </button>
        {sessionMenuOpen && <SessionMenu onClose={() => setSessionMenuOpen(false)} />}
        <CompactViewPicker view={view} />
        <button
          type="button"
          className="icon-btn mobile-header-action mobile-header-more"
          title={tr("common.more")}
          aria-label={tr("common.more")}
          aria-haspopup="dialog"
          aria-expanded={mobileActionsOpen}
          {...mobileActionsTrigger}
        >
          <Icon.more />
        </button>
        {mobileActionsOpen && (
          <Sheet title={tr("common.more")} className="mobile-header-actions-sheet" onClose={() => setMobileActionsOpen(false)}>
            <div
              className="mobile-header-actions-list"
              onClick={(event) => {
                const target = event.target instanceof Element ? event.target.closest("button") : null;
                // GoalAction can open a dialog owned by its slot component, so
                // keep that host mounted. Global-overlay actions can dismiss
                // the sheet after their own click handler has run.
                if (target && !target.classList.contains("composer-goals")) setMobileActionsOpen(false);
              }}
            >
              {session && (
                <SheetSection title={tr("mobile.sessionmenu.sessionActions")}>
                  <SlotHost
                    slot="session.header.actions"
                    context={{ sessionId: session.id, status: session.status, working: model.turn?.status === "working" }}
                  />
                </SheetSection>
              )}
              <SheetSection title={tr("header.application")}>
                <SlotHost
                  slot="app.header.actions"
                  context={{ projectId: project?.id ?? null, sessionId: session?.id ?? null, workspaceMode }}
                />
              </SheetSection>
            </div>
          </Sheet>
        )}
        <SlotHost slot="app.window.controls" />
      </header>
    );
  }

  return (
    <>
      <header className={`header${compact ? " header-compact" : ""}${chatSurface ? " header-chat" : " header-tool-view"}`}>
        {compact && <DrawerTrigger />}
        {compact && chatSurface && (
          <button
            className="icon-btn header-project-btn"
            aria-label={compact ? tr("header.openProjectsAndSessions") : tr("header.addOrOpenAProject")}
            title={compact ? project?.name || tr("settings.pages.projects") : tr("header.addOrOpenAProject")}
            onClick={() => compact ? setSidebarOpen(true) : setOverlay("project-picker")}
          >
            <Icon.files />
          </button>
        )}
        {compact && <CompactViewPicker view={view} />}
        {(!compact || !chatSurface) && (
          <button className="header-brand" aria-label={tr("header.polythHome")} onClick={() => switchWorkspaceMode("chat")}>
            <span className="polyth-mark">{tr("header.p")}</span>
            <strong>{tr("header.polyth")}</strong>
          </button>
        )}
        {(!compact || !chatSurface) && (
          <div className="workspace-mode-switch" role="group" aria-label={tr("header.workspaceView")}>
            <button
              className={workspaceMode === "chat" ? "active" : ""}
              aria-pressed={workspaceMode === "chat"}
              onClick={() => switchWorkspaceMode("chat")}
            >{tr("header.chat")}</button>
            <button
              className={workspaceMode !== "chat" ? "active" : ""}
              aria-pressed={workspaceMode !== "chat"}
              onClick={() => switchWorkspaceMode("widgets")}
            >{tr("header.canvas")}</button>
          </div>
        )}
        {workspaceMode === "chat" && !compact && <CapabilityNav />}
        <span className="header-spacer" />
        {(!compact || !chatSurface) && (
          <div className="header-actions" aria-label={tr("header.application")}>
            {workspaceMode === "chat" && session && (
              <SlotHost
                slot="session.header.actions"
                context={{ sessionId: session.id, status: session.status, working: model.turn?.status === "working" }}
              />
            )}
            <SlotHost
              slot="app.header.actions"
              context={{ projectId: project?.id ?? null, sessionId: session?.id ?? null, workspaceMode }}
            />
          </div>
        )}
        {(!compact || !chatSurface) && <UserMenu githubUser={githubUser} />}
        <SlotHost slot="app.window.controls" />
      </header>
    </>
  );
}
