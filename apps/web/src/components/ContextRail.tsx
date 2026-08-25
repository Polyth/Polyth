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
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { formatCombo } from "@polyth/hotkeys";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import {
  closeWorkspacePane, collapseWorkspacePane, expandWorkspacePane, setPaneFullscreen,
  getState, setRailPlugin, setSidebarOpen, toggleRailPlugin, useActiveModel, useStore,
} from "../store.ts";
import { Icon } from "../icons.tsx";
import { useGitStatus } from "../gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  CHAT_FLOOR, clampDockWidth, decideDock, listSurfaces, slotSurfaces, useSurfaceVersion, visibleSurfaces,
  type DockGeometry, type RailSurface, type RailSurfaceContext,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { useResolvedCapabilities, type ResolvedCapability } from "../capabilities.ts";
import { PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import { getWorkspacePanePrefs, setPanePreferredWidth } from "../workspace/panePrefs.ts";
import { chatDockViability, dockGuardTargets } from "../workspace/dockGuard.ts";
import { PaneVisibilityContext } from "../workspace/paneVisibility.ts";
import "./railSurfaces.tsx";
import { setPlacementOverride } from "../capabilityLayout.ts";
import { tr } from "../i18n/index.ts";
import { MOD } from "../format.ts";
import { useKeymap } from "../hotkeys.ts";

const NO_EVENTS: never[] = [];
/** Fallback separator chrome before the real element is measured. */
const SEPARATOR_FALLBACK = 6;
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;

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
  icon?: RailSurface["icon"];
  badge: number;
  presentation?: RailSurface["presentation"];
  active: boolean;
  activate: () => void;
}

const capabilityIcon = (id: string): RailSurface["icon"] => {
  switch (id) {
    case "session": return Icon.chat;
    case "goals": return Icon.target;
    case "multirun": return Icon.compare;
    case "workflow": return Icon.hierarchy;
    case "fusion": return Icon.fuse;
    case "walkthrough": return Icon.list;
    case "schedule": return Icon.clock;
    case "github": return Icon.github;
    case "voice": return Icon.mic;
    case "models-agents": return Icon.gear;
    case "diagnostics": return Icon.shield;
    default: return Icon.context;
  }
};

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

  const gitStatus = useGitStatus(projectId, model.turn?.status === "working", session?.id);
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
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
      className="icon-btn narrow-panel-trigger"
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
  const paneExpanded = useStore((s) => s.paneExpanded);
  const view = useStore((s) => s.activeView);
  const resolved = useResolvedCapabilities();
  const keymap = useKeymap();
  const terminalShortcut = formatCombo(keymap.viewTerminal, MOD === "⌘");
  const presentation = open?.presentation;
  const badgeOf = (surface: RailSurface): number => surface.badge?.(ctx) ?? 0;
  const surfaceByCapability = new Map(surfaces.map((surface) => [surface.capabilityId ?? surface.id, surface]));
  const activeCapability = (capability: ResolvedCapability): boolean => {
    const id = capability.descriptor.id;
    const activeView = VIEW_OF_CAPABILITY[id];
    if (activeView !== undefined) return view === activeView;
    const pane = PANE_OF_CAPABILITY[id];
    if (pane !== undefined) return rail === pane;
    const panel = PANEL_OF_CAPABILITY[id];
    return panel !== undefined && rail === panel;
  };
  const buttonForSurface = (surface: RailSurface): RailButton => ({
    id: surface.capabilityId ?? surface.id,
    capabilityId: surface.capabilityId ?? surface.id,
    title: surface.id === "terminal"
      ? tr("terminalview.openTerminalShortcut", { shortcut: terminalShortcut })
      : surface.title,
    icon: surface.icon,
    badge: badgeOf(surface),
    presentation: surface.presentation,
    active: rail === surface.id,
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
        icon: capabilityIcon(capability.descriptor.id),
        badge: 0,
        active: activeCapability(capability),
        activate: () => {
          setRailPlugin(null);
          capability.descriptor.open();
        },
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
  const openButton = open ? buttonForSurface(open) : null;
  const railButtons = openButton && !configuredRailButtons.some((button) => button.id === openButton.id)
    ? [openButton, ...configuredRailButtons]
    : configuredRailButtons;
  const reorderRail = (draggedId: string, targetId: string) => {
    if (!configuredRailButtons.some((button) => button.id === draggedId)
      || !configuredRailButtons.some((button) => button.id === targetId)
      || draggedId === targetId) return;
    const ordered = configuredRailButtons
      .map((button) => button.id)
      .filter((buttonId) => buttonId !== draggedId);
    ordered.splice(ordered.indexOf(targetId), 0, draggedId);
    ordered.forEach((capabilityId, rank) => {
      setPlacementOverride(capabilityId, { tier: "more", rank });
    });
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
  const kept = surfaces.filter((s) => s.id === rail || visited.includes(s.id));

  // ---- geometry: measured post-sidebar workspace (Chat + pane + chrome) --------
  const railbarRef = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const geometryKey = `${projectId ?? ""}:${open?.id ?? ""}:${presentation ? "workspace" : "context"}:${compact ? "compact" : "wide"}:${paneExpanded ? "expanded" : "normal"}`;
  const [geometry, setGeometry] = useState<{ key: string; width: number }>({ key: "", width: 0 });
  const workspaceWidth = geometry.key === geometryKey ? geometry.width : 0;
  const chatElOf = () =>
    railbarRef.current?.closest(".app")?.querySelector(":scope > .app-shell > .workspace") ?? null;

  useLayoutEffect(() => {
    const measure = () => {
      const chat = chatElOf();
      const paneW = presentation && paneRef.current && !paneRef.current.classList.contains("rail-fullscreen")
        ? paneRef.current.getBoundingClientRect().width
        : 0;
      const chatW = chat ? chat.getBoundingClientRect().width : 0;
      const width = Math.round(chatW + paneW);
      setGeometry((current) =>
        current.key === geometryKey && current.width === width ? current : { key: geometryKey, width });
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

  const chrome = (separatorRef.current?.getBoundingClientRect().width ?? SEPARATOR_FALLBACK) || SEPARATOR_FALLBACK;
  const geo: DockGeometry = { workspaceWidth, chrome };

  // ---- dock decision + presentation mode ----------------------------------------
  const paneWidths = projectId !== null ? getWorkspacePanePrefs(projectId).widths : {};
  const remembered = open !== null && presentation ? paneWidths[open.id] ?? null : null;
  const decision = presentation ? decideDock(remembered, presentation, geo) : null;

  // Live (uncommitted) drag width; preferred width persists on commit only.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  useEffect(() => { setLiveWidth(null); }, [open?.id, projectId]);

  // Sticky automatic fallback: once the user interacts inside the full-screen
  // layer, geometry changes must not yank the mode back behind their back.
  const [stickyFullscreen, setStickyFullscreen] = useState(false);
  const interactedRef = useRef(false);
  useEffect(() => {
    setStickyFullscreen(false);
    interactedRef.current = false;
  }, [open?.id]);

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
  const rawMode: "docked" | "layer" = !isWorkspacePane
    ? "docked"
    : compact || paneExpanded || stickyFullscreen || guardPromoted || (measured && !admits)
      ? "layer"
      : "docked";
  const guardInputs = `${open?.id ?? ""}:${projectId ?? ""}:${remembered ?? "auto"}`;
  const settledModeRef = useRef<{ key: string; width: number; mode: "docked" | "layer" } | null>(null);
  const settledKey = `${guardInputs}:${compact}:${paneExpanded}:${stickyFullscreen}:${guardPromoted}`;
  let mode = rawMode;
  if (isWorkspacePane && measured) {
    const settled = settledModeRef.current;
    if (
      settled !== null
      && settled.key === settledKey
      && Math.abs(settled.width - workspaceWidth) <= GUARD_WIDTH_TOLERANCE
    ) {
      mode = settled.mode;
    } else {
      settledModeRef.current = { key: settledKey, width: workspaceWidth, mode: rawMode };
    }
  }
  const layered = isWorkspacePane && mode === "layer";

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
    if (!isWorkspacePane || !measured || mode !== "docked") return;

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
  }, [guardInputs, workspaceWidth, dockWidth, mode, isWorkspacePane, measured]);

  // Publish presentation truth so App can make hidden Chat inert.
  useEffect(() => {
    setPaneFullscreen(layered);
    return () => setPaneFullscreen(false);
  }, [layered]);

  // Entering the layer moves focus only when the focused element would become
  // hidden (it was inside Chat); Back to Chat is the first focusable action.
  useEffect(() => {
    if (!layered) return;
    const focused = document.activeElement;
    const chat = chatElOf();
    if (focused && chat && chat.contains(focused)) backRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layered]);

  // ---- resize: pointer + keyboard on a real separator ---------------------------
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
    if (open === null || layered) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: dockWidth };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const raw = d.startW + (d.startX - ev.clientX);
      if (presentation && decision !== null && raw < presentation.minWidth - 24) {
        // Crossing below the content minimum promotes instead of squeezing.
        dragRef.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setLiveWidth(null);
        setStickyFullscreen(true);
        interactedRef.current = true;
        return;
      }
      setLiveWidth(presentation ? raw : clampRailWidth(raw));
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!d) return;
      const raw = d.startW + (d.startX - ev.clientX);
      const committed = presentation ? clampDockWidth(raw, presentation, geo) : clampRailWidth(raw);
      setLiveWidth(committed);
      commitWidth(committed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHandleKey = (e: ReactKeyboardEvent) => {
    if (open === null) return;
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = dockWidth + step;
    else if (e.key === "ArrowRight") next = dockWidth - step;
    else if (e.key === "Home") next = presentation ? presentation.minWidth : 240;
    else if (e.key === "End") next = presentation && decision !== null ? decision.maxPane : 640;
    if (next === null) return;
    e.preventDefault();
    if (presentation && decision !== null && next < presentation.minWidth) {
      setStickyFullscreen(true);
      interactedRef.current = true;
      return;
    }
    const committed = presentation ? clampDockWidth(next, presentation, geo) : clampRailWidth(next);
    setLiveWidth(committed);
    commitWidth(committed);
  };

  // Non-terminal Escape closes the pane (Files runs its own ladder that ends
  // in the same command; the terminal consumes Escape for the PTY).
  const onPaneKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || !isWorkspacePane || presentation === undefined) return;
    if (presentation.escape !== "close" || open.id === "files") return;
    e.stopPropagation();
    closeWorkspacePane();
  };

  // Interaction inside the automatic full-screen fallback makes it sticky:
  // geometry becoming admissible again then exposes "Dock beside Chat"
  // instead of yanking the mode back behind the user's back.
  const onLayerInteract = () => {
    if (layered && !paneExpanded && !compact) {
      interactedRef.current = true;
      setStickyFullscreen(true);
    }
  };

  const dockNow = () => {
    setStickyFullscreen(false);
    interactedRef.current = false;
    // Explicit user retry: drop the guard latch so the dock is judged fresh;
    // a still-invalid dock re-promotes once (no loop — the latch re-arms).
    guardLatchRef.current = null;
    setGuardPromoted(false);
    collapseWorkspacePane();
  };

  const geometryPending = isWorkspacePane && !measured && !compact && !paneExpanded;
  const paneStyle: CSSProperties | undefined = open
    ? ({
        "--rail-w": `${dockWidth}px`,
        ...(geometryPending ? { visibility: "hidden", pointerEvents: "none" } : {}),
      } as CSSProperties)
    : { display: "none" };

  // Compact contextual surfaces use the A390 modal sheet. Canonical workspace
  // surfaces retain the pane model's full-screen layer and bottom navigation.
  const compactContext = compact && open !== null && !isWorkspacePane;
  useModalSurface({
    enabled: compact && !isWorkspacePane,
    open: compactContext,
    onClose: () => setRailPlugin(null),
    containerRef: paneRef,
  });

  return (
    <>
      {compactContext && <div className="menu-backdrop sheet-backdrop" onClick={() => setRailPlugin(null)} />}
      <aside className={`railbar${open ? " railbar-open" : ""}`} ref={railbarRef}>
        {kept.length > 0 && (
        <div
          ref={paneRef}
          id={compact ? "polyth-panel-sheet" : undefined}
          className={compactContext
            ? "panel-sheet"
            : `rail${isWorkspacePane ? " rail-workspace" : ""}${layered ? " rail-fullscreen" : ""}`}
          style={compactContext ? undefined : paneStyle}
          role={compactContext ? "dialog" : "region"}
          aria-modal={compactContext || undefined}
          aria-label={open?.title ?? tr("contextrail.panel")}
          data-geometry-ready={!geometryPending}
          onKeyDown={onPaneKey}
          onPointerDownCapture={onLayerInteract}
        >
          {!layered && !compactContext && (
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
          <div className={`rail-head${compactContext ? " sheet-head" : ""}`}>
            {layered && (
              <button
                ref={backRef}
                className="rail-toggle pane-back"
                onClick={() => closeWorkspacePane()}
              >
                {tr("contextrail.backToChat")}</button>
            )}
            <span className="rail-title">{open?.title ?? ""}</span>
            <span className="header-spacer" />
            {!isWorkspacePane && (
              <div className="rail-tabs"><SlotHost slot="contextRail.tabs" context={{ tab: rail, onSelect: toggleRailPlugin }} /></div>
            )}
            {isWorkspacePane && !layered && (
              <button className="rail-toggle" onClick={expandWorkspacePane} title={tr("contextrail.expand")} aria-label={tr("contextrail.expandValue", { value: open?.title ?? tr("contextrail.panel") })}>⤢</button>
            )}
            {isWorkspacePane && layered && paneExpanded && !compact && (
              <button className="rail-toggle" onClick={collapseWorkspacePane} title={tr("contextrail.collapse")} aria-label={tr("contextrail.collapseValue", { value: open?.title ?? tr("contextrail.panel") })}>⤡</button>
            )}
            {isWorkspacePane && layered && !paneExpanded && !compact && measured && admits && (
              <button className="rail-toggle" onClick={dockNow}>{tr("contextrail.dockBesideChat")}</button>
            )}
            <button
              className="rail-toggle"
              onClick={() => (isWorkspacePane ? closeWorkspacePane() : setRailPlugin(null))}
              title={tr("contextrail.closePanel")}
              aria-label={tr("contextrail.closePanel")}
            >{compactContext ? tr("contextrail.message") : "»"}</button>
          </div>
          {compactContext && (
            <div className="plugin-strip sheet-strip" aria-label={tr("contextrail.workspacePanels")}>
              {railButtons.map((s) => (
                <button
                  key={s.id}
                  className={`rail-icon strip-btn ${s.active ? "active" : ""}`}
                  title={s.title}
                  aria-label={s.title}
                  aria-pressed={s.active}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("text/polyth-rail", s.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    reorderRail(event.dataTransfer.getData("text/polyth-rail"), s.id);
                  }}
                  {...(s.presentation ? { "data-pane-launcher": s.id } : {})}
                  onClick={s.activate}
                >
                  {s.icon ? <s.icon /> : <Icon.context />}
                  <Badge n={s.badge} />
                </button>
              ))}
            </div>
          )}
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
                <PaneVisibilityContext.Provider value={active}>
                  <s.component active={active} />
                </PaneVisibilityContext.Provider>
              </div>
            );
          })}
        </div>
        )}
        {!compact && (
          <div className="rail-icon-col plugin-strip" aria-label={tr("contextrail.workspacePanels")}>
            {railButtons.map((s) => (
            <button
              key={s.id}
              className={`rail-icon strip-btn ${s.active ? "active" : ""}`}
              title={s.title}
              aria-label={s.title}
              aria-pressed={s.active}
              draggable
              onDragStart={(event) => event.dataTransfer.setData("text/polyth-rail", s.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                reorderRail(event.dataTransfer.getData("text/polyth-rail"), s.id);
              }}
              {...(s.presentation ? { "data-pane-launcher": s.id } : {})}
              onClick={s.activate}
            >
              {s.icon ? <s.icon /> : <Icon.context />}
              <Badge n={s.badge} />
            </button>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
