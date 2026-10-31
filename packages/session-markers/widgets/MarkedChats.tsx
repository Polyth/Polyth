// "Marked chats": every chat with a marker across the Space's projects,
// grouped by marker, so "reply later" is a list rather than a hunt.
import { useState } from "react";
import { EmptyState, Select } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { MarkedSession, MarkerDefinition } from "../src/markers.ts";
import { useDefinitions, useMarkerState } from "./client.ts";
import { MarkerGlyph, markerLabel } from "./visuals.tsx";

const ALL = "";

export function groupMarkedChats(
  sessions: readonly MarkedSession[],
  definitions: readonly MarkerDefinition[],
  filter: string,
): Array<{ definition: MarkerDefinition; sessions: MarkedSession[] }> {
  return definitions
    .filter((definition) => !filter || definition.id === filter)
    .map((definition) => ({
      definition,
      sessions: sessions.filter((session) => session.markers.some((marker) => marker.id === definition.id)),
    }))
    .filter((group) => group.sessions.length > 0);
}

export default function MarkedChats({ host }: { host: WebPackageHost }) {
  const { snapshot } = useMarkerState();
  const definitions = useDefinitions();
  const [filter, setFilter] = useState(ALL);
  const sessions = snapshot?.sessions.filter((session) => !session.archived) ?? [];
  const groups = groupMarkedChats(sessions, definitions, filter);
  const used = definitions.filter((definition) => sessions.some((session) => session.markers.some((marker) => marker.id === definition.id)));
  if (sessions.length === 0) {
    return (
      <div className="session-markers-panel">
        <EmptyState variant="panel" title={tr("sessionmarkers.widget.empty")} description={tr("sessionmarkers.widget.emptyHint")} />
      </div>
    );
  }
  return (
    <div className="session-markers-panel">
      {used.length > 1 && (
        <Select
          className="session-markers-panel__filter"
          label={tr("sessionmarkers.widget.filter")}
          value={filter}
          searchable={false}
          options={[
            { value: ALL, label: tr("sessionmarkers.widget.all") },
            ...used.map((definition) => ({ value: definition.id, label: markerLabel(definition) })),
          ]}
          onChange={setFilter}
        />
      )}
      {groups.map(({ definition, sessions: chats }) => (
        <section key={definition.id} className="session-markers-panel__group" aria-label={markerLabel(definition)}>
          <h3 className="session-markers-panel__heading">
            <MarkerGlyph definition={definition} />
            <span>{markerLabel(definition)}</span>
            <span className="session-markers-panel__count">{chats.length}</span>
          </h3>
          <ul className="session-markers-panel__list">
            {chats.map((session) => {
              const title = session.title || tr("sessionmarkers.untitled");
              const note = session.markers.find((marker) => marker.id === definition.id)?.note;
              return (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className="session-markers-panel__chat"
                    aria-label={tr("sessionmarkers.widget.open", { title })}
                    onClick={() => void host.conversation.openSession(session.sessionId)}
                  >
                    <span className="session-markers-panel__title">{title}</span>
                    {note && <span className="session-markers-panel__note">{note}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
