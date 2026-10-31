export interface HandoffSourceRow {
  id: string;
  label: string;
  description: string;
  tokens: number;
  defaultOn?: boolean;
}

export const CUSTOM_NOTE_SOURCE_ID = "note";
export const SELECTED_FILES_SOURCE_ID = "changed-files";

export function dedupeHandoffSources(sources: HandoffSourceRow[]): HandoffSourceRow[] {
  const seen = new Set<string>();
  const rows: HandoffSourceRow[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    rows.push(source);
  }
  return rows;
}

export function visibleHandoffSources(
  sources: HandoffSourceRow[],
  presetSourceIds: string[],
): HandoffSourceRow[] {
  const deduped = dedupeHandoffSources(sources);
  const allowed = new Set(presetSourceIds);
  return deduped.filter((source) => allowed.has(source.id));
}
