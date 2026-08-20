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
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import {
  closeWorkspacePane, collapseWorkspacePane, expandWorkspacePane, setOverlay, setPaneFullscreen,
  setRailPlugin, toggleRailPlugin, useActiveModel, useStore,
} from "../store.ts";
import { PLUGIN_LABELS, togglePlugin, usePrefs, type PluginId } from "../prefs.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  CHAT_FLOOR, clampDockWidth, decideDock, listSurfaces, slotSurfaces, useSurfaceVersion, visibleSurfaces,
  type DockGeometry, type RailSurface, type RailSurfaceContext,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import { getWorkspacePanePrefs, setPanePreferredWidth } from "../workspace/panePrefs.ts";
import { PaneVisibilityContext } from "../workspace/paneVisibility.ts";
import "./railSurfaces.tsx";

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

/** Compact presentation breakpoint: all workspace surfaces are full-screen. */
function useCompact(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 820px)").matches
      : false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setCompact(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return compact;
}

/** Layout-phase dock guard: Chat's content box holds the floor, timeline and
 *  composer have visible boxes, and every visible composer action is inside
 *  Chat's clip rectangle and wins its own center hit-test. Failure promotes
 *  to full-screen before pointer input is accepted — overflow clipping is
 *  never treated as success. */
function chatDockViable(chatEl: Element | null): boolean {
  if (!chatEl) return true; // nothing to protect (no chat rendered)
  const chat = chatEl.getBoundingClientRect();
  if (chat.width < CHAT_FLOOR) return false;
  const timeline = chatEl.querySelector(".timeline-wrap, .stage");
  const composer = chatEl.querySelector(".composer");
  if (!timeline && !composer) return true; // non-chat primary view
  for (const el of [timeline, composer]) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
  }
  if (composer) {
    const actions = composer.querySelectorAll<HTMLElement>("button, textarea, [role=button]");
    for (const action of actions) {
      const r = action.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // hidden action: fine
      if (r.left < chat.left - 0.5 || r.right > chat.right + 0.5) return false;
      if (typeof document.elementFromPoint === "function") {
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && hit !== action && !action.contains(hit) && !hit.contains(action)) return false;
      }
    }
  }
  return true;
}

export default function ContextRail() {
  const rail = useStore((s) => s.railPlugin);
  const projectId = useStore((s) => s.activeProjectId);
  const paneExpanded = useStore((s) => s.paneExpanded);
  const prefs = usePrefs();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const [picker, setPicker] = useState(false);
  useEscape(picker, () => setPicker(false));
  const compact = useCompact();

  const gitOn = prefs.plugins.includes("git");
  const gitStatus = useGitStatus(gitOn ? projectId : null, model.turn?.status === "working", session?.id);
  const ctx: RailSurfaceContext = {
    changeCount: gitStatus ? gitChangedFiles(gitStatus).length : 0,
    eventCount: events.length,
    totalTokens: model.totals.input + model.totals.output,
    hasSession: session !== null,
  };

  useSurfaceVersion(); // re-render when surfaces register/unregister
  useSlotVersion(); // …and when workspace.right.tabs slot items arrive/leave
  const surfaces = visibleSurfaces([...listSurfaces(), ...slotSurfaces(ctx)], prefs.plugins, ctx);
  const open = surfaces.find((s) => s.id === rail) ?? null;
  const presentation = open?.presentation;

  // Keep-alive: panels stay mounted once visited so their state survives
  // switching surfaces; unavailable surfaces (plugin off) unmount naturally.
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (rail !== null && !visited.includes(rail)) setVisited((v) => [...v, rail]);
  }, [rail, visited]);
  // A registered surface that became invisible (content gone / plugin off)
  // closes the panel; an id that is merely not registered *yet* (a plugin
  // still loading) is left alone so it opens once the surface arrives.
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
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const chatElOf = () =>
    railbarRef.current?.closest(".app")?.querySelector(":scope > .workspace") ?? null;

  useEffect(() => {
    const measure = () => {
      const chat = chatElOf();
      const paneW = presentation && paneRef.current && !paneRef.current.classList.contains("rail-fullscreen")
        ? paneRef.current.getBoundingClientRect().width
        : 0;
      const chatW = chat ? chat.getBoundingClientRect().width : 0;
      setWorkspaceWidth(Math.round(chatW + paneW));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    const chat = chatElOf();
    if (chat) ro.observe(chat);
    if (paneRef.current) ro.observe(paneRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id, paneExpanded, compact]);

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
  const [guardPromoted, setGuardPromoted] = useState(false);

  const isWorkspacePane = open !== null && presentation !== undefined;
  const measured = workspaceWidth > 0;
  const admits = decision !== null && decision.dock;
  const mode: "docked" | "layer" = !isWorkspacePane
    ? "docked"
    : compact || paneExpanded || stickyFullscreen || guardPromoted || (measured && !admits)
      ? "layer"
      : "docked";
  const layered = isWorkspacePane && mode === "layer";

  const dockWidth = decision !== null && presentation
    ? clampDockWidth(liveWidth ?? decision.width, presentation, geo)
    : railWidthOf(rail);

  // Reset the guard whenever the inputs it judged actually change.
  const guardKey = `${open?.id ?? ""}:${workspaceWidth}:${dockWidth}:${mode}`;
  const lastGuardKey = useRef("");
  useLayoutEffect(() => {
    if (lastGuardKey.current === guardKey) return;
    lastGuardKey.current = guardKey;
    if (!isWorkspacePane || mode !== "docked" || !measured) {
      setGuardPromoted(false);
      return;
    }
    setGuardPromoted(!chatDockViable(chatElOf()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey]);

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
    collapseWorkspacePane();
  };

  const togglable = (Object.keys(PLUGIN_LABELS) as PluginId[]).filter((id) => id !== "session");
  const badgeOf = (s: RailSurface): number => s.badge?.(ctx) ?? 0;

  const paneStyle: CSSProperties | undefined = open
    ? ({ "--rail-w": `${dockWidth}px` } as CSSProperties)
    : { display: "none" };

  return (
    <aside className="railbar" ref={railbarRef}>
      {kept.length > 0 && (
        <div
          ref={paneRef}
          className={`rail${isWorkspacePane ? " rail-workspace" : ""}${layered ? " rail-fullscreen" : ""}`}
          style={paneStyle}
          role="region"
          aria-label={open?.title ?? "Panel"}
          onKeyDown={onPaneKey}
          onPointerDownCapture={onLayerInteract}
        >
          {!layered && (
            <div
              ref={separatorRef}
              className="rail-resize"
              onPointerDown={onHandleDown}
              onKeyDown={onHandleKey}
              tabIndex={0}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${open?.title ?? "panel"}`}
              aria-valuemin={presentation && decision !== null ? presentation.minWidth : 240}
              aria-valuemax={presentation && decision !== null ? Math.max(decision.maxPane, presentation.minWidth) : 640}
              aria-valuenow={dockWidth}
            />
          )}
          <div className="rail-head">
            {layered && (
              <button
                ref={backRef}
                className="rail-toggle pane-back"
                onClick={() => closeWorkspacePane()}
              >
                ← Back to Chat
              </button>
            )}
            <span className="rail-title">{open?.title ?? ""}</span>
            <span className="header-spacer" />
            {!isWorkspacePane && (
              <div className="rail-tabs"><SlotHost slot="contextRail.tabs" context={{ tab: rail, onSelect: toggleRailPlugin }} /></div>
            )}
            {isWorkspacePane && !layered && (
              <button className="rail-toggle" onClick={expandWorkspacePane} title="Expand" aria-label={`Expand ${open?.title ?? "panel"}`}>⤢</button>
            )}
            {isWorkspacePane && layered && paneExpanded && !compact && (
              <button className="rail-toggle" onClick={collapseWorkspacePane} title="Collapse" aria-label={`Collapse ${open?.title ?? "panel"}`}>⤡</button>
            )}
            {isWorkspacePane && layered && !paneExpanded && !compact && measured && admits && (
              <button className="rail-toggle" onClick={dockNow}>Dock beside Chat</button>
            )}
            <button
              className="rail-toggle"
              onClick={() => (isWorkspacePane ? closeWorkspacePane() : setRailPlugin(null))}
              title="Close panel"
              aria-label="Close panel"
            >»</button>
          </div>
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
                  <s.component />
                </PaneVisibilityContext.Provider>
              </div>
            );
          })}
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
            {...(s.presentation ? { "data-pane-launcher": s.id } : {})}
            onClick={() => toggleRailPlugin(s.id)}
          >
            {s.icon ? <s.icon /> : <Icon.context />}
            <Badge n={badgeOf(s)} />
          </button>
        ))}
        <span className="strip-spacer" />
        <button
          className="rail-icon strip-btn"
          title="Add or remove plugins"
          aria-label="Add or remove plugins"
          aria-expanded={picker}
          onClick={() => setPicker((v) => !v)}
        >
          <Icon.plus />
        </button>
        {picker && (
          <>
            <div className="menu-backdrop" onClick={() => setPicker(false)} />
            <div className="strip-picker" role="menu">
              <div className="strip-picker-label">Plugins</div>
              {togglable.map((id) => {
                const on = prefs.plugins.includes(id);
                return (
                  <button key={id} aria-pressed={on} onClick={() => togglePlugin(id)}>
                    <span className="strip-picker-check">{on ? "✓" : ""}</span>
                    {PLUGIN_LABELS[id]}
                  </button>
                );
              })}
              <button className="strip-picker-manage" onClick={() => { setPicker(false); setOverlay("settings"); }}>
                Manage in settings…
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
