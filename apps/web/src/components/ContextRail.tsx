// F17 right-pane surface host. The rail renders whatever the surface registry
// holds (built-ins register in railSurfaces.tsx; plugins arrive through the
// "workspace.right.tabs" slot or window.__polythSurfaces) — this component
// never enumerates panels. Visited panels stay mounted (keep-alive) so tree,
// editor, and scroll state survive switching; per-surface width and the
// last-open surface persist in polyth.railPrefs.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { renderSlot } from "../slots.ts";
import { useActiveModel, useStore, setActiveView, setOverlay, setRailPlugin, toggleRailPlugin, type AppView } from "../store.ts";
import { PLUGIN_LABELS, togglePlugin, usePrefs, type PluginId } from "../prefs.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";
import {
  slotSurfaces, useSurfaceVersion, listSurfaces, visibleSurfaces,
  type RailSurface, type RailSurfaceContext,
} from "../surfaces.ts";
import { clampRailWidth, railWidthOf, setRailWidth } from "../railPrefs.ts";
import "./railSurfaces.tsx";

// Full-view jumps that live on the strip when their plugin is on.
// Icons only (like polyth): title + aria-label carry the names.
const JUMPS: Array<{ view: AppView; plugin: PluginId; label: string; icon: () => JSX.Element }> = [
  { view: "preview", plugin: "preview", label: "Preview", icon: Icon.globe },
  { view: "multirun", plugin: "multirun", label: "Compare models", icon: Icon.compare },
  { view: "fusion", plugin: "fusion", label: "Fuse models", icon: Icon.fuse },
  { view: "terminal", plugin: "terminal", label: "Terminal", icon: Icon.term },
  { view: "schedule", plugin: "schedule", label: "Scheduled prompts", icon: Icon.clock },
  { view: "github", plugin: "github", label: "GitHub", icon: Icon.github },
];

const NO_EVENTS: never[] = [];

// Small count badge on strip buttons (UX-33).
function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="strip-badge">{n > 9 ? "9+" : n}</span>;
}

export default function ContextRail() {
  const rail = useStore((s) => s.railPlugin);
  const view = useStore((s) => s.activeView);
  const projectId = useStore((s) => s.activeProjectId);
  const prefs = usePrefs();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const [picker, setPicker] = useState(false);
  useEscape(picker, () => setPicker(false));

  const gitOn = prefs.plugins.includes("git");
  const gitStatus = useGitStatus(gitOn ? projectId : null, model.turn?.status === "working", session?.id);
  const ctx: RailSurfaceContext = {
    changeCount: gitStatus ? gitChangedFiles(gitStatus).length : 0,
    eventCount: events.length,
    totalTokens: model.totals.input + model.totals.output,
    hasSession: session !== null,
  };

  useSurfaceVersion(); // re-render when surfaces register/unregister
  const surfaces = visibleSurfaces([...listSurfaces(), ...slotSurfaces()], prefs.plugins, ctx);
  const open = surfaces.find((s) => s.id === rail) ?? null;

  // Keep-alive: panels stay mounted once visited so their state survives
  // switching surfaces; unavailable surfaces (plugin off) unmount naturally.
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (rail !== null && !visited.includes(rail)) setVisited((v) => [...v, rail]);
  }, [rail, visited]);
  // A registered surface that became invisible (content gone / plugin off)
  // closes the panel; an id that is merely not registered *yet* (a plugin
  // still loading) is left alone so it opens once the surface arrives.
  const known = rail !== null && [...listSurfaces(), ...slotSurfaces()].some((s) => s.id === rail);
  useEffect(() => {
    if (rail !== null && known && open === null) setRailPlugin(null);
  }, [rail, known, open]);
  const kept = surfaces.filter((s) => s.id === rail || visited.includes(s.id));

  // Per-surface width with a drag handle on the panel's left edge.
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

  const jumps = JUMPS.filter((j) => prefs.plugins.includes(j.plugin));
  const togglable = (Object.keys(PLUGIN_LABELS) as PluginId[]).filter((id) => id !== "session");
  const slotTabs = renderSlot("contextRail.tabs", { tab: rail, onSelect: toggleRailPlugin });
  const badgeOf = (s: RailSurface): number => s.badge?.(ctx) ?? 0;

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
        {jumps.map((j) => (
          <button
            key={j.view}
            className={`rail-icon strip-btn ${view === j.view ? "active" : ""}`}
            title={j.label}
            aria-label={j.label}
            aria-pressed={view === j.view}
            onClick={() => setActiveView(j.view)}
          >
            <j.icon />
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
