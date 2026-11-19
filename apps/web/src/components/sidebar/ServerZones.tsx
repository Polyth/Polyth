// The other Polyth servers this desktop app can open, in the navigator: one
// zone per server with the projects its own page last listed (serverZones.ts).
// A row moves the window to that server; nothing here talks to it.
import { useId, useState } from "react";
import type { DesktopServerInfo, DesktopServerZone } from "../../desktopBridge.ts";
import { tr } from "../../i18n/index.ts";
import { serverZoneActions, useServerZones, zoneRows, ZONE_ROWS_SHOWN } from "../../serverZones.ts";
import ProjectGlyph from "../ProjectGlyph.tsx";
import { ChevronDownIcon, GlobeIcon, Icon, LinkIcon, MonitorIcon, Tooltip } from "../ui/index.ts";
import type { AnchoredSide } from "../ui/useAnchoredPosition.ts";
import "./ServerZones.css";

const kindIcon = (kind: DesktopServerZone["kind"]) =>
  kind === "local" ? MonitorIcon : kind === "link" ? LinkIcon : GlobeIcon;

/** This computer has no name of its own: the page says it in its language. */
export const zoneLabel = (zone: Pick<DesktopServerZone, "kind" | "label">): string =>
  zone.kind === "local" || !zone.label ? tr("desktop.servers.thisComputer") : zone.label;

/** The zones are on show: other servers exist and this page may list them. */
export function useServerZonesShown(): boolean {
  const { view } = useServerZones();
  return view !== null && view.access === "granted" && view.zones.length > 0;
}

/**
 * The heading of the server on screen, above its own projects. Drawn only
 * beside other zones: alone, the list needs no name.
 */
export function OwnServerZoneHeading() {
  const { current } = useServerZones();
  const shown = useServerZonesShown();
  if (!shown) return null;
  const own: DesktopServerInfo = current ?? { kind: "local", label: "" };
  return (
    <div className="server-zone-head server-zone-head--own" role="heading" aria-level={3}>
      <span className="server-zone-title">
        <Icon icon={kindIcon(own.kind)} size="sm" />
        <span className="server-zone-name" dir="auto">{zoneLabel(own)}</span>
      </span>
    </div>
  );
}

function Zone({ zone, opening }: { zone: DesktopServerZone; opening: string | null }) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const name = zoneLabel(zone);
  const { shown, more } = zoneRows(zone.projects, expanded);
  const busy = opening !== null;
  // A server never opened here, or one that has no projects: one quiet row
  // that goes there. A revoked pairing says so instead.
  const hint = !zone.available
    ? tr("desktop.zones.revoked")
    : zone.projects.length === 0
      ? tr(zone.reportedAt === null ? "desktop.zones.unvisited" : "desktop.zones.noProjects")
      : null;
  return (
    <div className="server-zone" data-folded={zone.folded || undefined} data-unavailable={zone.available ? undefined : ""}>
      <div className="server-zone-head" role="heading" aria-level={3}>
        <button
          type="button"
          className="server-zone-title server-zone-toggle"
          aria-expanded={!zone.folded}
          aria-controls={listId}
          onClick={() => serverZoneActions.fold(zone, !zone.folded)}
        >
          <Icon icon={kindIcon(zone.kind)} size="sm" />
          <span className="server-zone-name" dir="auto">{name}</span>
          <Icon icon={ChevronDownIcon} size="sm" className="server-zone-chevron" />
        </button>
      </div>
      {!zone.folded && (
        <ul id={listId} className="server-zone-projects" aria-label={name}>
          {zone.available && shown.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="server-zone-row"
                title={tr("desktop.zones.openProject", { project: project.name, server: name })}
                aria-busy={opening === `${zone.key}/${project.id}` || undefined}
                disabled={busy}
                onClick={() => serverZoneActions.open(zone, project.id)}
              >
                <ProjectGlyph project={project} />
                <span className="server-zone-row-name" dir="auto">{project.name}</span>
              </button>
            </li>
          ))}
          {zone.available && more > 0 && (
            <li>
              <button type="button" className="server-zone-row server-zone-row--quiet" onClick={() => setExpanded(true)}>
                <span className="server-zone-row-name">{tr("desktop.zones.showMore", { count: more })}</span>
              </button>
            </li>
          )}
          {hint && (
            <li>
              <button
                type="button"
                className="server-zone-row server-zone-row--quiet"
                title={tr("desktop.zones.openServer", { name })}
                aria-busy={opening === zone.key || undefined}
                disabled={busy}
                onClick={() => serverZoneActions.open(zone)}
              >
                <span className="server-zone-row-name">{hint}</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Under the project tree: every other server, or the one row that asks. */
export function ServerZonesTree() {
  const { view, opening } = useServerZones();
  if (!view) return null;
  if (view.access === "ask") {
    return (
      <div className="server-zones">
        <button
          type="button"
          className="server-zone-row server-zone-row--quiet server-zone-ask"
          title={tr("desktop.zones.askHint")}
          onClick={() => serverZoneActions.allow()}
        >
          <Icon icon={MonitorIcon} size="sm" />
          <span className="server-zone-row-name">{tr("desktop.zones.ask")}</span>
        </button>
      </div>
    );
  }
  if (view.zones.length === 0) return null;
  return (
    <section className="server-zones" aria-label={tr("desktop.zones.label")}>
      {view.zones.map((zone) => <Zone key={zone.key} zone={zone} opening={opening} />)}
    </section>
  );
}

/** On the project icon rail: a mark per server, then its projects' icons. */
export function ServerZonesRail({ side }: { side: AnchoredSide }) {
  const { view, opening } = useServerZones();
  if (!view || view.access !== "granted" || view.zones.length === 0) return null;
  const busy = opening !== null;
  return (
    <>
      {view.zones.map((zone) => {
        const name = zoneLabel(zone);
        const projects = zone.available && !zone.folded ? zone.projects.slice(0, ZONE_ROWS_SHOWN) : [];
        return (
          <div key={zone.key} className="server-zone-rail" role="group" aria-label={name}>
            <Tooltip side={side} delayMs={120} content={name}>
              <button
                type="button"
                className="server-zone-rail-mark"
                aria-label={tr("desktop.zones.openServer", { name })}
                title=""
                disabled={busy}
                onClick={() => serverZoneActions.open(zone)}
              >
                <Icon icon={kindIcon(zone.kind)} size="sm" />
              </button>
            </Tooltip>
            {projects.map((project) => (
              <Tooltip
                key={project.id}
                side={side}
                delayMs={120}
                className="sidebar-project-rail-tooltip"
                content={(
                  <span className="sidebar-project-rail-tooltip-content">
                    <span className="sidebar-project-rail-tooltip-icon"><ProjectGlyph project={project} /></span>
                    <span className="sidebar-project-rail-tooltip-copy">
                      <strong>{project.name}</strong>
                      <span className="server-zone-rail-tooltip-server" dir="auto">{name}</span>
                    </span>
                  </span>
                )}
              >
                <button
                  type="button"
                  className="sidebar-project-rail-item server-zone-rail-item"
                  aria-label={tr("desktop.zones.openProject", { project: project.name, server: name })}
                  title=""
                  disabled={busy}
                  onClick={() => serverZoneActions.open(zone, project.id)}
                >
                  <ProjectGlyph project={project} />
                </button>
              </Tooltip>
            ))}
          </div>
        );
      })}
    </>
  );
}
