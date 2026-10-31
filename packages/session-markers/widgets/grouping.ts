// "By marker" in the session lists' Group by menu. A chat with several markers
// sits under the first one in the marker list's order (one row per chat);
// unmarked chats come last.
import type { SessionGroupingDefinition } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { getDefinitions, getSessionMarkers, subscribeMarkers } from "./client.ts";
import { markerLabel } from "./visuals.tsx";

export const MARKER_GROUPING_ID = "session-markers.marker";
const UNMARKED = "";

export function markerGrouping(): SessionGroupingDefinition {
  return {
    id: MARKER_GROUPING_ID,
    label: tr("sessionmarkers.grouping.label"),
    keyOf: (session) => {
      const marked = new Set(getSessionMarkers(session.id).map((marker) => marker.id));
      return getDefinitions().find((definition) => marked.has(definition.id))?.id ?? UNMARKED;
    },
    labelOf: (key) => {
      if (key === UNMARKED) return tr("sessionmarkers.grouping.unmarked");
      const definition = getDefinitions().find((candidate) => candidate.id === key);
      return definition ? markerLabel(definition) : key;
    },
    rankOf: (key) => {
      const definitions = getDefinitions();
      const index = definitions.findIndex((definition) => definition.id === key);
      return index < 0 ? definitions.length : index;
    },
    subscribe: subscribeMarkers,
  };
}
