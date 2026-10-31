// The navigator row: tinted glyphs beside the title, and the marker toggles in
// the row's menu and in the selection bar's menu.
import { useState } from "react";
import { Icon } from "../../../apps/web/src/components/ui/index.ts";
import { CheckIcon, CloseIcon, PlusIcon } from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { MarkerDefinition } from "../src/markers.ts";
import { changeMarkers, useDefinitions, useMarkerState, useSessionMarkers } from "./client.ts";
import { openMarkerDialog } from "./MarkerDialog.tsx";
import { definedMarkers, MARKER_ICON_GLYPHS, MarkerChip, MarkerGlyph, markerLabel } from "./visuals.tsx";

/** Glyphs the row shows before "+n". Rows are dense; the menu has the rest. */
const ROW_GLYPHS = 2;

export function SessionMarkerBadges({ sessionId }: { sessionId: string }) {
  const markers = useSessionMarkers(sessionId);
  const definitions = useDefinitions();
  const shown = definedMarkers(markers, definitions);
  if (shown.length === 0) return null;
  const labels = shown.map(({ definition, marker }) => marker.note
    ? tr("sessionmarkers.badge.note", { label: markerLabel(definition), note: marker.note })
    : markerLabel(definition));
  const label = tr("sessionmarkers.badge.label", { labels: labels.join(", ") });
  const extra = shown.length - ROW_GLYPHS;
  return (
    <span className="session-markers-badges" role="img" aria-label={label} title={labels.join("\n")}>
      {shown.slice(0, ROW_GLYPHS).map(({ definition }) => <MarkerGlyph key={definition.id} definition={definition} />)}
      {extra > 0 && <span className="session-markers-badges__more">{tr("sessionmarkers.badge.more", { count: extra })}</span>}
    </span>
  );
}

export function SessionMarkerHeader({ sessionId }: { sessionId: string }) {
  const markers = useSessionMarkers(sessionId);
  const definitions = useDefinitions();
  const shown = definedMarkers(markers, definitions);
  if (shown.length === 0) return null;
  return (
    <span className="session-markers-header">
      {shown.map(({ definition, marker }) => (
        <MarkerChip key={definition.id} definition={definition} {...(marker.note ? { note: marker.note } : {})} />
      ))}
    </span>
  );
}

function MenuItem({ label, checked, glyph, icon, disabled, onSelect }: {
  label: string;
  checked?: boolean;
  glyph?: MarkerDefinition;
  icon?: typeof CheckIcon;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const checkable = checked !== undefined;
  return (
    <button
      type="button"
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checkable ? checked : undefined}
      className={`ui-menu-item session-markers-menu-item${checked ? " ui-menu-item--checked" : ""}`}
      {...(glyph ? { "data-color": glyph.color } : {})}
      disabled={disabled}
      onClick={onSelect}
    >
      {/* A bare leading icon, so the menu's shared label column holds. */}
      {glyph
        ? <Icon icon={MARKER_ICON_GLYPHS[glyph.icon]} size="sm" className="session-markers-menu-item__glyph" />
        : icon ? <Icon icon={icon} size="sm" /> : null}
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{label}</span></span>
      {/* The host's actions above have no check column; the state trails so
          marker names line up with theirs. */}
      {checked && <span className="session-markers-menu-item__check" aria-hidden="true"><Icon icon={CheckIcon} size="sm" /></span>}
    </button>
  );
}

function useApply(host: WebPackageHost, after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (change: Parameters<typeof changeMarkers>[0]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await changeMarkers(change);
      after?.();
    } catch (cause) {
      setError(host.errors.friendly(tr("sessionmarkers.error.update"), cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function SessionMarkerMenu({ host, sessionId, closeMenu }: {
  host: WebPackageHost;
  sessionId: string;
  closeMenu?: () => void;
}) {
  const definitions = useDefinitions();
  const markers = useSessionMarkers(sessionId);
  const { busy, error, run } = useApply(host, closeMenu);
  const has = (id: string) => markers.some((marker) => marker.id === id);
  return (
    <div className="session-markers-menu" role="group" aria-label={tr("sessionmarkers.menu.heading")}>
      <div className="ui-separator ui-separator--horizontal" role="separator" />
      <div className="ui-menu-heading" aria-hidden="true">{tr("sessionmarkers.menu.heading")}</div>
      {definitions.map((definition) => (
        <MenuItem
          key={definition.id}
          label={markerLabel(definition)}
          glyph={definition}
          checked={has(definition.id)}
          disabled={busy}
          onSelect={() => void run(has(definition.id)
            ? { sessionIds: [sessionId], remove: [definition.id] }
            : { sessionIds: [sessionId], add: [{ marker: definition.id }] })}
        />
      ))}
      <MenuItem
        label={tr("sessionmarkers.menu.custom")}
        icon={PlusIcon}
        disabled={busy}
        onSelect={() => { closeMenu?.(); openMarkerDialog({ kind: "apply", sessionIds: [sessionId] }); }}
      />
      {markers.length > 0 && (
        <MenuItem
          label={tr("sessionmarkers.menu.clear")}
          icon={CloseIcon}
          disabled={busy}
          onSelect={() => void run({ sessionIds: [sessionId], clear: true })}
        />
      )}
      {error && <p className="session-markers-menu__error" role="alert">{error}</p>}
    </div>
  );
}

export function BulkMarkerMenu({ host, sessionIds, closeMenu, done }: {
  host: WebPackageHost;
  sessionIds: readonly string[];
  closeMenu?: () => void;
  done?: () => void;
}) {
  const definitions = useDefinitions();
  const { bySession } = useMarkerState();
  const { busy, error, run } = useApply(host, () => { closeMenu?.(); done?.(); });
  const everyHas = (id: string) => sessionIds.every((sessionId) => bySession.get(sessionId)?.some((marker) => marker.id === id));
  const anyMarked = sessionIds.some((sessionId) => (bySession.get(sessionId)?.length ?? 0) > 0);
  return (
    <div className="session-markers-menu" role="group" aria-label={tr("sessionmarkers.menu.heading")}>
      <div className="ui-separator ui-separator--horizontal" role="separator" />
      <div className="ui-menu-heading" aria-hidden="true">{tr("sessionmarkers.menu.heading")}</div>
      {definitions.map((definition) => {
        const all = everyHas(definition.id);
        const label = markerLabel(definition);
        return (
          <MenuItem
            key={definition.id}
            label={all ? tr("sessionmarkers.bulk.remove", { label }) : tr("sessionmarkers.bulk.add", { label })}
            glyph={definition}
            checked={all}
            disabled={busy}
            onSelect={() => void run(all
              ? { sessionIds, remove: [definition.id] }
              : { sessionIds, add: [{ marker: definition.id }] })}
          />
        );
      })}
      <MenuItem
        label={tr("sessionmarkers.menu.custom")}
        icon={PlusIcon}
        disabled={busy}
        onSelect={() => { closeMenu?.(); openMarkerDialog({ kind: "apply", sessionIds }); }}
      />
      {anyMarked && (
        <MenuItem
          label={tr("sessionmarkers.menu.clear")}
          icon={CloseIcon}
          disabled={busy}
          onSelect={() => void run({ sessionIds, clear: true })}
        />
      )}
      {error && <p className="session-markers-menu__error" role="alert">{error}</p>}
    </div>
  );
}
