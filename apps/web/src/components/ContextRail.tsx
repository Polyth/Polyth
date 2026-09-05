// F17 + UX-PANE-MODEL right-pane surface host. The rail renders whatever the
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
// contextual in polyth.railPrefs, workspace panes per project in
// polyth.workspacePane.v1.<projectId>.
import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { formatCombo } from "@polyth/hotkeys";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import ModuleView from "./ui/ModuleView.ts";
import {
  closeAllModules, closePaneFromOutside, closeWorkspacePane, handlePaneEscape, setPaneFullscreen,
  togglePaneFullscreen, togglePanePin,
  getState, setRailPlugin, setSidebarOpen, toggleRailPlugin, useActiveModel, useStore,
} from "../store.ts";
import { useGitStatus } from "../../../../packages/git/widgets/gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  CHAT_FLOOR, clampDockWidth, decideDock, listSurfaces, slotSurfaces, useSurfaceVersion, visibleSurfaces,
  type DockGeometry, type RailSurface, type RailSurfaceContext,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { useResolvedCapabilities, type ResolvedCapability } from "../capabilities.ts";
import { isCapabilityActive, toggleCapability } from "../builtinCapabilities.ts";
import { clampPaneDimension, getWorkspacePanePrefs, setPaneDynamicHeight, setPanePreferredWidth } from "../workspace/panePrefs.ts";
import { chatDockViability, dockGuardTargets } from "../workspace/dockGuard.ts";
import { PaneVisibilityContext } from "../workspace/paneVisibility.ts";
import "./railSurfaces.tsx";
import { moveCapabilityBefore, setCapabilityTierOrder, setPlacementOverride } from "../capabilityLayout.ts";
import { tr } from "../i18n/index.ts";
import { MOD } from "../format.ts";
import { useKeymap } from "../../../../packages/hotkeys/widgets/hotkeys.ts";
import { railIconFor } from "../railIcons.ts";
import { type MenuEntry } from "./ui/index.ts";
import { useCustomizeActive } from "../useShiftArmed.ts";
import { CAPABILITY_MIME, getDragCapability, setDragCapability } from "../dnd.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { PackageWindowContext, pathBelongsToPackageWindow } from "./ui/PackageWindowContext.ts";
import ViewErrorBoundary from "./ViewErrorBoundary.ts";

const NO_EVENTS: never[] = [];
/** Fallback separator chrome before the real element is measured. */
const SEPARATOR_FALLBACK = 6;
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;
type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
const RESIZE_EDGES: ResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

// Small count badge on strip buttons (UX-33).
function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="strip-badge">{n > 9 ? "9+" : n}</span>;
}

/** Measured workspace widths within this distance are the SAME geometry: the
 *  full-screen layer takes the pane out of flow and Chat absorbs its width, so
 *  the Chat+pane sum re-measures within a border/rounding pixel or two of the
 *  docked sum. A promotion must not release on its own mode flip
 *  (PANE-VERIFY-02); a real window/sidebar resize moves well past this. */
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

/** A strip item is either a registered panel surface or a capability whose
 * destination is a full workspace view or a settings page. The Widgets page
 * deliberately lets people place both kinds in the right rail, so the strip
 * must not silently discard the latter just because it has no panel body. */
interface RailButton {
  id: string;
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
  const projectId = useStore((s) => s.activeProjectId);
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

/** UX-A390 header control: the only compact entry point to registered panels.
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
  const projectId = useStore((s) => s.activeProjectId);
  const paneMode = useStore((s) => s.paneMode);
  const resolved = useResolvedCapabilities();
  const keymap = useKeymap();
  const terminalShortcut = formatCombo(keymap.viewTerminal, MOD === "⌘");
  const presentation = open?.presentation;
  const badgeOf = (surface: RailSurface): number => surface.badge?.(ctx) ?? 0;
  const surfaceByCapability = new Map(surfaces.map((surface) => [surface.capabilityId ?? surface.id, surface]));
  const activeCapability = (capability: ResolvedCapability): boolean => {
    return isCapabilityActive(capability.descriptor.id);
  };
  const buttonForSurface = (surface: RailSurface): RailButton => ({
    id: surface.capabilityId ?? surface.id,
    capabilityId: surface.capabilityId ?? surface.id,
    title: surface.id === "terminal"
      ? tr("terminalview.openTerminalShortcut", { shortcut: terminalShortcut })
      : surface.title,
    icon: surface.icon ?? railIconFor(surface.capabilityId ?? surface.id),
    badge: badgeOf(surface),
    presentation: surface.presentation,
    active: isCapabilityActive(surface.capabilityId ?? surface.id),
    activate: () => toggleRailPlugin(surface.id),
  });
  const configuredRailButtons: RailButton[] = resolved
    // Terminal is a guaranteed workspace launcher. Keep it in the right rail
    // even when an older per-project layout still records its former
    // "technical" tier (or a customized primary placement).
    .filter((capability) =>
      (capability.tier === "more" || capability.descriptor.id === "terminal")
      && capability.descriptor.available())
    .map((capability) => {
      const surface = surfaceByCapability.get(capability.descriptor.id);
      if (surface) return buttonForSurface(surface);
      return {
        id: capability.descriptor.id,
        capabilityId: capability.descriptor.id,
        title: capability.descriptor.label,
        icon: railIconFor(capability.descriptor.id),
        badge: capability.descriptor.id === "git" ? ctx.changeCount : 0,
        active: activeCapability(capability),
        activate: () => toggleCapability(capability.descriptor.id, capability.descriptor.open),
      };
    });
  // Slot-contributed panels are not necessarily capabilities, but still
  // belong in the rail and remain reorderable through their surface id.
  for (const surface of surfaces) {
    const capabilityId = surface.capabilityId ?? surface.id;
    if (resolved.some((capability) => capability.descriptor.id === capabilityId)
      || configuredRailButtons.some((button) => button.id === capabilityId)) continue;
    configuredRailButtons.push(buttonForSurface(surface));
  }
  const railButtons = configuredRailButtons;

  // Shift-key customization mode: holding Shift over the rail reveals one
  // customize trigger as the strip's LAST item. Its checkbox menu adds or
  // removes capability panels instantly (checkbox entries keep the menu
  // open), by moving the capability between the `more` and `technical`
  // tiers of the per-project placement layout.
  const customizeActive = useCustomizeActive();
  const railIds = new Set(railButtons.map((button) => button.id));
  const rankAfter = (tier: "more" | "technical") =>
    Math.max(-1, ...resolved.filter((capability) => capability.tier === tier)
      .map((capability) => capability.rank)) + 1;
  const customizeEntries: MenuEntry[] = resolved
    .filter((capability) => capability.tier !== "primary" && capability.descriptor.available())
    .map((capability): MenuEntry => {
      const id = capability.descriptor.id;
      const inRail = railIds.has(id);
      return {
        id,
        label: capability.descriptor.label,
        icon: railIconFor(id),
        kind: "checkbox",
        checked: inRail,
        // Terminal is a guaranteed workspace launcher and cannot leave the rail.
        disabled: id === "terminal",
        onSelect: () => {
          if (inRail && rail !== null && (surfaceByCapability.get(id)?.id === rail || id === rail)) {
            setRailPlugin(null);
          }
          setPlacementOverride(id, inRail
            ? { tier: "technical", rank: rankAfter("technical") }
            : { tier: "more", rank: rankAfter("more") });
        },
      };
    });
  const capabilityIds = new Set(resolved.map((capability) => capability.descriptor.id));
  const dropRailButton = (event: ReactDragEvent<HTMLButtonElement>, targetId: string) => {
    const draggedId = getDragCapability(event.dataTransfer);
    if (!draggedId || !capabilityIds.has(targetId)) return;
    event.preventDefault();
    setCapabilityTierOrder("more", moveCapabilityBefore(
      railButtons.map((button) => button.id).filter((id) => capabilityIds.has(id)),
      draggedId,
      targetId,
    ));
  };
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
  const kept = surfaces.filter((s) =>
    s.id === rail || (s.presentation?.keepAlive === true && visited.includes(s.id)));

  // ---- geometry: measured post-sidebar workspace (Chat + pane + chrome) --------
  const railbarRef = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const geometryKey = `${projectId ?? ""}:${open?.id ?? ""}:${presentation ? "workspace" : "context"}:${compact ? "compact" : "wide"}:${paneMode}`;
  const [geometry, setGeometry] = useState<{ key: string; width: number; height: number }>({ key: "", width: 0, height: 0 });
  const workspaceWidth = geometry.key === geometryKey ? geometry.width : 0;
  const workspaceHeight = geometry.key === geometryKey ? geometry.height : 0;
  const chatElOf = () =>
    railbarRef.current?.closest(".app")?.querySelector(":scope > .app-shell > .workspace") ?? null;

  useLayoutEffect(() => {
    const measure = () => {
      const chat = chatElOf();
      const paneW = presentation && paneRef.current
        && paneRef.current.classList.contains("rail-pinned")
        && !paneRef.current.classList.contains("rail-pinned-narrow")
        ? paneRef.current.getBoundingClientRect().width
        : 0;
      const chatW = chat ? chat.getBoundingClientRect().width : 0;
      const width = Math.round(chatW + paneW);
      const height = Math.round(chat?.getBoundingClientRect().height ?? 0);
      setGeometry((current) =>
        current.key === geometryKey && current.width === width && current.height === height
          ? current : { key: geometryKey, width, height });
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    const chat = chatElOf();
    if (chat) ro.observe(chat);
    if (paneRef.current) ro.observe(paneRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey, presentation]);

  useLayoutEffect(() => {
    const header = railbarRef.current?.closest(".app")?.querySelector<HTMLElement>(":scope > .header");
    if (!header) return;
    const publish = () => {
      const width = paneRef.current?.classList.contains("rail-pinned")
        && !paneRef.current.classList.contains("rail-pinned-narrow")
        ? paneRef.current.getBoundingClientRect().width : 0;
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
  const remembered = open !== null && presentation ? paneWidths[open.id] ?? null : null;
  const decision = presentation ? decideDock(remembered, presentation, geo) : null;

  // Live (uncommitted) drag width; preferred width persists on commit only.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const [livePosition, setLivePosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setLiveWidth(null);
    setLiveHeight(null);
    setLivePosition({ x: 0, y: 0 });
  }, [open?.id, projectId]);
  useEffect(() => { setLivePosition({ x: 0, y: 0 }); }, [workspaceWidth, workspaceHeight]);

  // Layout guard result: docked geometry that clips or covers Chat promotes.
  // The promotion LATCHES (PANE-VERIFY-02): it releases only when a real
  // geometry input changes — surface, project, preferred width, or the
  // measured workspace width — never because the promotion itself flipped
  // the mode to the full-screen layer.
  const [guardPromoted, setGuardPromoted] = useState(false);
  const guardLatchRef = useRef<GuardLatch | null>(null);

  const isWorkspacePane = open !== null && presentation !== undefined;
  const measured = workspaceWidth > 0;
  const admits = decision !== null && decision.dock;
  const guardInputs = `${open?.id ?? ""}:${projectId ?? ""}:${remembered ?? "auto"}`;
  // Compact shells have room for one package at a time. Preserve the user's
  // desktop preference, but present every package as fullscreen on mobile.
  const effectivePaneMode = compact && isWorkspacePane ? "fullscreen" : paneMode;
  const layered = isWorkspacePane && effectivePaneMode === "fullscreen";
  const dynamic = isWorkspacePane && effectivePaneMode === "dynamic";
  const pinned = isWorkspacePane && effectivePaneMode === "pinned";
  const pinnedNarrow = pinned && (compact || (measured && (!admits || guardPromoted)));

  const dockWidth = decision !== null && presentation
    ? clampDockWidth(liveWidth ?? decision.width, presentation, geo)
    : railWidthOf(rail);

  // ---- layout guard engine (PANE-VERIFY-01/02) -----------------------------------
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
    if (presentation) {
      if (projectId !== null) setPanePreferredWidth(projectId, open.id, w);
    } else {
      setRailWidth(open.id, clampRailWidth(w));
    }
  };

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent) => {
    if (open === null || !pinned || pinnedNarrow) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: dockWidth };
    const direction = document.documentElement.dir === "rtl" ? 1 : -1;
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const raw = d.startW + direction * (ev.clientX - d.startX);
      setLiveWidth(presentation ? raw : clampRailWidth(raw));
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!d) return;
      const raw = d.startW + direction * (ev.clientX - d.startX);
      const committed = presentation ? clampDockWidth(raw, presentation, geo) : clampRailWidth(raw);
      setLiveWidth(committed);
      commitWidth(committed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up, { once: true });
  };

  const onHandleKey = (e: ReactKeyboardEvent) => {
    if (open === null || !pinned || pinnedNarrow) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    let next: number | null = null;
    const rtl = document.documentElement.dir === "rtl";
    if (e.key === "ArrowLeft") next = dockWidth + (rtl ? -step : step);
    else if (e.key === "ArrowRight") next = dockWidth + (rtl ? step : -step);
    else if (e.key === "Home") next = presentation ? presentation.minWidth : 240;
    else if (e.key === "End") next = presentation && decision !== null ? decision.maxPane : 640;
    if (next === null) return;
    e.preventDefault();
    const committed = presentation ? clampDockWidth(next, presentation, geo) : clampRailWidth(next);
    setLiveWidth(committed);
    commitWidth(committed);
  };

  const dynamicMaxWidth = Math.max(1, workspaceWidth - 32);
  const dynamicMinWidth = Math.min(presentation?.minWidth ?? 240, dynamicMaxWidth);
  const dynamicWidth = clampPaneDimension(liveWidth ?? remembered ?? Math.min(presentation?.preferredMaxWidth ?? 640, workspaceWidth * (presentation?.defaultRatio ?? 0.55)), dynamicMinWidth, workspaceWidth);
  const dynamicMaxHeight = Math.max(1, workspaceHeight - 16);
  const dynamicMinHeight = Math.min(presentation?.minHeight ?? 240, dynamicMaxHeight);
  const rememberedHeight = open ? panePrefs?.heights[open.id] : undefined;
  const dynamicHeight = clampPaneDimension(liveHeight ?? rememberedHeight ?? dynamicMaxHeight, dynamicMinHeight, dynamicMaxHeight);

  const onDynamicResizeDown = (edge: ResizeEdge, e: ReactPointerEvent) => {
    if (!dynamic || open === null) return;
    e.preventDefault();
    e.stopPropagation();
    const start = {
      x: e.clientX, y: e.clientY, width: dynamicWidth, height: dynamicHeight,
      position: livePosition,
      bounds: chatElOf()?.getBoundingClientRect() ?? null,
      box: paneRef.current?.getBoundingClientRect() ?? null,
    };
    document.documentElement.dataset.packageWindowResizing = "true";
    const move = (event: PointerEvent) => {
      const dx = event.clientX - start.x;
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
      const proposedX = start.position.x + (edge.includes("e") ? width - start.width : 0);
      const proposedY = start.position.y + (edge.includes("n") ? start.height - height : 0);
      const baseLeft = start.box ? start.box.right - start.position.x - width : 0;
      const baseTop = start.box ? start.box.top - start.position.y : 0;
      setLivePosition({
        x: start.bounds
          ? Math.min(start.bounds.right - baseLeft - width, Math.max(start.bounds.left - baseLeft, proposedX))
          : proposedX,
        y: start.bounds
          ? Math.min(start.bounds.bottom - baseTop - height, Math.max(start.bounds.top - baseTop, proposedY))
          : proposedY,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      delete document.documentElement.dataset.packageWindowResizing;
      const width = paneRef.current?.getBoundingClientRect().width ?? dynamicWidth;
      const height = paneRef.current?.getBoundingClientRect().height ?? dynamicHeight;
      commitWidth(width);
      if (projectId !== null) setPaneDynamicHeight(projectId, open.id, height);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  };

  const onDynamicResizeKey = (edge: "e" | "s", e: ReactKeyboardEvent) => {
    if (!dynamic || open === null) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    if (edge === "e") {
      const next = e.key === "Home" ? dynamicMinWidth
        : e.key === "End" ? dynamicMaxWidth
          : e.key === "ArrowLeft" ? dynamicWidth - step
            : e.key === "ArrowRight" ? dynamicWidth + step : null;
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
    const height = Math.min(dynamicMaxHeight, Math.max(dynamicMinHeight, next));
    setLiveHeight(height);
    if (projectId !== null) setPaneDynamicHeight(projectId, open.id, height);
  };

  // Package-owned portal surfaces carry the owner id through React context,
  // so interacting with their menu/popover/tooltip is never an outside click.
  useEffect(() => {
    if (!dynamic || open === null) return;
    const id = open.id;
    const outside = (event: PointerEvent) => {
      const modal = document.querySelector<HTMLElement>('[aria-modal="true"]');
      if (modal && modal !== paneRef.current) return;
      const owned = pathBelongsToPackageWindow(event.composedPath(), id);
      if (!owned) closePaneFromOutside();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [dynamic, open?.id]);

  const onPaneKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || !isWorkspacePane || presentation === undefined) return;
    if (presentation.escape !== "close") return;
    if (e.target instanceof Element) {
      const transient = e.target.closest('[role="menu"], [role="listbox"], [role="dialog"]');
      if (transient && transient !== paneRef.current) return;
    }
    e.stopPropagation();
    if (compact) closeWorkspacePane();
    else handlePaneEscape();
  };

  const geometryPending = isWorkspacePane && !measured;
  const paneStyle: CSSProperties | undefined = open
    ? ({
        "--rail-w": `${dynamic ? dynamicWidth : dockWidth}px`,
        "--package-window-h": `${dynamicHeight}px`,
        "--package-window-x": `${livePosition.x}px`,
        "--package-window-y": `${livePosition.y}px`,
        ...(geometryPending ? { visibility: "hidden", pointerEvents: "none" } : {}),
      } as CSSProperties)
    : { display: "none" };

  // Compact contextual surfaces use the A390 modal sheet. Canonical workspace
  // surfaces retain the pane model's full-screen layer and launcher strip.
  const compactContext = compact && open !== null && !isWorkspacePane;
  useModalSurface({
    enabled: compact && !isWorkspacePane,
    open: compactContext,
    onClose: () => setRailPlugin(null),
    containerRef: paneRef,
    resolveRestoreFocus: (opener) => opener
      ?? document.querySelector<HTMLElement>(".header-view-picker .picker-chip")
      ?? document.querySelector<HTMLElement>(".narrow-panel-trigger"),
  });

  return (
    <>
      {compactContext && <div className="menu-backdrop panel-sheet-backdrop" onClick={() => setRailPlugin(null)} />}
      <aside className={`railbar${open ? " railbar-open" : ""}${pinnedNarrow ? " railbar-pinned-narrow" : ""}`} ref={railbarRef}>
        {kept.length > 0 && (
        <div
          ref={paneRef}
          id={compact ? "polyth-panel-sheet" : undefined}
          className={compactContext
            ? "panel-sheet"
            : `rail${isWorkspacePane ? " rail-workspace" : ""}${dynamic ? " rail-dynamic" : ""}${pinned ? " rail-pinned" : ""}${pinnedNarrow ? " rail-pinned-narrow" : ""}${layered ? " rail-fullscreen" : ""}`}
          style={compactContext ? undefined : paneStyle}
          role={compactContext || layered || dynamic ? "dialog" : "region"}
          aria-modal={compactContext || undefined}
          aria-label={open?.title ?? tr("contextrail.panel")}
          data-package-window-owner={open?.id}
          data-package-window-mode={isWorkspacePane ? effectivePaneMode : "context"}
          data-geometry-ready={!geometryPending}
          onKeyDown={onPaneKey}
        >
          {pinned && !pinnedNarrow && !compactContext && (
            <div
              ref={separatorRef}
              className="rail-resize"
              onPointerDown={onHandleDown}
              onKeyDown={onHandleKey}
              tabIndex={0}
              role="separator"
              aria-orientation="vertical"
              aria-label={tr("contextrail.resizeValue", { value: open?.title ?? tr("contextrail.panel") })}
              aria-valuemin={presentation && decision !== null ? presentation.minWidth : 240}
              aria-valuemax={presentation && decision !== null ? Math.max(decision.maxPane, presentation.minWidth) : 640}
              aria-valuenow={dockWidth}
            />
          )}
          {dynamic && RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              className={`package-window-resize package-window-resize--${edge}`}
              aria-hidden={edge !== "e" && edge !== "s"}
              {...(edge === "e" || edge === "s" ? {
                tabIndex: 0,
                role: "separator",
                "aria-orientation": edge === "e" ? "vertical" as const : "horizontal" as const,
                "aria-label": tr("contextrail.resizeValue", { value: open.title }),
                "aria-valuemin": edge === "e" ? dynamicMinWidth : dynamicMinHeight,
                "aria-valuemax": edge === "e" ? dynamicMaxWidth : dynamicMaxHeight,
                "aria-valuenow": edge === "e" ? dynamicWidth : dynamicHeight,
                onKeyDown: (event: ReactKeyboardEvent) => onDynamicResizeKey(edge, event),
              } : {})}
              onPointerDown={(event) => onDynamicResizeDown(edge, event)}
            />
          ))}
          <ModuleView
            id={open?.id ?? "panel"}
            title={open?.title ?? ""}
            {...(open?.description ? { description: open.description } : {})}
            variant="rail"
            contentMode={isWorkspacePane ? "workspace" : "panel"}
            icon={open?.icon ? open.icon() : undefined}
            pinned={pinned}
            fullscreen={layered}
            onTogglePin={isWorkspacePane && !compact ? togglePanePin : undefined}
            onToggleFullscreen={isWorkspacePane && !compact ? togglePaneFullscreen : undefined}
            onClose={() => {
              if (isWorkspacePane) closeWorkspacePane();
              else if (compact) closeAllModules();
              else setRailPlugin(null);
            }}
            actions={!isWorkspacePane
              ? <div className="rail-tabs"><SlotHost slot="contextRail.tabs" context={{ tab: rail, onSelect: toggleRailPlugin }} /></div>
              : undefined}
          >
          {kept.map((s) => {
            const active = s.id === rail;
            return (
              <div
                key={s.id}
                className="rail-body"
                role={active ? undefined : "presentation"}
                hidden={!active}
                inert={!active}
                aria-hidden={!active || undefined}
              >
                <PackageWindowContext.Provider value={s.id}>
                  <PaneVisibilityContext.Provider value={active}>
                    <ViewErrorBoundary inline resetKey={`${s.id}:${projectId ?? ""}`}>
                      <s.component active={active} />
                    </ViewErrorBoundary>
                  </PaneVisibilityContext.Provider>
                </PackageWindowContext.Provider>
              </div>
            );
          })}
          </ModuleView>
        </div>
        )}
        {!compact && (
          <div
            className="rail-icon-col plugin-strip customize-zone"
            aria-label={tr("contextrail.workspacePanels")}
          >
            {railButtons.map((s) => (
            <button
              key={s.id}
              className={`rail-icon strip-btn ${s.active ? "active" : ""}`}
              title={s.title}
              aria-label={s.title}
              aria-pressed={s.active}
              draggable={customizeActive && capabilityIds.has(s.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragCapability(event.dataTransfer, s.id);
              }}
              onDragOver={(event) => {
                if (customizeActive && event.dataTransfer.types.includes(CAPABILITY_MIME)) event.preventDefault();
              }}
              onDrop={(event) => dropRailButton(event, s.id)}
              {...(s.presentation ? { "data-pane-launcher": s.id } : {})}
              onClick={s.activate}
            >
              <s.icon />
              <Badge n={s.badge} />
            </button>
            ))}
            {/* Widget-areas (WA3): widgets placed into the "Right rail" area
                render below the built-in tier launchers. */}
            <SlotHost slot="workspace.rail" context={{ editing: false }} customizable />
            <CustomizeZoneButton
              slot="workspace.rail"
              className="rail-icon strip-btn rail-customize"
              extraEntries={[
                { heading: tr("contextrail.workspacePanels") },
                ...customizeEntries,
              ]}
            />
          </div>
        )}
      </aside>
    </>
  );
}
