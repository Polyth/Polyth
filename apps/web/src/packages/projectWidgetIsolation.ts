import type { WidgetLayout, WidgetLayoutDefinition } from "../widgets/widgetLayout.ts";

/** Definition/instance ids that already belong to this project's durable
 * layout. They are user state and stay latent even while their package is
 * irrelevant. */
export function persistedProjectWidgetIds(raw: string | null): Set<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  try {
    const parsed = JSON.parse(raw) as { widgets?: Record<string, { definitionId?: unknown }> };
    if (!parsed.widgets || typeof parsed.widgets !== "object" || Array.isArray(parsed.widgets)) return ids;
    for (const [instanceId, placement] of Object.entries(parsed.widgets)) {
      ids.add(instanceId);
      if (typeof placement?.definitionId === "string") ids.add(placement.definitionId);
    }
  } catch {
    // Malformed state has no trustworthy persisted ownership evidence.
  }
  return ids;
}

/** Remove only defaults injected by globally registered packages that are not
 * relevant to the newly active project. Persisted definitions/instances are
 * deliberately retained so changing composition never destroys user layout. */
export function pruneUnpersistedIrrelevantWidgets(
  layout: WidgetLayout,
  relevantDefinitions: readonly Pick<WidgetLayoutDefinition, "id">[],
  persistedIds: ReadonlySet<string>,
): WidgetLayout {
  const relevant = new Set(relevantDefinitions.map((definition) => definition.id));
  const removed = new Set<string>();
  for (const [instanceId, placement] of Object.entries(layout.widgets)) {
    const definitionId = placement.definitionId ?? instanceId;
    if (relevant.has(definitionId) || persistedIds.has(instanceId) || persistedIds.has(definitionId)) continue;
    removed.add(instanceId);
  }
  if (removed.size === 0) return layout;

  const widgets = { ...layout.widgets };
  for (const id of removed) delete widgets[id];
  const zones = Object.fromEntries(
    Object.entries(layout.zones).map(([zone, ids]) => [zone, ids.filter((id) => !removed.has(id))]),
  ) as WidgetLayout["zones"];
  const slotPlacements = Object.fromEntries(
    Object.entries(layout.slotPlacements).map(([slot, ids]) => [
      slot,
      (ids ?? []).filter((id) => !removed.has(id)),
    ]),
  ) as WidgetLayout["slotPlacements"];
  return { ...layout, widgets, zones, slotPlacements };
}
