// "Group by" and "Sort by" for the session list options menu. Two drill-in rows
// that name the current choice, so the menu grows by one row however many
// groupings packages add. Shared by the sidebar and the phone navigator.
import { tr } from "../../i18n/index.ts";
import {
  SESSION_SORT_MODES,
  sessionSortLabel,
  setGroupingMode,
  setSessionSortMode,
  useGroupings,
  useSessionGrouping,
  useSessionSortMode,
} from "../../sidebarPrefs.ts";
import type { MenuEntry } from "../ui/Menu.tsx";

export function useSessionArrangementEntries(): MenuEntry[] {
  const groupings = useGroupings();
  const grouping = useSessionGrouping();
  const sort = useSessionSortMode();
  return [
    {
      id: "session-group-by",
      label: tr("sidebarprefs.groupBy"),
      value: grouping.label,
      onSelect: () => {},
      entries: groupings.map((candidate) => ({
        id: `session-group-${candidate.id}`,
        label: candidate.label,
        kind: "radio" as const,
        checked: candidate.id === grouping.id,
        onSelect: () => setGroupingMode(candidate.id),
      })),
    },
    {
      id: "session-sort-by",
      label: tr("sidebarprefs.sortBy"),
      value: sessionSortLabel(sort),
      onSelect: () => {},
      entries: SESSION_SORT_MODES.map((mode) => ({
        id: `session-sort-${mode}`,
        label: sessionSortLabel(mode),
        kind: "radio" as const,
        checked: mode === sort,
        onSelect: () => setSessionSortMode(mode),
      })),
    },
  ];
}
