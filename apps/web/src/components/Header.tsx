import { useEffect, useRef, useState, type DragEvent } from "react";
import { formatCombo } from "@polyth/hotkeys";
import {
  closeWorkspacePane, getState, setActiveView, useStore,
  openSettingsPage, setOverlay, setRailPlugin, setSidebarOpen,
  toggleWorkspacePane, type AppView,
} from "../store.ts";
import { MOD } from "../format.ts";
import { useShellMode, type ShellMode } from "../responsiveShell.ts";
import {
  useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { isCapabilityActive, toggleCapability, VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import SlotHost from "./slots/SlotHost.ts";
import { Icon } from "../icons.tsx";
import { setWorkspaceMode, useWorkspaceMode } from "../widgets/workspaceMode.ts";
import {
  FolderIcon, IconButton, InfoIcon, LockIcon, Menu, MenuIcon, SettingsIcon,
  type MenuEntry,
} from "./ui/index.ts";
import MobileNavigationRail from "./mobile/MobileNavigationRail.tsx";
import MobileSessionHeader from "./mobile/MobileSessionHeader.tsx";
import MobileViewHeader from "./mobile/MobileViewHeader.tsx";
import { api, type GithubStatusDto } from "@polyth/session/web-api";
import { tr } from "../i18n/index.ts";
import { useKeymap } from "@polyth/hotkeys/widgets";
import { getDragCapability, setDragCapability, CAPABILITY_MIME } from "../dnd.ts";
import {
  moveCapabilityBefore, setCapabilityTierOrder, setPlacementOverride, useCapabilityPlacements,
} from "../capabilityLayout.ts";
import { useCustomizeActive } from "../useShiftArmed.ts";
import { useSidebarLayout } from "../sidebarLayout.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import DesktopSessionStatus from "./DesktopSessionStatus.tsx";
import SpaceSwitcher from "./SpaceSwitcher.tsx";
import { railIconFor } from "../railIcons.ts";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS: Record<AppView, React.ReactNode> = {
  session: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <path d="M2.5 3.5h11v7h-6l-2.8 2.6v-2.6h-2.2z" />
    </svg>
  ),
  goals: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.5" />
    </svg>
  ),
  multirun: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <rect x="2" y="3" width="3.2" height="10" rx="1" /><rect x="6.4" y="3" width="3.2" height="10" rx="1" /><rect x="10.8" y="3" width="3.2" height="10" rx="1" />
    </svg>
  ),
  workflow: <Icon.workflow />,
  fusion: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="6" cy="8" r="4.2" /><circle cx="10" cy="8" r="4.2" />
    </svg>
  ),
  walkthrough: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <path d="M3 4h2M3 8h2M3 12h2M8 4h5M8 8h5M8 12h5" />
    </svg>
  ),
  schedule: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2.2 1.3" />
    </svg>
  ),
  github: (
    <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" {...STROKE}>
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
  const placements = useCapabilityPlacements();
  const keymap = useKeymap();
  const customizeActive = useCustomizeActive();
  useStore((s) => `${s.activeView}:${s.railPlugin ?? ""}:${s.paneFullscreen}`);
  const isActive = (c: ResolvedCapability): boolean => isCapabilityActive(c.descriptor.id);

  // Workflow and Terminal retain their discoverable defaults only until the
  // user explicitly changes them. Thereafter the persisted tier/rank is the
  // whole truth, so drag order and active/inactive choices survive reloads.
  const defaultPinned = (id: string) => (id === "workflow" || id === "terminal") && placements[id] === undefined;
  let topRail = resolved.filter((capability) =>
    capability.descriptor.available() && (capability.tier === "primary" || defaultPinned(capability.descriptor.id)));
  const moveAfter = (items: ResolvedCapability[], id: string, afterId: string): ResolvedCapability[] => {
    const item = items.find((candidate) => candidate.descriptor.id === id);
    if (!item) return items;
    const next = items.filter((candidate) => candidate !== item);
    const at = next.findIndex((candidate) => candidate.descriptor.id === afterId);
    next.splice(at < 0 ? next.length : at + 1, 0, item);
    return next;
  };
  if (placements.workflow === undefined) topRail = moveAfter(topRail, "workflow", "session");
  if (placements.terminal === undefined) topRail = moveAfter(topRail, "terminal", "files");
  const terminalLabel = tr("terminalview.openTerminalShortcut", {
    shortcut: formatCombo(keymap.viewTerminal, MOD === "⌘"),
  });
  const dropBefore = (event: DragEvent<HTMLButtonElement>, targetId: string) => {
    const draggedId = getDragCapability(event.dataTransfer);
    if (!draggedId) return;
    event.preventDefault();
    setCapabilityTierOrder("primary", moveCapabilityBefore(
      topRail.map((capability) => capability.descriptor.id), draggedId, targetId,
    ));
  };
  const topIds = new Set(topRail.map((capability) => capability.descriptor.id));
  const rankAfter = (tier: "primary" | "technical") =>
    Math.max(-1, ...resolved.filter((capability) => capability.tier === tier).map((capability) => capability.rank)) + 1;
  const entryFor = (capability: ResolvedCapability, checked: boolean): MenuEntry => ({
    id: `capability:${capability.descriptor.id}`,
    label: capability.descriptor.label,
    icon: railIconFor(capability.descriptor.id),
    kind: "checkbox",
    checked,
    disabled: capability.descriptor.id === "session",
    onSelect: () => setPlacementOverride(capability.descriptor.id, checked
      ? { tier: "technical", rank: rankAfter("technical") }
      : { tier: "primary", rank: rankAfter("primary") }),
  });
  const available = resolved.filter((capability) => capability.descriptor.available());
  const capabilityEntries: MenuEntry[] = [
    { heading: tr("settings.packagespage.enabled") },
    ...available.filter((capability) => topIds.has(capability.descriptor.id)).map((capability) => entryFor(capability, true)),
    "separator",
    { heading: tr("settings.packagespage.disabled") },
    ...available.filter((capability) => !topIds.has(capability.descriptor.id)).map((capability) => entryFor(capability, false)),
  ];

  return (
    <nav
      className="view-switcher customize-zone"
      aria-label={tr("header.workspaceToolsLeftOfCenter")}
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
              draggable={customizeActive}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragCapability(event.dataTransfer, c.descriptor.id);
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(CAPABILITY_MIME)) event.preventDefault();
              }}
              onDrop={(event) => dropBefore(event, c.descriptor.id)}
              onClick={() => terminalAction
                ? toggleWorkspacePane("terminal")
                : toggleCapability(c.descriptor.id, c.descriptor.open)}
            >
              {capabilityIcon(c.descriptor.id)}
            </button>
          );
        })}
        {/* Widget-areas (WA3): widgets placed into the "Top toolbar" area
            render alongside the built-in tier rail. */}
        <SlotHost slot="app.header.center" context={{ editing: false }} customizable />
        <Menu
          label="More workspace tools"
          align="start"
          entries={topRail.map((capability) => ({
            id: `open:${capability.descriptor.id}`,
            label: capability.descriptor.label,
            onSelect: () => capability.descriptor.id === "terminal"
              ? toggleWorkspacePane("terminal")
              : toggleCapability(capability.descriptor.id, capability.descriptor.open),
          }))}
        >
          {(trigger) => <button className="view-icon header-rail-overflow" title="More workspace tools" aria-label="More workspace tools" {...trigger}><Icon.more /></button>}
        </Menu>
      </div>
      <CustomizeZoneButton slot="app.header.center" extraEntries={capabilityEntries} />
    </nav>
  );
}

/** UX-A390: the drawer trigger is the compact-mode entry to projects and
 *  sessions. Opening the drawer closes an open panel first — there is at most
 *  one shell-modal surface. */
function DrawerTrigger() {
  const open = useStore((s) => s.sidebarOpen);
  return (
    <IconButton
      icon={MenuIcon}
      label={tr("header.openProjectsAndSessions")}
      size="lg"
      className="header-drawer-btn"
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
    />
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
    else if (prev.closest(".header-drawer-btn")) {
      target = q(".sidebar .sidebar-expand") ?? q(".sidebar .sidebar-search input");
    }
    else if (prev.closest(".sidebar")) target = q(".header-drawer-btn");
    if (!target || target.getClientRects().length === 0) return;
    target.focus();
    // The compact drawer removes `inert` in its own effect after this header
    // effect runs. Retry once after that effect flushes if the first focus was
    // suppressed by the still-inert ancestor.
    if (document.activeElement !== target && typeof requestAnimationFrame === "function") {
      const focusRaf = requestAnimationFrame(() => {
        if (target?.isConnected && target.getClientRects().length > 0) target.focus();
      });
      return () => cancelAnimationFrame(focusRaf);
    }
  }, [mode]);
}

function UserMenu({ githubUser }: { githubUser: GithubStatusDto["user"] }) {
  return (
    <div className="header-user-menu">
      <Menu
        label={tr("header.userAndSystem")}
        align="end"
        entries={[
          { id: "access", label: tr("header.accessAmpSecurity"), icon: LockIcon, onSelect: () => openSettingsPage("access") },
          { id: "about", label: tr("header.aboutPolyth"), icon: InfoIcon, onSelect: () => openSettingsPage("about") },
          "separator",
          { id: "settings", label: tr("header.allSettings"), icon: SettingsIcon, onSelect: () => setOverlay("settings") },
        ]}
      >
        {(trigger) => (
          <button
            className="header-profile"
            aria-label={githubUser ? tr("header.valueSUserMenu", { login: githubUser.login }) : tr("header.userMenu")}
            {...trigger}
          >
            <span className="header-profile-avatar">
              {githubUser
                ? <img src={githubUser.avatarUrl} alt="" referrerPolicy="no-referrer" />
                : <Icon.session />}
            </span>
            <b aria-hidden="true">⌄</b>
          </button>
        )}
      </Menu>
    </div>
  );
}

export default function Header() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const view = useStore((s) => s.activeView);
  const workspaceMode = useWorkspaceMode();
  const [githubUser, setGithubUser] = useState<GithubStatusDto["user"]>(null);

  const mode = useShellMode();
  const compact = mode !== "wide";
  const sidebarLayout = useSidebarLayout();
  const chatSurface = workspaceMode === "chat" && view === "session";
  useResizeFocusHandoff(mode);
  const switchWorkspaceMode = (next: "chat" | "widgets") => {
    closeWorkspacePane();
    setActiveView("session");
    setWorkspaceMode(next);
  };

  // Project activation only reads cached profile data and local remotes.
  // It remains a local account icon when GitHub is unavailable or unsigned-in.
  useEffect(() => {
    if (!project?.id) {
      setGithubUser(null);
      return;
    }
    let stale = false;
    void api.githubStatus(project.id, true).then((status) => {
      if (!stale) setGithubUser(status.authenticated ? status.user : null);
    });
    return () => { stale = true; };
  }, [project?.id]);

  // Phone widths use one shell header for every workspace surface. Keeping the
  // choice here (rather than inside each view) prevents a surface switch from
  // bringing back the legacy compact bar.
  if (mode === "phone") {
    return chatSurface ? <MobileSessionHeader /> : <MobileViewHeader />;
  }

  return (
    <>
      <header
        className={`header${compact ? " header-compact" : ""}${chatSurface ? " header-chat" : ""}`}
        style={{ "--sidebar-inline-size": compact ? "0px" : `${sidebarLayout.collapsed ? 46 : sidebarLayout.width}px` } as React.CSSProperties}
      >
        {compact && <DrawerTrigger />}
        {compact && chatSurface && (
          <IconButton
            icon={FolderIcon}
            label={tr("header.openProjectsAndSessions")}
            size="lg"
            className="header-project-btn"
            title={project?.name || tr("settings.pages.projects")}
            onClick={() => setSidebarOpen(true)}
          />
        )}
        <div className="header-left-cluster">
          {(!compact || !chatSurface) && <button className="header-brand header-control" aria-label={tr("header.polythHome")} onClick={() => switchWorkspaceMode("chat")}>
            <span className="polyth-mark">{tr("header.p")}</span>
            <strong>{tr("header.polyth")}</strong>
          </button>}
          {/* Quiet by design: it renders only when more than one Space
              exists, and reads as a caption beside the brand. */}
          <SpaceSwitcher />
          {(!compact || !chatSurface) && <div className="workspace-mode-switch" role="group" aria-label={tr("header.workspaceView")}>
            <button className={workspaceMode === "chat" ? "active" : ""} aria-pressed={workspaceMode === "chat"} onClick={() => switchWorkspaceMode("chat")}>{tr("header.chat")}</button>
            <button className={workspaceMode !== "chat" ? "active" : ""} aria-pressed={workspaceMode !== "chat"} onClick={() => switchWorkspaceMode("widgets")}>{tr("header.canvas")}</button>
          </div>}
          {workspaceMode === "chat" && !compact && <><span className="header-divider" aria-hidden="true" /><CapabilityNav /></>}
        </div>
        {!compact && session && <DesktopSessionStatus />}
        <span className="header-spacer" />
        {(!compact || !chatSurface) && (
          <div className="header-actions customize-zone" aria-label={tr("header.application")}>
            <SlotHost
              slot="session.header.actions"
              context={{ projectId: project?.id ?? null, sessionId: session?.id ?? null, workspaceMode }}
              customizable
            />
            <SlotHost
              slot="app.header.actions"
              context={{ projectId: project?.id ?? null, sessionId: session?.id ?? null, workspaceMode }}
              customizable
            />
            <CustomizeZoneButton
              slot="app.header.actions"
              slots={["session.header.actions", "app.header.actions"]}
            />
          </div>
        )}
        {compact && <MobileNavigationRail />}
        {(!compact || !chatSurface) && <UserMenu githubUser={githubUser} />}
        <SlotHost slot="app.window.controls" />
      </header>
    </>
  );
}
