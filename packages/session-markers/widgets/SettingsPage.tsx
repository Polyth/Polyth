import { useEffect, useState } from "react";
import { Button, IconButton, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { DeleteIcon, EditIcon, PlusIcon } from "../../../apps/web/src/components/ui/icons.ts";
import { ErrorState, ItemList, ItemRow, PageHead, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { MarkerDefinition } from "../src/markers.ts";
import { deleteMarker, refreshMarkers, useDefinitions, useMarkerState } from "./client.ts";
import { openMarkerDialog } from "./MarkerDialog.tsx";
import { MarkerGlyph, markerDescription, markerLabel } from "./visuals.tsx";

export default function SessionMarkersSettingsPage({ host }: { host: WebPackageHost }) {
  const { snapshot, error } = useMarkerState();
  const definitions = useDefinitions();
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => { void refreshMarkers(); }, []);

  const uses = (id: string) => snapshot?.sessions.filter((session) => session.markers.some((marker) => marker.id === id)).length ?? 0;
  const meta = (id: string) => {
    const count = uses(id);
    return count > 0 ? tr("sessionmarkers.settings.inUse", { count }) : undefined;
  };
  const remove = async (marker: MarkerDefinition) => {
    const label = markerLabel(marker);
    if (!await confirmAlert(tr("sessionmarkers.settings.deleteConfirm", { label }), {
      title: tr("sessionmarkers.settings.delete"),
      confirmLabel: tr("sessionmarkers.settings.delete"),
      destructive: true,
    })) return;
    setActionError(null);
    try {
      await deleteMarker(marker.id);
    } catch (cause) {
      setActionError(host.errors.friendly(tr("sessionmarkers.error.update"), cause));
    }
  };

  const predefined = definitions.filter((marker) => marker.builtIn);
  const custom = definitions.filter((marker) => !marker.builtIn);
  return (
    <div className="session-markers-settings">
      <PageHead title={tr("sessionmarkers.settings.title")} blurb={tr("sessionmarkers.settings.description")} />
      {error && !snapshot ? <ErrorState title={tr("sessionmarkers.error.load")} error={error} onRetry={() => void refreshMarkers()} /> : null}
      <Section title={tr("sessionmarkers.settings.predefined")} itemId="session-markers.predefined">
        <ItemList>
          {predefined.map((marker) => {
            const count = meta(marker.id);
            const description = markerDescription(marker);
            return (
              <ItemRow
                key={marker.id}
                icon={<MarkerGlyph definition={marker} size="md" />}
                title={markerLabel(marker)}
                {...(count ? { meta: count } : {})}
                {...(description ? { description } : {})}
              />
            );
          })}
        </ItemList>
      </Section>
      <Section
        title={tr("sessionmarkers.settings.custom")}
        itemId="session-markers.custom"
        action={(
          <Button size="sm" variant="quiet" iconStart={PlusIcon} onClick={() => openMarkerDialog({ kind: "create" })}>
            {tr("sessionmarkers.settings.new")}
          </Button>
        )}
      >
        {custom.length === 0
          ? <p className="session-markers-settings__empty">{tr("sessionmarkers.settings.customEmpty")}</p>
          : (
            <ItemList>
              {custom.map((marker) => {
                const count = meta(marker.id);
                return (
                  <ItemRow
                    key={marker.id}
                    icon={<MarkerGlyph definition={marker} size="md" />}
                    title={marker.label}
                    {...(count ? { meta: count } : {})}
                    trailing={(
                      <>
                        <IconButton icon={EditIcon} label={tr("sessionmarkers.settings.edit")} size="sm" onClick={() => openMarkerDialog({ kind: "edit", id: marker.id })} />
                        <IconButton icon={DeleteIcon} label={tr("sessionmarkers.settings.delete")} size="sm" onClick={() => void remove(marker)} />
                      </>
                    )}
                  />
                );
              })}
            </ItemList>
          )}
        {actionError && <p className="session-markers-settings__error" role="alert">{actionError}</p>}
      </Section>
      <Section title={tr("sessionmarkers.settings.agents")} itemId="session-markers.agents">
        <p className="session-markers-settings__hint">{tr("sessionmarkers.settings.agentsDescription")}</p>
      </Section>
    </div>
  );
}

