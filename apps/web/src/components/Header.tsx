import { useEffect, useLayoutEffect, useRef } from "react";
import { formatCombo } from "@polyth/hotkeys";
import {
  getState, useOpenPage, useStore, workspaceProjectId,
  openSettingsPage, setOverlay, setRailPlugin, setSidebarOpen,
  toggleWorkspacePane,
} from "../store.ts";
import { MOD } from "../format.ts";
import { useShellMode, type ShellMode } from "../responsiveShell.ts";
import {
  useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { isCapabilityActive, toggleCapability } from "../builtinCapabilities.ts";
import SlotHost, { useSlotHasContent } from "./slots/SlotHost.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";
import {
  setWorkspaceEditing,
  useWorkspaceContentMode,
  useWorkspaceMode,
} from "../widgets/workspaceMode.ts";
import {
  CompassIcon, EditIcon, IconButton, InfoIcon, LinkIcon, Menu, MenuIcon, SessionIcon, SettingsIcon,
} from "./ui/index.ts";
import { OWN_ACCOUNT_TARGET } from "./settings/usersModel.ts";
import { openShellIntro } from "../shellIntro.ts";
import MobileNavigationRail from "./mobile/MobileNavigationRail.tsx";
import MobileSessionHeader from "./mobile/MobileSessionHeader.tsx";
import MobileViewHeader from "./mobile/MobileViewHeader.tsx";
import MobileWorkspaceLayer from "./mobile/MobileWorkspaceLayer.tsx";
import PhoneShellSwipes from "./mobile/PhoneShellSwipes.tsx";
import { useProfileAccount, type ProfileAccount } from "../profileAccount.ts";
import ProfileAvatar from "./ProfileAvatar.tsx";
import { tr } from "../i18n/index.ts";
import { useKeymap } from "@polyth/hotkeys/widgets";
import { useCapabilityPlacements, useRailOrders } from "../capabilityLayout.ts";
import {
  HEADER_RAIL_SLOT,
  HEADER_RAIL_SLOTS,
  TOP_RAIL_SLOT,
  capabilityWidgetHomes,
  commitRailZoneOrder,
  headerAcceptsCapability,
  orderRailItems,
  railItemRemovable,
  railWidgetFits,
  removeRailItem,
  topRailCapabilities,
} from "../railPlacement.ts";
import { useWidgetLayout } from "../widgets/widgetLayout.ts";
import { useRailDragZone } from "../railDrag.ts";
import { CAPABILITY_MIME } from "../dnd.ts";
import { isAutomaticSidebarRailApplied, useAutomaticSidebarRail, useSidebarLayout } from "../sidebarLayout.ts";
import { useUiSettings } from "../uiPrefs.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { RailWidgetItemView, useRailWidgetItems } from "./RailZoneWidgets.tsx";
import DesktopSessionStatus from "./DesktopSessionStatus.tsx";
import SpaceSwitcher from "./SpaceSwitcher.tsx";
import { railIconFor } from "../railIcons.ts";
import { switchWorkspaceMode } from "../workbench/profileNavigation.ts";
import { ownerName } from "../sessionSharing.ts";
import HeaderViewTabs from "./HeaderViewTabs.tsx";
import { shellBarReserves, useShellLayout } from "../shellLayout.ts";
import { loadSpaces, useSpaces } from "../spaces.ts";
import { soloPersonalProject } from "../personalProject.ts";

/** A former top-bar group docked in a column of the `bare` layout runs down
 *  the column instead of along the bar (shellLayout.ts, ShellDock.tsx). */
export type ShellGroupOrientation = "horizontal" | "vertical";

/** The top rail: primary-tier launchers (Terminal and Workflow start here)
 *  and widgets placed in the "Top toolbar" area, in ONE order the person
 *  controls. Every item can be reordered, moved to another rail or hidden.
 *  The `bare` window layout docks it in a column, vertically. */
export function CapabilityNav({ orientation = "horizontal" }: { orientation?: ShellGroupOrientation } = {}) {
  const vertical = orientation === "vertical";
  const resolved = useResolvedCapabilities();
  const placements = useCapabilityPlacements();
  const keymap = useKeymap();
  const centerWidgets = useSlotHasContent("app.header.center");
  const editing = useWorkspaceMode() === "edit";
  useStore((s) => `${s.activeView}:${s.railPlugin ?? ""}:${s.paneFullscreen}:${s.activePage?.pageId ?? ""}`);
  const isActive = (c: ResolvedCapability): boolean => isCapabilityActive(c.descriptor.id);

  // Workflow and Terminal retain their discoverable defaults only until the
  // user explicitly changes them; a capability whose launcher widget is placed
  // in another zone lives there instead (one home per icon, railPlacement.ts).
  const widgetLayout = useWidgetLayout();
  const topRail = topRailCapabilities(resolved, placements, capabilityWidgetHomes(widgetLayout));
  const terminalLabel = tr("terminalview.openTerminalShortcut", {
    shortcut: formatCombo(keymap.viewTerminal, MOD === "⌘"),
  });
  const topById = new Map(topRail.map((capability) => [capability.descriptor.id, capability]));
  // Widgets placed in the "Top toolbar" area are items of the same rail.
  const widgetItems = useRailWidgetItems([TOP_RAIL_SLOT], { editing: false });
  const widgetById = new Map(widgetItems.map((item) => [item.id, item]));
  const railIds = orderRailItems(
    [...topRail.map((capability) => capability.descriptor.id), ...widgetItems.map((item) => item.id)],
    useRailOrders().top,
  );
  // Drag to reorder, or pull an icon in from / out to the right rail or the
  // header rail. Landing here makes a capability primary; leaving is handled
  // by the rail it lands in.
  const drag = useRailDragZone({
    id: "top",
    axis: vertical ? "y" : "x",
    ids: railIds,
    isDraggable: (id) => widgetById.get(id)?.draggable ?? true,
    externalMime: CAPABILITY_MIME,
    accepts: (id) => railWidgetFits("top", id) || (id !== "session" && resolved.some((capability) => capability.descriptor.id === id
      && capability.descriptor.rail !== false && capability.descriptor.available())),
    commit: (order) => commitRailZoneOrder("top", order.filter((id) => widgetById.get(id)?.draggable ?? true)),
    remove: (id) => removeRailItem("top", id),
    canRemove: railItemRemovable,
  });
  // An icon rail with no icons renders nothing — not even its divider. Edit mode keeps it so its customize trigger can add
  // tools back; Settings remains the other way in. A drag from the right
  // rail mounts it too, as the landing place for its first icon.
  if (topRail.length === 0 && !centerWidgets && widgetItems.length === 0 && !editing && !drag.receiving) return null;

  return (
    <>
    {!vertical && <span className="header-divider" aria-hidden="true" />}
    <nav
      className="view-switcher customize-zone"
      data-orientation={orientation}
      aria-label={tr("header.workspaceToolsLeftOfCenter")}
    >
      <div
        className="view-switcher-pill"
        ref={drag.ref}
        {...drag.dropProps}
        data-rail-drop-target={drag.targeted || undefined}
      >
        {drag.order.map((entry) => {
          if (entry === null) return <span key={drag.slotKey} className="view-icon rail-drag-slot" data-rail-slot aria-hidden="true" />;
          const widget = widgetById.get(entry);
          if (widget) return <RailWidgetItemView key={entry} item={widget} drag={drag} />;
          const c = topById.get(entry);
          if (!c) return null;
          const terminalAction = c.descriptor.id === "terminal";
          const label = terminalAction ? terminalLabel : c.descriptor.label;
          const RailIcon = railIconFor(c.descriptor.id);
          return (
            <button
              key={c.descriptor.id}
              className={`view-icon ${isActive(c) ? "active" : ""}`}
              title={label}
              aria-label={label}
              aria-pressed={c.descriptor.kind === "command" ? undefined : isActive(c)}
              data-pane-launcher={c.descriptor.id}
              {...drag.itemProps(c.descriptor.id)}
              onClick={() => terminalAction
                ? toggleWorkspacePane("terminal")
                : toggleCapability(c.descriptor.id, c.descriptor.open)}
            >
              <RailIcon />
            </button>
          );
        })}
      </div>
      <CustomizeZoneButton slot="app.header.center" tier="primary" align="center" />
    </nav>
    </>
  );
}

/** The drawer trigger is the compact-mode entry to projects and
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
    const q = (sel: string) => document.querySelector<HTMLElement>(sel);
    let target: HTMLElement | null = null;
    if (prev) {
      if (prev.closest(".view-switcher")) target = q(".header-view-picker .picker-chip");
      else if (prev.closest(".header-view-picker")) target = q(".view-switcher .view-icon.active") ?? q(".view-switcher .view-icon");
      else if (prev.closest(".railbar")) target = q(".narrow-panel-trigger") ?? q(".plugin-strip .strip-btn.active") ?? q(".rail-toggle");
      else if (prev.closest(".narrow-panel-trigger")) target = q(".plugin-strip .strip-btn.active") ?? q(".plugin-strip .strip-btn");
      else if (prev.closest(".panel-sheet")) target = q(".plugin-strip .strip-btn.active") ?? q(".rail-toggle");
      else if (prev.closest(".header-drawer-btn")) {
        target = q(".sidebar .sidebar-expand") ?? q(".sidebar .sidebar-search input") ?? q(".sidebar .sidebar-header-search");
      }
      else if (prev.closest(".sidebar")) target = q(".header-drawer-btn");
    }
    if (target && target.getClientRects().length > 0) {
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
      return;
    }
    // No visible equivalent: never leave focus on a control with zero client
    // rects, or the browser keeps trying to reveal it inside a scroll container.
    if (active instanceof HTMLElement && active !== document.body && active.getClientRects().length === 0) {
      active.blur();
    }
  }, [mode]);
}

/** Publish the real header clusters so the chat-aligned session rail can use
 *  the space between them without covering configured actions at narrow wide
 *  widths or when the persistent sidebar is collapsed. */
function useHeaderOccupancy(active: boolean) {
  const headerRef = useRef<HTMLElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const clear = () => {
      header.style.removeProperty("--header-leading-inline-end");
      header.style.removeProperty("--header-trailing-inline-size");
    };
    if (!active) {
      clear();
      return clear;
    }
    const publish = () => {
      const box = header.getBoundingClientRect();
      const leading = leadingRef.current?.getBoundingClientRect();
      const trailing = trailingRef.current?.getBoundingClientRect();
      const rtl = getComputedStyle(header).direction === "rtl";
      header.style.setProperty(
        "--header-leading-inline-end",
        `${Math.max(0, Math.ceil(rtl
          ? box.right - (leading?.left ?? box.right)
          : (leading?.right ?? box.left) - box.left))}px`,
      );
      header.style.setProperty(
        "--header-trailing-inline-size",
        `${Math.max(0, Math.ceil(rtl
          ? (trailing?.right ?? box.left) - box.left
          : box.right - (trailing?.left ?? box.right)))}px`,
      );
    };
    publish();
    if (typeof ResizeObserver !== "function") return clear;
    const directionObserver = new MutationObserver(publish);
    directionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    if (leadingRef.current) observer.observe(leadingRef.current);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => {
      observer.disconnect();
      directionObserver.disconnect();
      clear();
    };
  }, [active]);

  return { headerRef, leadingRef, trailingRef };
}

/** What overlays the workspace's edge in the full-height layouts: the idle
 *  launcher strip and a floating package window. */
const SHELL_BAR_OVERLAYS = ":scope > .railbar > :is(.plugin-strip, .rail-dynamic)";
/** The desktop window's caption controls (desktop.tsx): they own a corner of
 *  the band the bar runs in, so the bar stops short of them too. */
const CAPTION_ZONE = ".desktop-caption-zone";

/** Between full-height columns the bar is laid over the shell instead of
 *  above it (shellLayout.css). It spans the workspace, so the chat title
 *  keeps its column, and where the strip, a floating window or the desktop
 *  caption controls overlay the workspace edge the reserve is that overlap
 *  plus the shell's column gap (shellBarReserves): the bar stops that gap
 *  before them, as it starts that gap after the navigator. Physical px: the
 *  bar never mirrors, the columns trade sides under it. */
function useShellBarFrame(headerRef: React.RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const header = headerRef.current;
    const app = header?.parentElement;
    const shell = app?.querySelector<HTMLElement>(":scope > .app-shell");
    const props = ["--shell-bar-left", "--shell-bar-right", "--shell-bar-reserve-left", "--shell-bar-reserve-right"];
    const clear = () => { for (const prop of props) header?.style.removeProperty(prop); };
    if (!active || !header || !app || !shell) {
      clear();
      return clear;
    }
    const publish = () => {
      const workspace = shell.querySelector<HTMLElement>(":scope > .workspace");
      if (!workspace) return;
      const frame = app.getBoundingClientRect();
      const lane = workspace.getBoundingClientRect();
      const overlays = [
        ...shell.querySelectorAll<HTMLElement>(SHELL_BAR_OVERLAYS),
        ...document.querySelectorAll<HTMLElement>(CAPTION_ZONE),
      ].map((el) => el.getBoundingClientRect());
      const gap = Number.parseFloat(getComputedStyle(shell).columnGap) || 0;
      const reserve = shellBarReserves(lane, overlays, gap);
      header.style.setProperty("--shell-bar-left", `${Math.round(lane.left - frame.left)}px`);
      header.style.setProperty("--shell-bar-right", `${Math.round(frame.right - lane.right)}px`);
      header.style.setProperty("--shell-bar-reserve-left", `${reserve.left}px`);
      header.style.setProperty("--shell-bar-reserve-right", `${reserve.right}px`);
    };
    publish();
    if (typeof ResizeObserver !== "function") return clear;
    const observer = new ResizeObserver(publish);
    const observeColumns = () => {
      observer.disconnect();
      observer.observe(app);
      for (const child of shell.children) observer.observe(child);
      for (const overlay of shell.querySelectorAll(SHELL_BAR_OVERLAYS)) observer.observe(overlay);
      for (const zone of document.querySelectorAll(CAPTION_ZONE)) observer.observe(zone);
    };
    observeColumns();
    // A window opening or closing swaps the railbar's children (and the
    // strip's own presence) without always resizing what is observed.
    const mutations = new MutationObserver(() => {
      observeColumns();
      publish();
    });
    mutations.observe(shell, { childList: true });
    // The caption zone mounts in <body> (among every portal, so only its own
    // arrival counts) and takes its side from a body attribute.
    const isZone = (node: Node) => node instanceof Element && node.matches(CAPTION_ZONE);
    const caption = new MutationObserver((records) => {
      if (!records.some((r) => r.type === "attributes" || [...r.addedNodes, ...r.removedNodes].some(isZone))) return;
      observeColumns();
      publish();
    });
    caption.observe(document.body, { childList: true, attributes: true, attributeFilter: ["data-desktop-caption"] });
    const railbar = shell.querySelector(":scope > .railbar");
    if (railbar) mutations.observe(railbar, { childList: true, attributes: true, attributeFilter: ["class"] });
    // A floating window slides in by transform, which no observer reports:
    // measure again once its motion settles.
    railbar?.addEventListener("animationend", publish);
    railbar?.addEventListener("transitionend", publish);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      caption.disconnect();
      railbar?.removeEventListener("animationend", publish);
      railbar?.removeEventListener("transitionend", publish);
      clear();
    };
  }, [active, headerRef]);
}

/** The top-right header rail: a rail like the top and right ones. Its items
 *  (Search, Settings, Notifications by default) reorder by drag or Alt+←/→
 *  and can be carried to or from the other two rails; each lives in one rail
 *  only (railPlacement.ts). */
export function HeaderActionsRail({ projectId, sessionId, workspaceMode, orientation = "horizontal" }: {
  projectId: string | null;
  sessionId: string | null;
  workspaceMode: string;
  orientation?: ShellGroupOrientation;
}) {
  const vertical = orientation === "vertical";
  const items = useRailWidgetItems(HEADER_RAIL_SLOTS, { projectId, sessionId, workspaceMode });
  const byId = new Map(items.map((item) => [item.id, item]));
  const movable = (id: string) => byId.get(id)?.draggable ?? true;
  const drag = useRailDragZone({
    id: "header",
    axis: vertical ? "y" : "x",
    ids: items.map((item) => item.id),
    isDraggable: movable,
    externalMime: CAPABILITY_MIME,
    accepts: (id) => railWidgetFits("header", id) || headerAcceptsCapability(id),
    commit: (order) => commitRailZoneOrder("header", order.filter(movable)),
    remove: (id) => removeRailItem("header", id),
    canRemove: railItemRemovable,
  });
  return (
    <div className="header-actions customize-zone" data-orientation={orientation} aria-label={tr("header.application")}>
      <div className="header-actions-rail" ref={drag.ref} {...drag.dropProps} data-rail-drop-target={drag.targeted || undefined}>
        {drag.order.map((entry) => {
          if (entry === null) return <span key={drag.slotKey} className="header-rail-slot rail-drag-slot" data-rail-slot aria-hidden="true" />;
          const item = byId.get(entry);
          return item ? <RailWidgetItemView key={entry} item={item} drag={drag} /> : null;
        })}
      </div>
      <CustomizeZoneButton slot={HEADER_RAIL_SLOT} slots={HEADER_RAIL_SLOTS} />
    </div>
  );
}

/** The Polyth mark: Home. The full-height layouts have no mark in their
 *  navigator columns, so the rail starts with its own controls. */
export function ShellBrand({ className = "header-brand" }: { className?: string }) {
  return (
    <button className={className} aria-label={tr("header.polythHome")} onClick={() => switchWorkspaceMode("chat")}>
      <img className="polyth-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
      <strong>{tr("header.polyth")}</strong>
    </button>
  );
}

export function UserMenu({ account, editing, className = "" }: {
  account: ProfileAccount | null;
  editing: boolean;
  className?: string;
}) {
  return (
    <div className={`header-user-menu${className ? ` ${className}` : ""}`}>
      <Menu
        label={tr("header.userAndSystem")}
        align="end"
        entries={[
          { id: "edit-workspace", label: tr("header.editMode"), icon: EditIcon, kind: "switch", checked: editing, onSelect: () => setWorkspaceEditing(!editing) },
          "separator",
          { id: "account", label: tr("header.yourAccount"), icon: SessionIcon, onSelect: () => openSettingsPage("users", { itemId: OWN_ACCOUNT_TARGET }) },
          { id: "polyth-link", label: tr("header.polythLink"), icon: LinkIcon, onSelect: () => openSettingsPage("tunnel") },
          { id: "about", label: tr("header.aboutPolyth"), icon: InfoIcon, onSelect: () => openSettingsPage("about") },
          { id: "interface-tour", label: tr("shellintro.menuEntry"), icon: CompassIcon, onSelect: () => openShellIntro() },
          "separator",
          { id: "settings", label: tr("header.allSettings"), icon: SettingsIcon, onSelect: () => setOverlay("settings") },
        ]}
      >
        {(trigger) => (
          <button
            className="header-profile"
            aria-label={account ? tr("header.valueSUserMenu", { login: account.login }) : tr("header.userMenu")}
            {...trigger}
          >
            <span className="header-profile-avatar">
              <ProfileAvatar user={account} />
            </span>
            <b aria-hidden="true">⌄</b>
          </button>
        )}
      </Menu>
    </div>
  );
}

export default function Header() {
  // A package page (an agent) owns the canvas and its own header: no chat is
  // on screen, so the chat's title and floats stand down.
  const pageOpen = useOpenPage() !== null;
  const activeSession = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const session = pageOpen ? null : activeSession;
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === workspaceProjectId(s)) ?? null);
  // A lone Personal project is not shown as a project (personalProject.ts).
  const soloPersonal = useStore((s) => soloPersonalProject(s.projectRegistry.projects) !== null);
  const projectName = soloPersonal ? undefined : project?.name;
  const view = useStore((s) => s.activeView);
  const workspaceMode = useWorkspaceMode();
  const workspaceContentMode = useWorkspaceContentMode();
  // The GitHub account behind the avatar; a local account icon when GitHub is
  // unavailable or unsigned-in (profileAccount.ts).
  const account = useProfileAccount(project?.id ?? null);

  const mode = useShellMode();
  const compact = mode !== "wide";
  const sidebarLayout = useSidebarLayout();
  const sidebarAutoRail = isAutomaticSidebarRailApplied(useAutomaticSidebarRail());
  const ui = useUiSettings();
  const shell = useShellLayout();
  const fullHeight = shell.layout !== "classic";
  const chatSurface = workspaceContentMode === "chat" && view === "session";
  const occupancy = useHeaderOccupancy(mode === "wide" && session !== null);
  // The bare layout keeps only the chat title over the conversation (and the
  // Space switcher, when there is a Space to switch to); its tools, actions
  // and account live in the columns (ShellDock.tsx).
  const spaces = useSpaces();
  // SpaceSwitcher loads the list when it mounts; the bare bar has to know
  // whether there is a choice before it can mount one.
  const bareLayout = shell.layout === "bare";
  useEffect(() => { if (bareLayout) void loadSpaces(); }, [bareLayout]);
  const multiSpace = spaces.status === "ready" && spaces.spaces.length > 1;
  const showTitle = session !== null && shell.title;
  const bareBar = shell.layout === "bare" && (showTitle || multiSpace);
  const island = shell.layout === "columns" && shell.barStyle === "island";
  useShellBarFrame(occupancy.headerRef, fullHeight && (shell.layout !== "bare" || bareBar));
  const sessionStatusContribution = session ? (
    <span className="session-header-status">
      <SlotHost
        slot="session.header.status"
        context={{ projectId: project?.id ?? null, sessionId: session.id, workspaceMode }}
      />
    </span>
  ) : null;
  useResizeFocusHandoff(mode);
  // Phone widths use one shell header for every workspace surface. Keeping the
  // choice here (rather than inside each view) prevents a surface switch from
  // bringing back the legacy compact bar.
  const windowControls = <SlotHost slot="app.window.controls" />;
  const showSessionStatus = mode === "wide" || mode === "compact";

  const barContent = (
    <>
      {compact && <DrawerTrigger />}
      {/* Tablet chat is a calm navigation bar: drawer, title, tools. The
          brand and view switch would only crowd the title there. */}
      {shell.layout === "bare" && (
        <div ref={occupancy.leadingRef} className="header-left-cluster">
          <SpaceSwitcher />
        </div>
      )}
      {shell.layout !== "bare" && !(compact && chatSurface) && <div ref={occupancy.leadingRef} className="header-left-cluster">
        {shell.layout === "classic" && <ShellBrand />}
        {/* Quiet by design: it renders only when more than one Space
            exists, and reads as a caption beside the brand. */}
        <SpaceSwitcher />
        {/* Chat, Canvas and the workbench profiles, in the person's order;
            each can be hidden (HeaderViewTabs.tsx, viewTabs.ts). */}
        {(!compact || !chatSurface || workspaceMode === "edit") && <HeaderViewTabs editing={workspaceMode === "edit"} />}
        {/* The top rail launches workspace-wide tools. Its content and
            "app.header.center" widget area stay the same in Chat, Canvas,
            and Edit; the selected main surface is controlled separately. */}
        {!compact && shell.tools === "bar" && <CapabilityNav />}
      </div>}
      {showTitle && session && (
        <DesktopSessionStatus
          showTrigger={showSessionStatus}
          trailing={sessionStatusContribution}
          caption={[
            compact ? projectName : undefined,
            // Someone else's chat names its owner, quietly, above the title.
            session.sharing?.owner ? tr("sharing.sharedBy", { name: ownerName(session.sharing.owner) }) : undefined,
          ].filter(Boolean).join(" · ") || undefined}
        />
      )}
      {compact && chatSurface && !session && (
        <div className="header-compact-title">
          <strong>{soloPersonal ? tr("sidebar.newChat") : projectName || tr("header.polyth")}</strong>
        </div>
      )}
      <span className="header-spacer" />
      {shell.layout !== "bare" && <div ref={occupancy.trailingRef} className="header-trailing-cluster">
        {(!compact || !chatSurface) && shell.actions === "bar" && (
          <HeaderActionsRail projectId={project?.id ?? null} sessionId={session?.id ?? null} workspaceMode={workspaceMode} />
        )}
        {compact && <MobileNavigationRail />}
        {(!compact || !chatSurface) && shell.account === "bar" && <UserMenu account={account} editing={workspaceMode === "edit"} />}
      </div>}
    </>
  );

  if (shell.layout === "bare" && !bareBar) return windowControls;

  if (mode === "phone") {
    return (
      <>
        {pageOpen ? null : chatSurface ? <MobileSessionHeader /> : <MobileViewHeader />}
        {/* Swipes from Chat pull the Navigator or the Workspace in. */}
        <PhoneShellSwipes />
        {/* One Workspace layer for the whole phone shell: it must outlive the
            swap between the two headers so Back always finds it in place. */}
        <MobileWorkspaceLayer />
        {windowControls}
      </>
    );
  }

  return (
    <>
      <header
        ref={occupancy.headerRef}
        className={`header${compact ? " header-compact" : ""}${chatSurface ? " header-chat" : ""}`}
        // Which bar the full-height layouts draw (shellLayout.ts): spread
        // across the gap between the columns, one island, or the bare title.
        data-shell-bar={fullHeight ? (shell.layout === "bare" ? "title" : shell.barStyle) : undefined}
        // The rail carries the surface choice itself, not just <body>, so the
        // shared glass material rules can skip it entirely when the user asked
        // for a floating rail. See the top-rail-surface block in styles.css.
        // The island and the bare title draw no slab: the island is its own
        // glass capsule inside the transparent bar.
        data-top-rail-surface={island || shell.layout === "bare" ? "floating" : ui.topRailSurface}
        // Between full-height columns the bar already starts after the
        // navigator, so the title's chat frame needs no sidebar offset.
        style={{ "--sidebar-inline-size": compact || fullHeight ? "0px" : `${sidebarLayout.collapsed || sidebarAutoRail ? 46 : sidebarLayout.width}px` } as React.CSSProperties}
      >
        {island ? <div className="shell-island ui-glass-island">{barContent}</div> : barContent}
      </header>
      {windowControls}
    </>
  );
}
