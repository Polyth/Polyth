// Right-pane surface host. The rail renders whatever the
// surface registry holds (built-ins register in railSurfaces.tsx; plugins
// arrive through the "workspace.right.tabs" slot or window.__polythSurfaces)
// — this component never enumerates panels.
//
// Canonical workspace surfaces (Files/Git/Terminal/Preview) get the adaptive
// pane shell: container-geometry dock admission with a 320px Chat floor, an
// accessible resize separator, explicit Expand, and an automatic full-screen
// fallback over a still-mounted, inert Chat. Contextual surfaces (Context/
// Knowledge/Usage/Events) keep their simple docked panel. Visited surfaces
// stay mounted (keep-alive, inert while hidden) so tree, editor, terminal,
// and preview state survive switching. Widths persist per surface —
// contextual in polyth.railPrefs, workspace-pane dimensions/resources and
// pinned open surfaces per project in polyth.workspacePane.v2.<projectId>.
import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { formatCombo } from "@polyth/hotkeys";
import SlotHost, { useSlotHasContent, useSlotVersion } from "./slots/SlotHost.ts";
import ModuleView, { type ModuleDockAction } from "./ui/ModuleView.ts";
import { useShellDirection } from "../shellDirection.ts";
import { isImeComposing } from "./input/editorCore.ts";
import {
  closeAllModules, closePaneFromOutside, closeWorkspacePane, handlePaneEscape, setPaneFullscreen,
  togglePaneFullscreen, togglePanePin,
  getState, setRailPlugin, setSidebarOpen, toggleRailPlugin, useActiveModel, useStore, workspaceProjectId,
} from "../store.ts";
import { useGitStatus } from "../../../../packages/git/widgets/gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  CHAT_FLOOR, clampDockWidth, commitFocusedChatWidth, decideDock, decideFocusedSplit, FOCUSED_WORK_MAX, FOCUSED_WORK_MIN, keptSurfaces, listSurfaces, paneDockEdge, paneDockOptions, paneWindowLayout, slotSurfaces, useSurfaceVersion, visibleSurfaces,
  type DockDecision, type DockGeometry, type FocusedSplitDecision, type RailSurface, type RailSurfaceContext, type WorkspacePaneDock, type WorkspacePaneMode,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useSideSafeStrip } from "../sideSafeStrip.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { useResolvedCapabilities, type ResolvedCapability } from "../capabilities.ts";
import { isCapabilityActive, toggleCapability } from "../builtinCapabilities.ts";
import { uniquePackageLaunchers } from "../packageLaunchers.ts";
import { useWorkspaceMode } from "../widgets/workspaceMode.ts";
import {
  clampPaneDimension, getWorkspacePanePrefs, paneLayoutKey, SHARED_PINNED_PANE_KEY, setPaneDockEdge, setPaneDynamicHeight,
  setPanePreferredWidth, setSplitChatWidth,
} from "../workspace/panePrefs.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { useWorkbenchNavigation, useWorkbenchShellPresentation } from "../workbench/profileNavigation.ts";
import { chatDockViability, dockGuardTargets } from "../workspace/dockGuard.ts";
import { dockAdmissionWidth, layerCorrectedWidth, learnLayerInset, shellBoxKey, type DockedWidthMemory } from "../workspace/dockGeometry.ts";
import { PaneVisibilityContext } from "../workspace/paneVisibility.ts";
import "./railSurfaces.tsx";
import { useCapabilityPlacements, useRailOrders } from "../capabilityLayout.ts";
import {
  RIGHT_RAIL_SLOT,
  capabilityWidgetHomes,
  commitRailZoneOrder,
  instanceOfRailItem,
  orderRailItems,
  railDestinationIds,
  railItemRemovable,
  railWidgetFits,
  removeRailItem,
  rightRailCapabilities,
  topRailCapabilities,
} from "../railPlacement.ts";
import { pagesVersion, subscribePages } from "../pages.ts";
import { useWidgetLayout } from "../widgets/widgetLayout.ts";
import { tr } from "../i18n/index.ts";
import { MOD } from "../format.ts";
import { useKeymap } from "../../../../packages/hotkeys/widgets/hotkeys.ts";
import { railIconFor } from "../railIcons.ts";
import { useRailDragZone } from "../railDrag.ts";
import { CAPABILITY_MIME } from "../dnd.ts";
import { railClusterBlockSize } from "../railClusterSize.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { ShellColumnAccount, ShellDock, useShellColumnHosts } from "./ShellDock.tsx";
import { RailWidgetItemView, useRailWidgetItems } from "./RailZoneWidgets.tsx";
import { PackageWindowContext, pathBelongsToPackageWindow } from "./ui/PackageWindowContext.ts";
import ViewErrorBoundary from "./ViewErrorBoundary.ts";
import { useActiveWorkbenchHomeSurface } from "../workbench/profileNavigation.ts";
import { forgetMobileWorkspacePackage } from "../mobileWorkspaceNavigation.ts";

const NO_EVENTS: never[] = [];
/** Fallback separator chrome before the real element is measured. */
const SEPARATOR_FALLBACK = 6;
/** Safety net for a cancelled/throttled exit animation. Longer than every
 *  window departure — the desktop --motion-window-exit and the full-screen
 *  phone travel (--motion-stack) — plus its composited tail. */
const PANE_EXIT_FALLBACK_MS = 420;
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;
/** Bottom-dock (presentation.dock === "bottom") height bounds. The floor keeps
 *  the strip useful; the ceiling always leaves Chat + its composer this many
 *  vertical pixels (matches the row-1 `minmax(240px, 1fr)` in styles.css). */
const BOTTOM_DOCK_MIN = 160;
const BOTTOM_DOCK_CHAT_FLOOR = 240;
type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
const RESIZE_EDGES: ResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

// Small count badge on strip buttons.
function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="strip-badge">{n > 9 ? "9+" : n}</span>;
}

/** Measured workspace widths within this distance are the SAME geometry: the
 *  full-screen layer takes the pane out of flow and Chat absorbs its width, so
 *  the Chat+pane sum re-measures within a border/rounding pixel or two of the
 *  docked sum. A promotion must not release on its own mode flip
 *  alone; a real window/sidebar resize moves well past this. */
const GUARD_WIDTH_TOLERANCE = 4;

/** A guard promotion and the geometry it was judged against. `widths` keeps
 *  every workspace width this latch failed at, so re-measurement on either
 *  side of the dock/layer flip cannot release-and-refail in a loop. */
interface GuardLatch {
  inputs: string;
  widths: number[];
  promoted: boolean;
}

interface RailSurfaceModel {
  rail: string | null;
  surfaces: RailSurface[];
  open: RailSurface | null;
  ctx: RailSurfaceContext;
}

/** Presentation-only snapshot used while the canonical store has already
 * closed a surface. It never owns open state or geometry; it only keeps the
 * last painted frame mounted until the CSS exit finishes. */
interface PaneMotionSnapshot {
  surface: RailSurface;
  projectId: string | null;
  sessionId: string | null;
  compact: boolean;
  compactContext: boolean;
  isWorkspacePane: boolean;
  effectiveMode: WorkspacePaneMode;
  dynamic: boolean;
  pinned: boolean;
  layered: boolean;
  bottomDock: boolean;
  pinnedNarrow: boolean;
  geometryPending: boolean;
  paneStyle: CSSProperties;
  dockActions: readonly ModuleDockAction[] | undefined;
}

/** A strip item is either a registered interactive panel surface or the
 * built-in workspace editor launcher. Settings-only and agent-only
 * capabilities remain searchable/configurable, but are not rail destinations. */
interface RailButton {
  id: string;
  ownerPackageId?: string;
  kind?: "destination" | "command";
  capabilityId: string;
  title: string;
  icon: NonNullable<RailSurface["icon"]>;
  badge: number;
  presentation?: RailSurface["presentation"];
  active: boolean;
  activate: () => void;
}

/** Shared surface model: the header trigger and the rail/sheet host derive
 *  from the same registry + visibility result, so they can never disagree.
 *  Reads only shared stores (git status is deduplicated) — no new poller. */
export function useRailSurfaceModel(): RailSurfaceModel {
  const rail = useStore((s) => s.railPlugin);
  const projectId = useStore(workspaceProjectId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const resolved = useResolvedCapabilities();

  // Sessions without a worktree resolve to the project's primary checkout, so
  // they share the project-scoped status entry (already fetched by the hero)
  // instead of fetching a fresh per-session copy on every spawn/switch.
  const gitStatus = useGitStatus(
    projectId,
    model.turn?.status === "working",
    session?.worktreePath ? session.id : null,
  );
  const ctx: RailSurfaceContext = {
    changeCount: gitStatus ? gitChangedFiles(gitStatus).length : 0,
    eventCount: events.length,
    totalTokens: model.totals.input + model.totals.output,
    hasSession: session !== null,
  };

  useSurfaceVersion(); // re-render when surfaces register/unregister
  useSlotVersion(); // …and when workspace.right.tabs slot items arrive/leave
  // Project placement ordering: panels whose capability resolves primary come
  // first, then the resolved rank; nothing is removed.
  const positionOf = new Map(resolved.map((c, i) => [c.descriptor.id, i]));
  const surfaces = visibleSurfaces([...listSurfaces(), ...slotSurfaces(ctx)], ctx)
    .slice()
    .sort((a, b) =>
      (positionOf.get(a.capabilityId ?? a.id) ?? 999) - (positionOf.get(b.capabilityId ?? b.id) ?? 999)
      || a.order - b.order);
  const open = surfaces.find((s) => s.id === rail) ?? null;
  return { rail, surfaces, open, ctx };
}

const PANEL_ICON = (
  <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
    <path d="M9.8 2.8v10.4" />
  </svg>
);

/** Header control: the only compact entry point to registered panels.
 *  Selecting opens the first visible surface in registry order; when a panel
 *  is open the same button truthfully names and closes it. Hidden in wide
 *  mode (the inline strip exists there instead). */
export function NarrowPanelTrigger() {
  const { surfaces, open } = useRailSurfaceModel();
  const label = open ? tr("contextrail.closeValuePanel", { title: open.title }) : tr("contextrail.openWorkspacePanels");
  return (
    <button
      className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--md narrow-panel-trigger"
      title={label}
      aria-label={label}
      aria-expanded={open !== null}
      aria-controls="polyth-panel-sheet"
      disabled={surfaces.length === 0}
      onClick={() => {
        if (open) {
          setRailPlugin(null);
          return;
        }
        // At most one shell-modal surface: opening a panel closes the drawer.
        if (getState().sidebarOpen) setSidebarOpen(false);
        const first = surfaces[0];
        if (first) setRailPlugin(first.id);
      }}
    >
      {PANEL_ICON}
    </button>
  );
}

export default function ContextRail() {
  const shellMode = useShellMode();
  const compact = shellMode !== "wide";
  const { rail, surfaces, open, ctx } = useRailSurfaceModel();
  // Launchers of package pages (Agents) appear with their page and light up
  // while it is open.
  useSyncExternalStore(subscribePages, pagesVersion);
  useStore((s) => s.activePage);
  const projectId = useStore(workspaceProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const paneMode = useStore((s) => s.paneMode);
  const panePreviousMode = useStore((s) => s.panePreviousMode);
  const resolved = useResolvedCapabilities();
  const placements = useCapabilityPlacements();
  const widgetLayout = useWidgetLayout();
  const workspaceEditing = useWorkspaceMode() === "edit";
  const keymap = useKeymap();
  const terminalShortcut = formatCombo(keymap.viewTerminal, MOD === "⌘");
  const presentation = open?.presentation;
  const badgeOf = (surface: RailSurface): number => surface.badge?.(ctx) ?? 0;
  const surfaceByCapability = new Map(surfaces.map((surface) => [surface.capabilityId ?? surface.id, surface]));
  const destinations = railDestinationIds();
  const hasRailDestination = (capability: ResolvedCapability): boolean =>
    surfaceByCapability.has(capability.descriptor.id) || destinations.has(capability.descriptor.id);
  const isActive = (id: string): boolean => id === "workspace-edit"
    ? workspaceEditing
    : isCapabilityActive(id);
  const activeCapability = (capability: ResolvedCapability): boolean => isActive(capability.descriptor.id);
  const buttonForSurface = (surface: RailSurface): RailButton => ({
    id: surface.capabilityId ?? surface.id,
    ownerPackageId: surface.ownerPackageId,
    capabilityId: surface.capabilityId ?? surface.id,
    title: surface.id === "terminal"
      ? tr("terminalview.openTerminalShortcut", { shortcut: terminalShortcut })
      : surface.title,
    icon: surface.icon ?? railIconFor(surface.capabilityId ?? surface.id),
    badge: badgeOf(surface),
    presentation: surface.presentation,
    active: isActive(surface.capabilityId ?? surface.id),
    activate: () => toggleRailPlugin(surface.id),
  });
  // One home per capability (railPlacement.ts): the right rail holds the
  // "more" tier, plus Terminal whenever it has no other rail — never an icon
  // the top rail or a placed launcher widget already shows.
  const widgetHomes = capabilityWidgetHomes(widgetLayout);
  const topRailIds = new Set(topRailCapabilities(resolved, placements, widgetHomes)
    .map((capability) => capability.descriptor.id));
  const configuredRailButtons: RailButton[] = rightRailCapabilities(resolved, topRailIds, hasRailDestination, widgetHomes)
    .map((capability) => {
      const surface = surfaceByCapability.get(capability.descriptor.id);
      if (surface) return {
        ...buttonForSurface(surface),
        activate: () => toggleCapability(capability.descriptor.id, capability.descriptor.open),
      };
      return {
        id: capability.descriptor.id,
        ownerPackageId: capability.descriptor.ownerPackageId,
        ...(capability.descriptor.kind ? { kind: capability.descriptor.kind } : {}),
        capabilityId: capability.descriptor.id,
        title: capability.descriptor.label,
        icon: railIconFor(capability.descriptor.id),
        badge: capability.descriptor.id === "git" ? ctx.changeCount : 0,
        active: activeCapability(capability),
        activate: () => toggleCapability(capability.descriptor.id, capability.descriptor.open),
      };
    });
  // Slot-contributed panels are not necessarily capabilities, but still
  // belong in the rail: reorderable through their surface id, and hidden like
  // any launcher (a Technical placement, set by the rail editor's minus).
  for (const surface of surfaces) {
    const capabilityId = surface.capabilityId ?? surface.id;
    if (resolved.some((capability) => capability.descriptor.id === capabilityId)
      || configuredRailButtons.some((button) => button.id === capabilityId)) continue;
    const button = buttonForSurface(surface);
    if (placements[button.id]?.tier === "technical") continue;
    configuredRailButtons.push(button);
  }
  const railButtons = uniquePackageLaunchers(configuredRailButtons, (button) => button);
  // An icon rail with nothing in it is not rendered at all — no strip, no
  // reserved lane. Edit mode keeps it so its customize trigger can add items.
  const railWidgets = useSlotHasContent("workspace.rail");
  // Widgets placed in the "Right rail" area are items of the same rail, in
  // ONE order the person controls with the launchers and panels.
  const widgetItems = useRailWidgetItems([RIGHT_RAIL_SLOT], { editing: false });
  const widgetById = new Map(widgetItems.map((item) => [item.id, item]));
  const railIds = orderRailItems(
    [...railButtons.map((button) => button.id), ...widgetItems.map((item) => item.id)],
    useRailOrders().right,
  );

  // Shift-key customization mode: holding Shift over the rail reveals one
  // customize trigger as the strip's LAST item. It opens the shared rail
  // editor, which reads the same membership rules as this strip.
  const capabilityIds = new Set(resolved.map((capability) => capability.descriptor.id));
  const railButtonById = new Map(railButtons.map((button) => [button.id, button]));
  // Drag to reorder (a drop lands exactly where dropped), or carry an icon
  // to / from the top and header rails. Panel buttons that are not
  // capabilities reorder here but cannot leave the right rail.
  const drag = useRailDragZone({
    id: "right",
    axis: "y",
    ids: railIds,
    isDraggable: (id) => railButtonById.has(id) || widgetById.get(id)?.draggable === true,
    canLeave: (id) => capabilityIds.has(id) || instanceOfRailItem(id) !== null,
    externalMime: CAPABILITY_MIME,
    accepts: (id) => railWidgetFits("right", id) || resolved.some((capability) => capability.descriptor.id === id
      && capability.descriptor.rail !== false && capability.descriptor.available() && hasRailDestination(capability)),
    commit: (order) => commitRailZoneOrder("right", order.filter((id) =>
      capabilityIds.has(id) || railButtonById.has(id)
      || (instanceOfRailItem(id) !== null && widgetById.get(id)?.draggable !== false))),
    // Panel buttons that cannot move to another rail can still be hidden.
    remove: (id) => removeRailItem("right", id),
    canRemove: railItemRemovable,
  });
  // A drag from the top rail mounts an empty strip as its landing place. The
  // bare window layout may dock the top bar's groups here (ShellDock.tsx).
  const dockHosts = useShellColumnHosts("end");
  // The tablet and phone shells reach these tools from the header, so they
  // drop the strip, unless a wide side safe area (iPhone Duo's status column)
  // would otherwise sit empty: the strip moves in there, without the docked
  // bar groups, which those shells already show (sideSafeStrip.ts).
  const sideStrip = useSideSafeStrip();
  const safeAreaStrip = compact ? sideStrip : null;
  const showStrip = safeAreaStrip !== null
    ? railButtons.length > 0 || railWidgets || workspaceEditing || drag.receiving
    : !compact && (railButtons.length > 0 || railWidgets || workspaceEditing || drag.receiving || dockHosts.any);
  // Keep-alive: panels stay mounted once visited so their state survives
  // switching surfaces; surfaces that lose content-driven visibility unmount.
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (rail !== null && !visited.includes(rail)) setVisited((v) => [...v, rail]);
  }, [rail, visited]);
  // A registered surface that became invisible (content gone) closes the
  // panel; an id that is merely not registered *yet* (a plugin still loading)
  // is left alone so it opens once the surface arrives.
  const known = rail !== null && [...listSurfaces(), ...slotSurfaces(ctx)].some((s) => s.id === rail);
  useEffect(() => {
    if (rail !== null && known && open === null) setRailPlugin(null);
  }, [rail, known, open]);
  const kept = keptSurfaces(surfaces, rail, visited);

  const dockSelectionKey = `${projectId ?? ""}:${open?.id ?? ""}`;
  const [localDockSelection, setLocalDockSelection] = useState<{ key: string; edge: WorkspacePaneDock } | null>(null);
  useEffect(() => setLocalDockSelection(null), [dockSelectionKey]);

  // ---- geometry: measured post-sidebar workspace (Chat + pane + chrome) --------
  const railbarRef = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const shellDirection = useShellDirection();
  const separatorRef = useRef<HTMLDivElement>(null);
  const bottomSeparatorRef = useRef<HTMLDivElement>(null);
  const geometryKey = `${projectId ?? ""}:${open?.id ?? ""}:${presentation ? "workspace" : "context"}:${compact ? "compact" : "wide"}:${paneMode}`;
  const [geometry, setGeometry] = useState<{ key: string; width: number; height: number; railHeight: number; windowWidth: number }>({ key: "", width: 0, height: 0, railHeight: 0, windowWidth: 0 });
  // Docked-in-flow width remembered per shell box, so the layer's wider Chat box
  // cannot re-admit a dock that the docked box rejects (dockGeometry.ts).
  const dockedWidthRef = useRef<DockedWidthMemory | null>(null);
  // How much a fresh layer reading overstates the docked width (learned at the
  // first dock → layer flip; dockGeometry.ts), so a window drag cannot flip.
  const layerInsetRef = useRef<number | null>(null);
  const workspaceWidth = geometry.key === geometryKey ? geometry.width : 0;
  const workspaceHeight = geometry.key === geometryKey ? geometry.height : 0;
  // The launcher column a floating window extends: in the full-height window
  // layouts it is taller than the workspace, which steps down for the bar.
  const railHeight = geometry.key === geometryKey ? geometry.railHeight : 0;
  const windowWidth = geometry.key === geometryKey ? geometry.windowWidth : 0;
  const chatElOf = () =>
    railbarRef.current?.closest(".app")?.querySelector(":scope > .app-shell > .workspace") ?? null;
  const seamPaddingOf = (element: HTMLElement | null): number => {
    if (element === null) return 0;
    const value = Number.parseFloat(getComputedStyle(element).getPropertyValue("--package-window-seam-padding"));
    return Number.isFinite(value) ? value : 0;
  };

  useLayoutEffect(() => {
    const measure = () => {
      const chat = chatElOf();
      const paneEl = paneRef.current;
      const dockedInFlow = Boolean(presentation && paneEl
        && paneEl.classList.contains("rail-pinned")
        && !paneEl.classList.contains("rail-pinned-narrow")
        && !paneEl.classList.contains("rail-fullscreen"));
      const paneW = dockedInFlow && paneEl
        ? Math.max(0, paneEl.getBoundingClientRect().width - seamPaddingOf(paneEl))
        : 0;
      // A bottom-docked pane grows DOWN from Chat: sum its height so the
      // vertical geometry reflects the whole Chat + strip column.
      const paneH = paneEl && paneEl.classList.contains("rail-dock-bottom")
        ? paneEl.getBoundingClientRect().height
        : 0;
      const chatRect = chat?.getBoundingClientRect();
      // The shell hands Chat its margin box: a look that insets the sheet
      // (Monolith leaves the idle strip its lane) must not push a pin onto
      // the full-screen layer that every other look docks.
      const chatStyle = chat ? getComputedStyle(chat) : null;
      const chatInset = chatStyle
        ? (Number.parseFloat(chatStyle.marginLeft) || 0) + (Number.parseFloat(chatStyle.marginRight) || 0)
        : 0;
      const chatW = chatRect ? chatRect.width + chatInset : 0;
      const shellEl = railbarRef.current?.closest<HTMLElement>(".app-shell");
      const shellKey = shellBoxKey(
        shellEl?.getBoundingClientRect().width ?? 0,
        shellEl?.querySelector(":scope > .sidebar")?.getBoundingClientRect().width ?? 0,
      );
      const layeredPane = Boolean(presentation && paneEl?.classList.contains("rail-fullscreen"));
      layerInsetRef.current = learnLayerInset({
        measuredWidth: chatW + paneW, layered: layeredPane, shellKey, docked: dockedWidthRef.current, inset: layerInsetRef.current,
      });
      const admission = dockAdmissionWidth({
        measuredWidth: layerCorrectedWidth(chatW + paneW, layeredPane, layerInsetRef.current),
        dockedInFlow, shellKey, memory: dockedWidthRef.current,
      });
      dockedWidthRef.current = admission.memory;
      const width = admission.width;
      const height = Math.round((chatRect?.height ?? 0) + paneH);
      const railHeight = Math.round(railbarRef.current?.getBoundingClientRect().height ?? 0);
      const viewport = Math.round(window.innerWidth);
      setGeometry((current) =>
        current.key === geometryKey && current.width === width && current.height === height
          && current.railHeight === railHeight && current.windowWidth === viewport
          ? current : { key: geometryKey, width, height, railHeight, windowWidth: viewport });
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    // Observer callbacks run after layout and before paint: render the new
    // geometry in that same frame, so a shell change (window resize, the
    // automatic project rail) never paints one frame of stale split widths.
    const ro = new ResizeObserver(() => flushSync(measure));
    const chat = chatElOf();
    if (chat) ro.observe(chat);
    if (paneRef.current) ro.observe(paneRef.current);
    // A short launcher cluster grows into the full column as a window opens.
    if (railbarRef.current) ro.observe(railbarRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey, presentation]);

  // The fullscreen layer is a sibling of the persistent navigator. Publish
  // the measured workspace edge so it starts at that seam instead of covering
  // the navigator.
  useLayoutEffect(() => {
    const railbar = railbarRef.current;
    const shell = railbar?.closest<HTMLElement>(".app-shell");
    const workspace = chatElOf();
    if (!railbar || !shell || !workspace) return;
    const publish = () => {
      const shellRect = shell.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const rtl = getComputedStyle(shell).direction === "rtl";
      const offset = rtl ? shellRect.right - workspaceRect.right : workspaceRect.left - shellRect.left;
      railbar.style.setProperty("--package-window-inline-start", `${Math.max(0, Math.ceil(offset))}px`);
    };
    publish();
    if (typeof ResizeObserver !== "function") {
      return () => railbar.style.removeProperty("--package-window-inline-start");
    }
    const ro = new ResizeObserver(publish);
    ro.observe(shell);
    ro.observe(workspace);
    const directionObserver = typeof MutationObserver === "function"
      ? new MutationObserver(publish)
      : null;
    directionObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
    // A mirrored profile flips the shell's own `dir` (shellDirection.ts).
    directionObserver?.observe(shell, { attributes: true, attributeFilter: ["dir"] });
    return () => {
      ro.disconnect();
      directionObserver?.disconnect();
      railbar.style.removeProperty("--package-window-inline-start");
    };
  }, [geometryKey]);

  useLayoutEffect(() => {
    const header = railbarRef.current?.closest(".app")?.querySelector<HTMLElement>(":scope > .header");
    if (!header) return;
    const publish = () => {
      const width = paneRef.current?.classList.contains("rail-pinned")
        && !paneRef.current.classList.contains("rail-pinned-narrow")
        && !paneRef.current.classList.contains("rail-fullscreen")
        ? Math.max(0, paneRef.current.getBoundingClientRect().width - seamPaddingOf(paneRef.current)) : 0;
      header.style.setProperty("--workspace-pane-inline-size", `${Math.round(width)}px`);
    };
    publish();
    if (typeof ResizeObserver !== "function") return () => header.style.removeProperty("--workspace-pane-inline-size");
    const ro = new ResizeObserver(publish);
    if (paneRef.current) ro.observe(paneRef.current);
    return () => {
      ro.disconnect();
      header.style.removeProperty("--workspace-pane-inline-size");
    };
  }, [geometryKey]);

  const chrome = (separatorRef.current?.getBoundingClientRect().width ?? SEPARATOR_FALLBACK) || SEPARATOR_FALLBACK;
  const geo: DockGeometry = { workspaceWidth, chrome };

  // ---- dock decision + presentation mode ----------------------------------------
  const panePrefs = projectId !== null ? getWorkspacePanePrefs(projectId) : null;
  const paneWidths = panePrefs?.widths ?? {};
  // "Same pinned window": while pinned (or fullscreen over a pinned window),
  // every package window reads and writes one shared width, edge and strip
  // height, so switching windows only swaps content. Missing or unsupported
  // shared entries fall back to the window's own memory.
  const sharePinnedSetting = useUiSettings().sharedPinnedWindow;
  const sharedPinned = sharePinnedSetting
    && presentation !== undefined
    && (paneMode === "pinned" || (paneMode === "fullscreen" && panePreviousMode === "pinned"));
  const layoutKey = open !== null ? paneLayoutKey(open.id, sharedPinned) : null;
  // The edge follows the shared frame even while unpinned, so the header
  // offers the edge the pin will actually use.
  const sharedDockEdge = sharePinnedSetting && presentation !== undefined
    ? panePrefs?.dockEdges?.[SHARED_PINNED_PANE_KEY]
    : undefined;
  const persistedDockEdge = open === null
    ? undefined
    : sharedDockEdge !== undefined && paneDockOptions(presentation).includes(sharedDockEdge)
      ? sharedDockEdge
      : panePrefs?.dockEdges?.[open.id];
  const selectedDockEdge = localDockSelection?.key === dockSelectionKey
    ? localDockSelection.edge
    : persistedDockEdge;
  const dockEdge = paneDockEdge(presentation, selectedDockEdge);

  // Focused split (e.g. IDE): a profile with `companionWidth` makes its
  // work surface the flexible column and Chat a fixed-width companion
  // (`decideFocusedSplit`). Chat's width persists per profile per project;
  // the pane width is always derived. Admission adds DOCK_HYSTERESIS on top
  // of the docked-width memory, so a window at the threshold cannot flip.
  const shellPresentation = useWorkbenchShellPresentation();
  const { activeProfileId } = useWorkbenchNavigation();
  const companion = shellPresentation.companionWidth;
  const focusedCompanion = companion !== null
    && presentation !== undefined
    && open !== null
    && !compact
    && paneMode === "pinned"
    && dockEdge === "side"
    && shellPresentation.splitSurfaces?.[1] === open.id;
  const savedChatWidth = focusedCompanion ? panePrefs?.splitChatWidths?.[activeProfileId] ?? null : null;
  const hysteresisKey = `${projectId ?? ""}:${open?.id ?? ""}:${activeProfileId}`;
  const focusedDockedRef = useRef<{ key: string; docked: boolean } | null>(null);
  const focusedDecision: FocusedSplitDecision | null = focusedCompanion && companion !== null && presentation && workspaceWidth > 0
    ? decideFocusedSplit({
        windowWidth,
        workspaceWidth,
        companion,
        workMin: Math.max(FOCUSED_WORK_MIN, presentation.minWidth),
        workMax: Math.max(FOCUSED_WORK_MAX, presentation.preferredMaxWidth),
        savedChatWidth,
        wasDocked: focusedDockedRef.current?.key === hysteresisKey ? focusedDockedRef.current.docked : null,
      })
    : null;
  useLayoutEffect(() => {
    if (focusedDecision !== null) focusedDockedRef.current = { key: hysteresisKey, docked: focusedDecision.dock };
  });
  // The frame's last settled width in this project. Until someone resizes the
  // shared frame it has no stored width, so the next window takes this one:
  // the size the person actually saw, not a reading taken mid-transition.
  const sharedFrameRef = useRef<{ projectId: string; surfaceId: string; width: number } | null>(null);
  const carriedWidth = sharedPinned && open !== null && sharedFrameRef.current !== null
    && sharedFrameRef.current.projectId === projectId && sharedFrameRef.current.surfaceId !== open.id
    ? sharedFrameRef.current.width
    : undefined;
  const sharedWidth = sharedPinned ? paneWidths[SHARED_PINNED_PANE_KEY] ?? carriedWidth : undefined;
  const remembered = open !== null && presentation
    ? focusedCompanion ? savedChatWidth : sharedWidth ?? paneWidths[open.id] ?? null
    : null;
  // The shared pinned frame is one panel whose content changes: its width is
  // not capped by each package's comfortable maximum, only by Chat's floor
  // (and raised to a package's content minimum, the one size it can't give).
  // Until the frame has a width, the first window's own default sizes it.
  const dockPresentation = presentation && sharedWidth !== undefined
    ? { ...presentation, preferredMaxWidth: Number.POSITIVE_INFINITY }
    : presentation;
  const decision: DockDecision | null = focusedDecision !== null
    ? { dock: focusedDecision.dock, width: focusedDecision.workWidth, maxPane: workspaceWidth - focusedDecision.chatMin }
    : dockPresentation ? decideDock(focusedCompanion ? null : remembered, dockPresentation, geo) : null;
  // Live resize range of the pane: in a focused split the work floor and the
  // Chat companion floor bound it; otherwise the generic dock clamp.
  const clampPaneWidth = (width: number): number => focusedDecision !== null
    ? Math.min(workspaceWidth - focusedDecision.chatMin, Math.max(workspaceWidth - focusedDecision.chatMax, Math.round(width)))
    : presentation ? clampDockWidth(width, presentation, geo) : clampRailWidth(width);
  const paneMinWidth = focusedDecision !== null ? workspaceWidth - focusedDecision.chatMax : presentation?.minWidth ?? 240;
  // The bottom-dock strip persists under its own key so its height never
  // bleeds into (or from) the same surface's floating dynamic-window height.
  const rememberedDockHeight = open !== null
    ? panePrefs?.heights[`${layoutKey}::dock`] ?? panePrefs?.heights[`${open.id}::dock`]
    : undefined;

  // Pane prefs are read during render; a focused-split commit bumps this so
  // the new Chat width renders even when the live width was already null.
  const [, setSplitPrefsRevision] = useState(0);
  // Live (uncommitted) drag width; preferred width persists on commit only.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  // Live bottom-dock strip height (kept apart from the dynamic-window height
  // so a drag in one mode never leaks a stale value into the other).
  const [liveDockHeight, setLiveDockHeight] = useState<number | null>(null);
  const [livePosition, setLivePosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setLiveWidth(null);
    setLiveHeight(null);
    setLiveDockHeight(null);
    setLivePosition({ x: 0, y: 0 });
  }, [open?.id, projectId]);
  useEffect(() => { setLivePosition({ x: 0, y: 0 }); }, [workspaceWidth, workspaceHeight]);

  // Layout guard result: docked geometry that clips or covers Chat promotes.
  // The promotion LATCHES: it releases only when a real
  // geometry input changes — surface, project, preferred width, or the
  // measured workspace width — never because the promotion itself flipped
  // the mode to the full-screen layer.
  const [guardPromoted, setGuardPromoted] = useState(false);
  const guardLatchRef = useRef<GuardLatch | null>(null);

  const isWorkspacePane = open !== null && presentation !== undefined;
  // The open window is the active workbench profile's home surface (the
  // Tasks tab): it stays the whole view, so it offers no pin/fullscreen.
  const homeSurface = useActiveWorkbenchHomeSurface();
  const homePane = isWorkspacePane && open?.id === homeSurface;
  const measured = workspaceWidth > 0;
  const admits = decision !== null && decision.dock;
  const guardInputs = `${open?.id ?? ""}:${projectId ?? ""}:${remembered ?? "auto"}${focusedCompanion ? ":focused" : ""}`;
  // Compact shells have room for one package at a time. Preserve the user's
  // desktop preference, but present every package as fullscreen on mobile.
  // A side dock with insufficient room promotes to the full-screen layer; the
  // bottom strip is reserved for the deliberate `bottom` edge (paneWindowLayout).
  const { effectiveMode: effectivePaneMode, dynamic, pinned, layered, bottomDock, pinnedNarrow } =
    paneWindowLayout({ isWorkspacePane, compact, paneMode, dockEdge, measured, admits, guardPromoted });
  const dockPinned = pinned || (layered && panePreviousMode === "pinned");
  // A dock ⇄ layer change the window/geometry caused (same surface, same
  // user-chosen mode) re-mounts nothing and must not replay an entry
  // animation; the flag holds until the person next opens/changes the pane.
  const motionKey = `${projectId ?? ""}:${open?.id ?? ""}:${paneMode}`;
  // The first measured decision (geometry pending → docked/layer) is the
  // entry itself, not a flip.
  const geometryMotionRef = useRef<{ key: string; measured: boolean; layered: boolean; flipped: boolean }>({ key: "", measured: false, layered: false, flipped: false });
  const geometryFlipped = geometryMotionRef.current.key === motionKey
    && (geometryMotionRef.current.flipped
      || (geometryMotionRef.current.measured && geometryMotionRef.current.layered !== layered));
  useLayoutEffect(() => {
    geometryMotionRef.current = { key: motionKey, measured, layered, flipped: geometryFlipped };
  });
  const supportedDockOptions = isWorkspacePane && !compact && presentation?.dockOptions?.length
    ? paneDockOptions(presentation)
    : [];
  const chooseDock = (edge: WorkspacePaneDock) => {
    if (open === null) return;
    if (dockPinned && dockEdge === edge) {
      togglePanePin();
      return;
    }
    setLocalDockSelection({ key: dockSelectionKey, edge });
    if (projectId !== null) {
      setPaneDockEdge(projectId, open.id, edge);
      // Choosing an edge pins, so the shared pinned edge follows it too.
      if (sharePinnedSetting) setPaneDockEdge(projectId, SHARED_PINNED_PANE_KEY, edge);
    }
    // Choosing an edge means "use this edge when pinned". Preserve an
    // already pinned/fullscreen-pinned mode, otherwise enter pinned mode.
    if (!pinned && !(layered && panePreviousMode === "pinned")) togglePanePin();
  };
  // Every window shows the same pin; a package offering more than one edge
  // adds one action that moves (and pins) the window to the other edge.
  const otherDockEdges = supportedDockOptions.filter((edge) => edge !== dockEdge);
  const dockActions = supportedDockOptions.length > 1 && otherDockEdges.length > 0
    ? otherDockEdges.map((edge) => ({
      edge,
      label: edge === "bottom" ? tr("contextrail.dockBelowChat") : tr("contextrail.dockBesideChat"),
      selected: false,
      onClick: () => chooseDock(edge),
    }))
    : undefined;
  const dockWidth = decision !== null && presentation
    ? clampPaneWidth(liveWidth ?? decision.width)
    : railWidthOf(rail);
  useLayoutEffect(() => {
    if (!sharedPinned || projectId === null || open === null) {
      sharedFrameRef.current = null;
    } else if (pinned && !pinnedNarrow && !layered && !focusedCompanion && measured && liveWidth === null) {
      sharedFrameRef.current = { projectId, surfaceId: open.id, width: dockWidth };
    }
  });
  // The first window pinned while the windows share one layout is the
  // template: seed the missing shared entries from it, so the next window
  // opens at this size even when nobody resized this one. The width is
  // stored once it has been carried to a second window (see sharedFrameRef):
  // at pin time the geometry is still settling.
  useEffect(() => {
    if (!sharedPinned || projectId === null || open === null || panePrefs === null) return;
    if (panePrefs.dockEdges?.[SHARED_PINNED_PANE_KEY] === undefined) {
      setPaneDockEdge(projectId, SHARED_PINNED_PANE_KEY, dockEdge);
    }
    if (paneWidths[SHARED_PINNED_PANE_KEY] === undefined && carriedWidth !== undefined) {
      setPanePreferredWidth(projectId, SHARED_PINNED_PANE_KEY, carriedWidth);
    }
    const ownDockHeight = panePrefs.heights[`${open.id}::dock`];
    if (panePrefs.heights[`${SHARED_PINNED_PANE_KEY}::dock`] === undefined && ownDockHeight !== undefined) {
      setPaneDynamicHeight(projectId, `${SHARED_PINNED_PANE_KEY}::dock`, ownDockHeight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedPinned, projectId, open?.id, pinned, pinnedNarrow, dockEdge]);

  // ---- layout guard engine --------------------------------------------------
  // Judges the ACTUAL post-dock Chat layout after the pane width is committed
  // (layout effect: before paint, so before pointer input), and keeps judging
  // it from the composer's OWN geometry: every visible action is observed and
  // subtree changes (a Model picker mounting once models arrive) re-run the
  // check — the Chat+pane sum alone stays constant while a dock consumes
  // Chat's width and must never be the only trigger.
  useLayoutEffect(() => {
    const latch = guardLatchRef.current;
    if (latch !== null && latch.promoted) {
      if (latch.inputs !== guardInputs) {
        // Different surface/project/preferred width: judge it fresh.
        guardLatchRef.current = null;
        setGuardPromoted(false);
        return;
      }
      if (
        !isWorkspacePane || !measured
        || !latch.widths.some((w) => Math.abs(w - workspaceWidth) <= GUARD_WIDTH_TOLERANCE)
      ) {
        // A real geometry change: release, and retry the dock next commit.
        latch.promoted = false;
        setGuardPromoted(false);
        return;
      }
      return; // hold the latch — the layer mode it selected is not a release
    }
    if (!pinned || pinnedNarrow || !measured) return;

    const promote = () => {
      const cur = guardLatchRef.current;
      if (cur !== null && cur.promoted) return;
      if (cur !== null && cur.inputs === guardInputs) {
        // Re-failing after a release: remember this width too, so measuring
        // either side of the dock/layer flip can never oscillate.
        if (!cur.widths.some((w) => Math.abs(w - workspaceWidth) <= GUARD_WIDTH_TOLERANCE)) {
          cur.widths = [...cur.widths.slice(-7), workspaceWidth];
        }
        cur.promoted = true;
      } else {
        guardLatchRef.current = { inputs: guardInputs, widths: [workspaceWidth], promoted: true };
      }
      setGuardPromoted(true);
    };
    const check = () => {
      const cur = guardLatchRef.current;
      if (cur !== null && cur.promoted) return;
      // "pending" (Chat mid-render) is NOT a failure: promoting on a
      // transient state would latch the user into full-screen. The observers
      // below re-check once the boxes settle.
      if (chatDockViability(chatElOf(), CHAT_FLOOR) === "blocked") promote();
    };
    check();

    const chat = chatElOf();
    if (!chat) return;
    let ro: ResizeObserver | null = null;
    const observeAll = () => {
      if (ro === null) return;
      ro.disconnect();
      for (const el of dockGuardTargets(chat)) ro.observe(el);
    };
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(check);
      observeAll();
    }
    // Coalesce mutation bursts (timeline streaming) into one check per frame.
    let scheduled = 0;
    const scheduleCheck = () => {
      if (typeof requestAnimationFrame !== "function") {
        observeAll();
        check();
        return;
      }
      if (scheduled !== 0) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        observeAll();
        check();
      });
    };
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver === "function") {
      mo = new MutationObserver(scheduleCheck);
      mo.observe(chat, { childList: true, subtree: true });
    }
    // One post-paint settle pass (fonts, late async content) regardless.
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(check) : 0;
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      if (scheduled !== 0) cancelAnimationFrame(scheduled);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardInputs, workspaceWidth, dockWidth, pinned, pinnedNarrow, isWorkspacePane, measured]);

  // Publish presentation truth so App can make hidden Chat inert. On phone a
  // contextual sheet also fully covers the session, so it counts too.
  const railCoversWorkspace = layered || (compact && open !== null && !isWorkspacePane);
  useEffect(() => {
    setPaneFullscreen(railCoversWorkspace);
    return () => setPaneFullscreen(false);
  }, [railCoversWorkspace]);

  // ---- resize: pinned separator + dynamic in-frame edges ------------------------
  const commitWidth = (w: number) => {
    if (open === null) return;
    if (focusedDecision !== null) {
      // Persist Chat's width (snapped to the band default within ±12px, which
      // forgets it); drop the live width so the derived pane width follows.
      if (projectId !== null) setSplitChatWidth(projectId, activeProfileId, commitFocusedChatWidth(workspaceWidth - w, focusedDecision));
      setLiveWidth(null);
      setSplitPrefsRevision((revision) => revision + 1);
      return;
    }
    if (presentation) {
      if (projectId !== null) {
        setPanePreferredWidth(projectId, open.id, w);
        if (sharedPinned) setPanePreferredWidth(projectId, SHARED_PINNED_PANE_KEY, w);
      }
    } else {
      setRailWidth(open.id, clampRailWidth(w));
    }
  };

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const paneAtInlineStart = () => Boolean(paneRef.current?.closest(".app.workspace-focus-swap"));
  // The pane frame carries the shell's direction: RTL locale or a mirrored
  // profile (shellDirection.ts), never just the document's.
  const paneRtl = () => paneRef.current
    ? getComputedStyle(paneRef.current).direction === "rtl"
    : document.documentElement.dir === "rtl";
  const resizeDirection = () => {
    const rtl = paneRtl();
    return paneAtInlineStart() ? (rtl ? -1 : 1) : (rtl ? 1 : -1);
  };
  const onHandleDown = (e: ReactPointerEvent) => {
    if (open === null || !pinned || pinnedNarrow || layered) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: dockWidth };
    const direction = resizeDirection();
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const raw = d.startW + direction * (ev.clientX - d.startX);
      setLiveWidth(presentation ? (focusedDecision !== null ? clampPaneWidth(raw) : raw) : clampRailWidth(raw));
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!d) return;
      const raw = d.startW + direction * (ev.clientX - d.startX);
      const committed = clampPaneWidth(raw);
      setLiveWidth(committed);
      commitWidth(committed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up, { once: true });
  };

  const onHandleKey = (e: ReactKeyboardEvent) => {
    if (open === null || !pinned || pinnedNarrow || layered) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    let next: number | null = null;
    const rtl = paneRtl();
    const increaseKey = paneAtInlineStart() ? (rtl ? "ArrowLeft" : "ArrowRight") : (rtl ? "ArrowRight" : "ArrowLeft");
    if (e.key === increaseKey) next = dockWidth + step;
    else if (e.key === (increaseKey === "ArrowLeft" ? "ArrowRight" : "ArrowLeft")) next = dockWidth - step;
    else if (e.key === "Home") next = presentation ? paneMinWidth : 240;
    else if (e.key === "End") next = presentation && decision !== null ? decision.maxPane : 640;
    if (next === null) return;
    e.preventDefault();
    const committed = clampPaneWidth(next);
    setLiveWidth(committed);
    commitWidth(committed);
  };

  // Double-click resets a focused split to the band default.
  const onHandleDoubleClick = () => {
    if (focusedDecision === null || projectId === null) return;
    setSplitChatWidth(projectId, activeProfileId, null);
    setLiveWidth(null);
    setSplitPrefsRevision((revision) => revision + 1);
  };

  // ---- resize: bottom-dock strip (horizontal separator on the top edge) --------
  // Range is derived from the measured Chat + strip column (workspaceHeight);
  // the ceiling always keeps BOTTOM_DOCK_CHAT_FLOOR px for Chat + its composer.
  const bottomDockMax = Math.max(BOTTOM_DOCK_MIN, Math.round((workspaceHeight || 0) - BOTTOM_DOCK_CHAT_FLOOR));
  const bottomDockMin = Math.max(80, Math.min(presentation?.minHeight ?? BOTTOM_DOCK_MIN, bottomDockMax));
  const clampDockHeight = (h: number) => Math.min(bottomDockMax, Math.max(bottomDockMin, Math.round(h)));
  const explicitDockHeight = bottomDock ? liveDockHeight ?? rememberedDockHeight ?? null : null;
  const bottomDockNow = clampDockHeight(explicitDockHeight ?? (workspaceHeight || 0) * 0.46);

  const commitDockHeight = (h: number) => {
    if (open === null || projectId === null) return;
    setPaneDynamicHeight(projectId, `${open.id}::dock`, clampDockHeight(h));
    if (sharedPinned) setPaneDynamicHeight(projectId, `${SHARED_PINNED_PANE_KEY}::dock`, clampDockHeight(h));
  };
  const dockDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onBottomHandleDown = (e: ReactPointerEvent) => {
    if (open === null || !bottomDock) return;
    e.preventDefault();
    const startH = paneRef.current?.getBoundingClientRect().height
      ?? explicitDockHeight ?? bottomDockNow;
    dockDragRef.current = { startY: e.clientY, startH };
    document.documentElement.dataset.packageWindowResizing = "true";
    const move = (ev: PointerEvent) => {
      const d = dockDragRef.current;
      if (!d) return;
      setLiveDockHeight(clampDockHeight(d.startH + (d.startY - ev.clientY)));
    };
    const up = (ev: PointerEvent) => {
      const d = dockDragRef.current;
      dockDragRef.current = null;
      delete document.documentElement.dataset.packageWindowResizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!d) return;
      const h = clampDockHeight(d.startH + (d.startY - ev.clientY));
      setLiveDockHeight(h);
      commitDockHeight(h);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up, { once: true });
  };
  const onBottomHandleKey = (e: ReactKeyboardEvent) => {
    if (open === null || !bottomDock) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = bottomDockNow + step;
    else if (e.key === "ArrowDown") next = bottomDockNow - step;
    else if (e.key === "Home") next = bottomDockMin;
    else if (e.key === "End") next = bottomDockMax;
    if (next === null) return;
    e.preventDefault();
    const h = clampDockHeight(next);
    setLiveDockHeight(h);
    commitDockHeight(h);
  };
  // Publish the chosen strip height as a CSS custom property on .app-shell so
  // the pane's grid row can realize it. Written ONLY when the user has an
  // explicit height — otherwise the stylesheet proportion applies and no
  // measurement feedback loop can form.
  useLayoutEffect(() => {
    const shell = railbarRef.current?.closest<HTMLElement>(".app-shell");
    if (!shell) return;
    if (bottomDock && explicitDockHeight !== null) {
      shell.style.setProperty("--workspace-dock-h", `${Math.round(explicitDockHeight)}px`);
    } else {
      shell.style.removeProperty("--workspace-dock-h");
    }
    return () => { shell.style.removeProperty("--workspace-dock-h"); };
  }, [bottomDock, explicitDockHeight]);

  // Safety net: if the rail unmounts mid-drag (surface closed, project
  // switched), the global resize flag must not stick and freeze the cursor /
  // suppress transitions app-wide.
  useEffect(() => () => { delete document.documentElement.dataset.packageWindowResizing; }, []);

  const dynamicMaxWidth = Math.max(1, workspaceWidth - 32);
  const dynamicMinWidth = Math.min(presentation?.minWidth ?? 240, dynamicMaxWidth);
  const dynamicWidth = clampPaneDimension(liveWidth ?? remembered ?? Math.min(presentation?.preferredMaxWidth ?? 640, workspaceWidth * (presentation?.defaultRatio ?? 0.55)), dynamicMinWidth, workspaceWidth);
  // A floating window opens as tall as the launcher column it extends, so the
  // two read as one surface (styles.css, `.rail-dynamic`); only a resize in
  // this opening gives it a height of its own, until it closes.
  const dynamicMaxHeight = Math.max(1, railHeight || workspaceHeight);
  const dynamicMinHeight = Math.min(presentation?.minHeight ?? 240, dynamicMaxHeight);
  const dynamicHeight = clampPaneDimension(liveHeight ?? dynamicMaxHeight, dynamicMinHeight, dynamicMaxHeight);

  const onDynamicResizeDown = (edge: ResizeEdge, e: ReactPointerEvent) => {
    if (!dynamic || open === null) return;
    e.preventDefault();
    e.stopPropagation();
    const seamPadding = seamPaddingOf(paneRef.current);
    const start = {
      x: e.clientX, y: e.clientY, width: dynamicWidth, height: dynamicHeight,
      position: livePosition,
      bounds: chatElOf()?.getBoundingClientRect() ?? null,
      // The window spans the launcher column, which may start above Chat.
      column: railbarRef.current?.getBoundingClientRect() ?? null,
      box: paneRef.current?.getBoundingClientRect() ?? null,
    };
    document.documentElement.dataset.packageWindowResizing = "true";
    // Edges are logical ("e" = the frame's inline end, beside the launcher
    // strip): in an RTL locale or a mirrored shell the window is anchored on
    // its left, so pointer travel and the anchoring translation flip.
    const rtl = paneRtl();
    const move = (event: PointerEvent) => {
      const dx = (event.clientX - start.x) * (rtl ? -1 : 1);
      const dy = event.clientY - start.y;
      const width = edge.includes("e")
        ? Math.min(dynamicMaxWidth, Math.max(dynamicMinWidth, start.width + dx))
        : edge.includes("w")
          ? Math.min(dynamicMaxWidth, Math.max(dynamicMinWidth, start.width - dx))
          : start.width;
      const height = edge.includes("s")
        ? Math.min(dynamicMaxHeight, Math.max(dynamicMinHeight, start.height + dy))
        : edge.includes("n")
          ? Math.min(dynamicMaxHeight, Math.max(dynamicMinHeight, start.height - dy))
          : start.height;
      if (edge.includes("e") || edge.includes("w")) setLiveWidth(width);
      if (edge.includes("n") || edge.includes("s")) setLiveHeight(height);
      const frameWidth = width + seamPadding;
      const proposedX = start.position.x + (edge.includes("e") ? (width - start.width) * (rtl ? -1 : 1) : 0);
      const proposedY = start.position.y + (edge.includes("n") ? start.height - height : 0);
      const baseLeft = start.box
        ? (rtl ? start.box.left - start.position.x : start.box.right - start.position.x - frameWidth)
        : 0;
      const baseTop = start.box ? start.box.top - start.position.y : 0;
      const vertical = start.column ?? start.bounds;
      setLivePosition({
        x: start.bounds
          ? Math.min(start.bounds.right - baseLeft - frameWidth, Math.max(start.bounds.left - baseLeft, proposedX))
          : proposedX,
        y: vertical
          ? Math.min(vertical.bottom - baseTop - height, Math.max(vertical.top - baseTop, proposedY))
          : proposedY,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      delete document.documentElement.dataset.packageWindowResizing;
      const measuredWidth = paneRef.current?.getBoundingClientRect().width;
      const width = measuredWidth === undefined ? dynamicWidth : Math.max(0, measuredWidth - seamPadding);
      commitWidth(width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  };

  const onDynamicResizeKey = (edge: "e" | "s", e: ReactKeyboardEvent) => {
    if (!dynamic || open === null) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    if (edge === "e") {
      const grow = paneRtl() ? "ArrowLeft" : "ArrowRight";
      const next = e.key === "Home" ? dynamicMinWidth
        : e.key === "End" ? dynamicMaxWidth
          : e.key === "ArrowLeft" || e.key === "ArrowRight" ? dynamicWidth + (e.key === grow ? step : -step) : null;
      if (next === null) return;
      e.preventDefault();
      const width = Math.min(dynamicMaxWidth, Math.max(dynamicMinWidth, next));
      setLiveWidth(width);
      commitWidth(width);
      return;
    }
    const next = e.key === "Home" ? dynamicMinHeight
      : e.key === "End" ? dynamicMaxHeight
        : e.key === "ArrowUp" ? dynamicHeight - step
          : e.key === "ArrowDown" ? dynamicHeight + step : null;
    if (next === null) return;
    e.preventDefault();
    setLiveHeight(Math.min(dynamicMaxHeight, Math.max(dynamicMinHeight, next)));
  };

  // Package-owned portal surfaces carry the owner id through React context,
  // so interacting with their menu/popover/tooltip is never an outside click.
  useEffect(() => {
    if (!dynamic || open === null) return;
    const id = open.id;
    const outside = (event: PointerEvent) => {
      const modal = document.querySelector<HTMLElement>('[aria-modal="true"]');
      if (modal && modal !== paneRef.current) return;
      const owned = pathBelongsToPackageWindow(event.composedPath(), id, (launcherId) => isCapabilityActive(launcherId));
      if (!owned) closePaneFromOutside();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [dynamic, open?.id]);

  const onPaneKey = (e: ReactKeyboardEvent) => {
    if (isImeComposing(e)) return;
    if (e.key !== "Escape" || !isWorkspacePane || presentation === undefined) return;
    // A profile's home surface is the view itself, like Canvas: Escape does
    // not shrink it into a side window.
    if (homePane) return;
    if (presentation.escape !== "close") return;
    if (e.target instanceof Element) {
      const transient = e.target.closest('[role="menu"], [role="listbox"], [role="dialog"]');
      if (transient && transient !== paneRef.current) return;
    }
    e.stopPropagation();
    // On a phone Escape is the window's Close: the package is not resumed by
    // the next Tools tap either (ModuleView).
    if (shellMode === "phone") forgetMobileWorkspacePackage();
    if (compact) closeWorkspacePane();
    else handlePaneEscape();
  };

  const geometryPending = isWorkspacePane && !measured;
  const paneStyle: CSSProperties = open
    ? ({
        "--rail-w": `${dynamic ? dynamicWidth : dockWidth}px`,
        // Unset, the window spans the launcher column and squares its foot
        // where the column meets the window's edge (styles.css); a window
        // resized clear of that edge rounds it.
        ...(liveHeight !== null ? { "--package-window-h": `${dynamicHeight}px`, "--package-window-foot": "1" } : {}),
        "--package-window-x": `${livePosition.x}px`,
        "--package-window-y": `${livePosition.y}px`,
        ...(geometryPending ? { visibility: "hidden", pointerEvents: "none" } : {}),
      } as CSSProperties)
    : { display: "none" };

  // Compact contextual surfaces use the A390 modal sheet. Canonical workspace
  // surfaces retain the pane model's full-screen layer and launcher strip.
  const compactContext = compact && open !== null && !isWorkspacePane;

  // The store closes immediately; this short presentation-only presence keeps
  // the painted window mounted long enough to collapse toward the launcher.
  // A project/session/shell change or an unregistered surface skips the exit.
  const currentPaneMotion: PaneMotionSnapshot | null = open === null ? null : {
    surface: open,
    projectId,
    sessionId,
    compact,
    compactContext,
    isWorkspacePane,
    effectiveMode: effectivePaneMode,
    dynamic,
    pinned,
    layered,
    bottomDock,
    pinnedNarrow,
    geometryPending,
    paneStyle,
    dockActions,
  };
  const paneMotionRef = useRef<PaneMotionSnapshot | null>(null);
  const [, setPaneMotionRevision] = useState(0);
  const retainedPaneMotion = open === null ? paneMotionRef.current : null;
  const exitPaneMotion = retainedPaneMotion !== null
    && retainedPaneMotion.projectId === projectId
    && retainedPaneMotion.sessionId === sessionId
    && retainedPaneMotion.compact === compact
    && !retainedPaneMotion.geometryPending
    && surfaces.some((surface) => surface.id === retainedPaneMotion.surface.id)
    ? retainedPaneMotion
    : null;

  useLayoutEffect(() => {
    if (currentPaneMotion !== null) paneMotionRef.current = currentPaneMotion;
    else if (exitPaneMotion === null) paneMotionRef.current = null;
  });

  useLayoutEffect(() => {
    if (exitPaneMotion === null) return;
    const snapshot = exitPaneMotion;
    const finish = () => {
      if (paneMotionRef.current !== snapshot) return;
      paneMotionRef.current = null;
      setPaneMotionRevision((revision) => revision + 1);
    };
    const reducedMotion = document.documentElement.dataset.reduceAnimations === "true"
      || document.body?.dataset.desktopLowResource === "true"
      || window.getComputedStyle(paneRef.current ?? document.documentElement).animationName === "none";
    if (reducedMotion) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, PANE_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [exitPaneMotion, open]);

  const paneSurface = open ?? exitPaneMotion?.surface ?? null;
  const paneWorkspace = open !== null ? isWorkspacePane : exitPaneMotion?.isWorkspacePane ?? false;
  const paneCompactContext = open !== null ? compactContext : exitPaneMotion?.compactContext ?? false;
  const paneDynamic = open !== null ? dynamic : exitPaneMotion?.dynamic ?? false;
  const panePinned = open !== null ? pinned : exitPaneMotion?.pinned ?? false;
  const paneLayered = open !== null ? layered : exitPaneMotion?.layered ?? false;
  const paneBottomDock = open !== null ? bottomDock : exitPaneMotion?.bottomDock ?? false;
  const panePinnedNarrow = open !== null ? pinnedNarrow : exitPaneMotion?.pinnedNarrow ?? false;
  const renderedPaneMode = open !== null ? effectivePaneMode : exitPaneMotion?.effectiveMode ?? "context";
  const renderedPaneStyle = open !== null
    ? paneStyle
    : exitPaneMotion?.paneStyle ?? { display: "none" };
  const renderedDockActions = open !== null ? dockActions : exitPaneMotion?.dockActions;
  // The leaving surface plays its exit beside the kept-alive panes, which stay
  // mounted and hidden in their usual order. Rendering the leaving surface
  // alone unmounted every kept pane as the exit began and mounted it afresh as
  // it ended: lost state, and two main-thread spikes framing the motion.
  const renderedSurfaces = exitPaneMotion === null
    ? kept
    : surfaces.filter((surface) => surface.id === exitPaneMotion.surface.id || kept.includes(surface));
  const exiting = open === null && exitPaneMotion !== null;

  // The tablet band morphs the floating launcher cluster into the docked
  // column and back; both ends of that motion need the cluster's height,
  // which only exists while idle. Measure it at each open/close edge.
  const paneShown = open !== null;
  useLayoutEffect(() => {
    const railbar = railbarRef.current;
    const strip = railbar?.querySelector<HTMLElement>(":scope > .plugin-strip");
    if (!railbar) return;
    if (!strip) {
      railbar.style.removeProperty("--rail-cluster-block-size");
      return;
    }
    railbar.style.setProperty("--rail-cluster-block-size", `${railClusterBlockSize(strip)}px`);
  }, [paneShown, exiting, showStrip]);

  // The side safe-area strip lines up with the screen, not its host: its
  // first icon clears the status items and camera, measured from the screen
  // top, so it needs to know how far below that the host starts (the shell
  // may or may not contain fixed boxes, depending on the engine and layout).
  const sideStripShown = showStrip && safeAreaStrip !== null;
  useLayoutEffect(() => {
    const railbar = railbarRef.current;
    if (!railbar || !sideStripShown) return;
    const publish = () => railbar.style.setProperty("--side-strip-host-top", `${Math.max(0, Math.round(railbar.getBoundingClientRect().top))}px`);
    publish();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    ro?.observe(railbar);
    return () => {
      ro?.disconnect();
      railbar.style.removeProperty("--side-strip-host-top");
    };
  }, [sideStripShown, paneShown]);

  useModalSurface({
    enabled: compact && !isWorkspacePane,
    open: compactContext,
    onClose: () => setRailPlugin(null),
    containerRef: paneRef,
    resolveRestoreFocus: (opener) => opener
      ?? document.querySelector<HTMLElement>(".header-view-picker .picker-chip")
      ?? document.querySelector<HTMLElement>(".narrow-panel-trigger"),
  });

  // The railbar names a floating package window it holds, so CSS reaches its
  // children without `.railbar:has(.rail-dynamic) > *`: Chromium restyled the
  // whole document for that selector on every inline-style change (each
  // keystroke in the composer). Mirrors the pane's `rail-dynamic` class below.
  const railDynamic = !paneCompactContext && paneDynamic && (renderedSurfaces.length > 0 || exitPaneMotion !== null);

  return (
    <>
      {paneCompactContext && <div className="menu-backdrop panel-sheet-backdrop" onClick={() => setRailPlugin(null)} />}
      <aside
        className={`railbar${open ? " railbar-open" : ""}${panePinnedNarrow ? " railbar-pinned-narrow" : ""}${paneBottomDock ? " railbar-dock-bottom" : ""}${railDynamic ? " railbar-dynamic" : ""}`}
        data-rail-motion={exiting ? "exiting" : open ? "open" : "idle"}
        data-rail-strip={showStrip ? undefined : "none"}
        data-side-strip={sideStripShown ? safeAreaStrip ?? undefined : undefined}
        ref={railbarRef}
      >
        {(renderedSurfaces.length > 0 || exitPaneMotion !== null) && (
        <div
          ref={paneRef}
          id={compact ? "polyth-panel-sheet" : undefined}
          className={paneCompactContext
            ? `panel-sheet${exiting ? " rail-exiting" : ""}`
            : `rail${paneWorkspace ? " rail-workspace" : ""}${paneDynamic ? " rail-dynamic" : ""}${panePinned ? " rail-pinned" : ""}${panePinnedNarrow ? " rail-pinned-narrow" : ""}${paneBottomDock ? " rail-dock-bottom" : ""}${paneLayered ? " rail-fullscreen" : ""}${exiting ? " rail-exiting" : ""}`}
          style={paneCompactContext ? undefined : renderedPaneStyle}
          role={!exiting && (paneCompactContext || paneLayered || paneDynamic) ? "dialog" : undefined}
          aria-modal={paneCompactContext && !exiting ? true : undefined}
          aria-label={paneSurface?.title ?? tr("contextrail.panel")}
          aria-hidden={exiting || undefined}
          inert={exiting || undefined}
          data-package-window-owner={paneSurface?.id}
          data-package-window-mode={paneWorkspace ? renderedPaneMode : "context"}
          data-geometry-ready={open !== null ? !geometryPending : true}
          data-rail-motion={exiting ? "exiting" : open !== null ? "open" : "closed"}
          data-geometry-flip={open !== null && geometryFlipped ? "true" : undefined}
          onAnimationEnd={(event) => {
            if (exiting && exitPaneMotion !== null && event.target === event.currentTarget) {
              paneMotionRef.current = null;
              setPaneMotionRevision((revision) => revision + 1);
            }
          }}
          onKeyDown={exiting ? undefined : onPaneKey}
        >
          {!exiting && panePinned && !panePinnedNarrow && !paneLayered && !paneCompactContext && (
            <div
              ref={separatorRef}
              className="rail-resize"
              onPointerDown={onHandleDown}
              onKeyDown={onHandleKey}
              onDoubleClick={onHandleDoubleClick}
              tabIndex={0}
              role="separator"
              aria-orientation="vertical"
              aria-label={tr("contextrail.resizeValue", { value: paneSurface?.title ?? tr("contextrail.panel") })}
              aria-valuemin={presentation && decision !== null ? paneMinWidth : 240}
              aria-valuemax={presentation && decision !== null ? Math.max(decision.maxPane, presentation.minWidth) : 640}
              aria-valuenow={dockWidth}
            />
          )}
          {!exiting && paneBottomDock && !paneCompactContext && (
            <div
              ref={bottomSeparatorRef}
              className="rail-resize-bottom"
              onPointerDown={onBottomHandleDown}
              onKeyDown={onBottomHandleKey}
              tabIndex={0}
              role="separator"
              aria-orientation="horizontal"
              aria-label={tr("contextrail.resizeValue", { value: paneSurface?.title ?? tr("contextrail.panel") })}
              aria-valuemin={bottomDockMin}
              aria-valuemax={bottomDockMax}
              aria-valuenow={bottomDockNow}
            />
          )}
          {!exiting && paneDynamic && RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              className={`package-window-resize package-window-resize--${edge}`}
              aria-hidden={edge !== "e" && edge !== "s"}
              {...(edge === "e" || edge === "s" ? {
                tabIndex: 0,
                role: "separator",
                "aria-orientation": edge === "e" ? "vertical" as const : "horizontal" as const,
                "aria-label": tr("contextrail.resizeValue", { value: paneSurface?.title ?? tr("contextrail.panel") }),
                "aria-valuemin": edge === "e" ? dynamicMinWidth : dynamicMinHeight,
                "aria-valuemax": edge === "e" ? dynamicMaxWidth : dynamicMaxHeight,
                "aria-valuenow": edge === "e" ? dynamicWidth : dynamicHeight,
                onKeyDown: (event: ReactKeyboardEvent) => onDynamicResizeKey(edge, event),
              } : {})}
              onPointerDown={(event) => onDynamicResizeDown(edge, event)}
            />
          ))}
          <ModuleView
            id={paneSurface?.id ?? "panel"}
            title={paneSurface?.title ?? ""}
            {...(paneSurface?.description ? { description: paneSurface.description } : {})}
            variant="rail"
            dir={shellDirection.contentDir}
            contentMode={paneWorkspace ? "workspace" : "panel"}
            icon={paneSurface?.icon ? paneSurface.icon() : undefined}
            pinned={panePinned}
            fullscreen={paneLayered}
            dockActions={renderedDockActions}
            onTogglePin={paneWorkspace && !compact && !homePane ? togglePanePin : undefined}
            onToggleFullscreen={paneWorkspace && !compact && !homePane ? togglePaneFullscreen : undefined}
            presented={open !== null}
            onClose={() => {
              if (isWorkspacePane) closeWorkspacePane();
              else if (compact) closeAllModules();
              else setRailPlugin(null);
            }}
            actions={!paneWorkspace
              ? <div className="rail-tabs"><SlotHost slot="contextRail.tabs" context={{ tab: rail, onSelect: toggleRailPlugin }} /></div>
              : undefined}
          >
          {renderedSurfaces.map((s) => {
            const active = !exiting && s.id === paneSurface?.id;
            const leaving = exiting && s.id === paneSurface?.id;
            return (
              <div
                key={s.id}
                className="rail-body"
                role={active ? undefined : "presentation"}
                hidden={!active && !leaving}
                inert={!active}
                aria-hidden={!active || undefined}
              >
                <PackageWindowContext.Provider value={s.id}>
                  <PaneVisibilityContext.Provider value={active}>
                    <ViewErrorBoundary inline resetKey={`${s.id}:${projectId ?? ""}`}>
                      <s.component active={active} projectId={projectId} sessionId={sessionId} />
                    </ViewErrorBoundary>
                  </PaneVisibilityContext.Provider>
                </PackageWindowContext.Provider>
              </div>
            );
          })}
          </ModuleView>
        </div>
        )}
        {showStrip && (
          <div
            className="rail-icon-col plugin-strip customize-zone"
            aria-label={tr("contextrail.workspacePanels")}
          >
            {safeAreaStrip === null && <ShellDock column="end" group="tools" />}
            <div className="rail-icon-scroll" ref={drag.ref} {...drag.dropProps} data-rail-drop-target={drag.targeted || undefined}>
              {drag.order.map((entry) => {
                if (entry === null) return <span key={drag.slotKey} className="rail-icon strip-btn rail-drag-slot" data-rail-slot aria-hidden="true" />;
                const widget = widgetById.get(entry);
                if (widget) return <RailWidgetItemView key={entry} item={widget} drag={drag} />;
                const s = railButtonById.get(entry);
                if (!s) return null;
                return (
                  <button
                    key={s.id}
                    className={`rail-icon strip-btn ${s.active ? "active" : ""}`}
                    title={s.title}
                    aria-label={s.title}
                    aria-pressed={s.kind === "command" ? undefined : s.active}
                    {...drag.itemProps(s.id)}
                    {...(s.presentation ? { "data-pane-launcher": s.id } : {})}
                    onClick={s.activate}
                  >
                    <s.icon />
                    <Badge n={s.badge} />
                  </button>
                );
              })}
            </div>
            <CustomizeZoneButton
              slot="workspace.rail"
              tier="more"
              side={shellDirection.towardStart}
              align="end"
              className="rail-icon strip-btn rail-customize"
            />
            {safeAreaStrip === null && <ShellDock column="end" group="actions" />}
            {safeAreaStrip === null && <ShellColumnAccount column="end" />}
          </div>
        )}
      </aside>
    </>
  );
}
