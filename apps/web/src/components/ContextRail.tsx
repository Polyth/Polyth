// F17 right-pane surface host. The rail renders whatever the surface registry
// holds (built-ins register in railSurfaces.tsx; plugins arrive through the
// "workspace.right.tabs" slot or window.__polythSurfaces) — this component
// never enumerates panels. Visited panels stay mounted (keep-alive) so tree,
// editor, and scroll state survive switching; per-surface width and the
// last-open surface persist in polyth.railPrefs.
// UX-A390: below 821px the inline rail/strip reserves zero workspace width.
// The strip moves inside a modal panel sheet and the header hosts
// NarrowPanelTrigger, which shares the exact same visibleSurfaces(...) model.
//
// UX-PERSONAS: presets order capabilities but never gate them. Every panel
// remains reachable through the shared capability model and More tools.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { renderSlot } from "../slots.ts";
import { getState, useActiveModel, useStore, setActiveView, setRailPlugin, setSidebarOpen, toggleRailPlugin, type AppView } from "../store.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  slotSurfaces, useSurfaceVersion, listSurfaces, visibleSurfaces,
  type RailSurface, type RailSurfaceContext,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import {
  GROUP_ORDER, TECHNICAL_GROUP_LABEL, capabilityGroup, useResolvedCapabilities,
  type ResolvedCapability,
} from "../capabilities.ts";
import { VIEW_OF_CAPABILITY } from "../builtinCapabilities.ts";
import "./railSurfaces.tsx";

const JUMP_ICONS: Partial<Record<AppView, () => JSX.Element>> = {
  preview: Icon.globe,
  multirun: Icon.compare,
  fusion: Icon.fuse,
  terminal: Icon.term,
  schedule: Icon.clock,
  github: Icon.github,
  git: Icon.tree,
  goals: Icon.context,
  walkthrough: Icon.events,
};

const NO_EVENTS: never[] = [];

// Small count badge on strip buttons (UX-33).
function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="strip-badge">{n > 9 ? "9+" : n}</span>;
}

interface RailSurfaceModel {
  rail: string | null;
  surfaces: RailSurface[];
  open: RailSurface | null;
  ctx: RailSurfaceContext;
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

  const gitStatus = useGitStatus(projectId, model.turn?.status === "working", session?.id);
  const ctx: RailSurfaceContext = {
    changeCount: gitStatus ? gitChangedFiles(gitStatus).length : 0,
    eventCount: events.length,
    totalTokens: model.totals.input + model.totals.output,
    hasSession: session !== null,
  };

  useSurfaceVersion(); // re-render when surfaces register/unregister
  // Preset-compatible ordering: panels whose capability resolves primary come
  // first, then the resolved rank; nothing is removed.
  const positionOf = new Map(resolved.map((c, i) => [c.descriptor.id, i]));
  const surfaces = visibleSurfaces([...listSurfaces(), ...slotSurfaces()], ctx)
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
  const label = open ? `Close ${open.title} panel` : "Open workspace panels";
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
  const mode = useShellMode();
  const compact = mode !== "wide";
  const { rail, surfaces, open, ctx } = useRailSurfaceModel();
  const view = useStore((s) => s.activeView);
  const resolved = useResolvedCapabilities();
  const [moreOpen, setMoreOpen] = useState(false);
  useEscape(moreOpen, () => setMoreOpen(false));
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  // Keep-alive: panels stay mounted once visited so their state survives
  // switching surfaces; surfaces that lose content-driven visibility unmount.
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (rail !== null && !visited.includes(rail)) setVisited((v) => [...v, rail]);
  }, [rail, visited]);
  // A registered surface that became invisible (content gone) closes the
  // panel; an id that is merely not registered *yet* (a plugin still loading)
  // is left alone so it opens once the surface arrives.
  const known = rail !== null && [...listSurfaces(), ...slotSurfaces()].some((s) => s.id === rail);
  useEffect(() => {
    if (rail !== null && known && open === null) setRailPlugin(null);
  }, [rail, known, open]);
  const kept = surfaces.filter((s) => s.id === rail || visited.includes(s.id));

  // Per-surface width with a drag handle on the panel's left edge (wide only;
  // the compact sheet has a fixed CSS width and hides the separator).
  const [width, setWidth] = useState<number>(() => railWidthOf(rail));
  useEffect(() => { setWidth(railWidthOf(rail)); }, [rail]);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent) => {
    if (open === null) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const surfaceId = open.id;
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (d) setWidth(clampRailWidth(d.startW + (d.startX - ev.clientX)));
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d) setRailWidth(surfaceId, clampRailWidth(d.startW + (d.startX - ev.clientX)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Compact sheet: modal focus behavior shared with Dialog and the drawer.
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalSurface({
    enabled: compact,
    open: compact && open !== null,
    onClose: () => setRailPlugin(null),
    containerRef: sheetRef,
  });

  // Full-view jumps for primary capabilities that are views (not the chat
  // itself and not a strip panel).
  const panelCapabilities = new Set(surfaces.map((s) => s.capabilityId ?? s.id));
  const jumps = resolved.filter((c) => {
    if (c.tier !== "primary" || !c.descriptor.available()) return false;
    const v = VIEW_OF_CAPABILITY[c.descriptor.id];
    return !!v && v !== "session" && !panelCapabilities.has(c.descriptor.id);
  });

  const slotTabs = renderSlot("contextRail.tabs", { tab: rail, onSelect: toggleRailPlugin });
  const badgeOf = (s: RailSurface): number => s.badge?.(ctx) ?? 0;

  // Same resolved list as the header disclosure, grouped by user outcome.
  const groups = GROUP_ORDER
    .map((label) => ({
      label,
      items: resolved.filter((c) => capabilityGroup(c.descriptor.id) === label && c.descriptor.id !== "session"),
    }))
    .filter((g) => g.items.length > 0);

  const capabilityItem = (c: ResolvedCapability) => {
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
          setMoreOpen(false);
          c.descriptor.open();
        }}
      >
        <span>{c.descriptor.label}{alias}</span>
        {!available && reason && <span className="more-tools-reason">{reason}</span>}
      </button>
    );
  };

  const moreToolsPicker = (
    <>
      <button
        ref={moreTriggerRef}
        className="rail-icon strip-btn strip-more"
        title="More tools"
        aria-label="More tools"
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        onClick={() => setMoreOpen((v) => !v)}
      >
        <span className="strip-more-text" aria-hidden="true">More</span>
      </button>
      {moreOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMoreOpen(false)} />
          <div className="strip-picker more-tools-popup" role="menu" aria-label="More tools">
            {groups.map((g) => (
              <div className="more-tools-group" key={g.label}>
                <div className="more-tools-group-label">
                  {g.label === TECHNICAL_GROUP_LABEL ? TECHNICAL_GROUP_LABEL : g.label}
                </div>
                {g.items.map(capabilityItem)}
              </div>
            ))}
            <button
              className="strip-picker-manage"
              onClick={() => {
                setMoreOpen(false);
                setActiveView("session");
                window.dispatchEvent(new CustomEvent("polyth:open-settings"));
              }}
            >
              Manage in Settings…
            </button>
          </div>
        </>
      )}
    </>
  );

  if (compact) {
    // The inline rail and strip are absent from layout and the accessibility
    // tree; NarrowPanelTrigger in the header is the only entry point. The
    // sheet stays mounted (hidden + inert) while closed so visited panels
    // keep their state.
    if (open === null && kept.length === 0) return null;
    return (
      <>
        {open !== null && <div className="menu-backdrop sheet-backdrop" onClick={() => setRailPlugin(null)} />}
        <div
          ref={sheetRef}
          id="polyth-panel-sheet"
          className="panel-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`${open?.title ?? "Workspace"} panel`}
          style={open !== null ? undefined : { display: "none" }}
        >
          <div className="rail-head sheet-head">
            <span className="rail-title">{open?.title ?? ""}</span>
            <span className="header-spacer" />
            <div className="rail-tabs">{slotTabs.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</div>
            <button className="rail-toggle sheet-close" onClick={() => setRailPlugin(null)} title="Close panel" aria-label="Close panel">×</button>
          </div>
          <div className="plugin-strip sheet-strip" aria-label="Workspace panels">
            {surfaces.map((s) => (
              <button
                key={s.id}
                className={`rail-icon strip-btn ${rail === s.id ? "active" : ""}`}
                title={s.title}
                aria-label={s.title}
                aria-pressed={rail === s.id}
                onClick={() => setRailPlugin(s.id)}
              >
                {s.icon ? <s.icon /> : <Icon.context />}
                <Badge n={badgeOf(s)} />
              </button>
            ))}
            {jumps.length > 0 && <span className="strip-sep" />}
            {jumps.map((c) => {
              const v = VIEW_OF_CAPABILITY[c.descriptor.id]!;
              const JIcon = JUMP_ICONS[v] ?? Icon.context;
              return (
                <button
                  key={c.descriptor.id}
                  className={`rail-icon strip-btn ${view === v ? "active" : ""}`}
                  title={c.descriptor.label}
                  aria-label={c.descriptor.label}
                  aria-pressed={view === v}
                  onClick={() => { c.descriptor.open(); setRailPlugin(null); }}
                >
                  <JIcon />
                </button>
              );
            })}
            <span className="strip-spacer" />
            {moreToolsPicker}
          </div>
          {kept.map((s) => (
            <div key={s.id} className="rail-body" style={s.id === rail ? undefined : { display: "none" }}>
              <s.component />
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <aside className="railbar">
      {kept.length > 0 && (
        <div
          className="rail"
          style={open ? ({ "--rail-w": `${width}px` } as CSSProperties) : { display: "none" }}
        >
          <div className="rail-resize" onPointerDown={onHandleDown} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
          <div className="rail-head">
            <span className="rail-title">{open?.title ?? ""}</span>
            <span className="header-spacer" />
            <div className="rail-tabs">{slotTabs.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</div>
            <button className="rail-toggle" onClick={() => setRailPlugin(null)} title="Close panel" aria-label="Close panel">»</button>
          </div>
          {kept.map((s) => (
            <div key={s.id} className="rail-body" style={s.id === rail ? undefined : { display: "none" }}>
              <s.component />
            </div>
          ))}
        </div>
      )}
      <div className="rail-icon-col plugin-strip" aria-label="Workspace panels">
        {surfaces.map((s) => (
          <button
            key={s.id}
            className={`rail-icon strip-btn ${rail === s.id ? "active" : ""}`}
            title={s.title}
            aria-label={s.title}
            aria-pressed={rail === s.id}
            onClick={() => toggleRailPlugin(s.id)}
          >
            {s.icon ? <s.icon /> : <Icon.context />}
            <Badge n={badgeOf(s)} />
          </button>
        ))}
        {jumps.length > 0 && <span className="strip-sep" />}
        {jumps.map((c) => {
          const v = VIEW_OF_CAPABILITY[c.descriptor.id]!;
          const JIcon = JUMP_ICONS[v] ?? Icon.context;
          return (
            <button
              key={c.descriptor.id}
              className={`rail-icon strip-btn ${view === v ? "active" : ""}`}
              title={c.descriptor.label}
              aria-label={c.descriptor.label}
              aria-pressed={view === v}
              onClick={() => c.descriptor.open()}
            >
              <JIcon />
            </button>
          );
        })}
        <span className="strip-spacer" />
        {moreToolsPicker}
      </div>
    </aside>
  );
}
