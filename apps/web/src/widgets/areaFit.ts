// Widget-areas (WA2): shared helpers that turn the soft `canPlaceWidget` fit
// grade into ordered buckets, <Select> option groups, and labels/tones the
// Widget Library, the Widgets settings page, and the canvas placement picker
// all render. Placement is never filtered by fit — "other" widgets are still
// listed, just last and flagged.
import type { UiSlot } from "@polyth/contracts";
import { getArea } from "./areas.ts";
import { allPlacementAreas, canPlaceWidget, type WidgetFit } from "./widgetLayout.ts";
import type { WidgetDef } from "./catalog.ts";
import type { SelectOption } from "../components/ui/index.ts";
import { tr } from "../i18n/index.ts";

export interface AreaWidgetBuckets {
  recommended: WidgetDef[];
  supported: WidgetDef[];
  other: WidgetDef[];
}

export interface AreaWidgetEntry {
  widget: WidgetDef;
  fit: WidgetFit;
  note?: string;
}

export function widgetFitInArea(widget: Pick<WidgetDef, "id" | "supportedSlots" | "recommended" | "minSize" | "defaultSize" | "title">, areaId: UiSlot): WidgetFit {
  return canPlaceWidget(widget, areaId).fit;
}

/** Group a widget list by how well each one suits `areaId`. Order within each
 * bucket is preserved from the input. */
const FIT_BUCKET: Record<WidgetFit, keyof AreaWidgetBuckets> = {
  recommended: "recommended",
  supported: "supported",
  unusual: "other",
};

export function bucketWidgetsForArea(
  widgets: readonly WidgetDef[],
  areaId: UiSlot,
): AreaWidgetBuckets {
  const buckets: AreaWidgetBuckets = { recommended: [], supported: [], other: [] };
  for (const widget of widgets) buckets[FIT_BUCKET[widgetFitInArea(widget, areaId)]].push(widget);
  return buckets;
}

/** Flat list for `areaId`: recommended first, then supported, then the rest —
 * every entry carrying its fit grade and any placement note. */
export function areaWidgetEntries(
  widgets: readonly WidgetDef[],
  areaId: UiSlot,
): AreaWidgetEntry[] {
  const order: Record<WidgetFit, number> = { recommended: 0, supported: 1, unusual: 2 };
  return widgets
    .map((widget): AreaWidgetEntry => {
      const check = canPlaceWidget(widget, areaId);
      return { widget, fit: check.fit, ...(check.note ? { note: check.note } : {}) };
    })
    .sort((a, b) =>
      order[a.fit] - order[b.fit]
      || a.widget.title.localeCompare(b.widget.title)
      || a.widget.id.localeCompare(b.widget.id));
}

export function fitGroupLabel(fit: WidgetFit): string {
  return fit === "recommended"
    ? tr("widgets.areafit.recommended")
    : fit === "supported"
      ? tr("widgets.areafit.supported")
      : tr("widgets.areafit.other");
}

/** Short chip text describing a widget's fit for the focused area. */
export function fitBadgeLabel(fit: WidgetFit): string {
  return fit === "recommended"
    ? tr("widgets.areafit.recommendedHere")
    : fit === "supported"
      ? tr("widgets.areafit.fitsHere")
      : tr("widgets.areafit.unusualHere");
}

export function fitTone(fit: WidgetFit): "success" | "info" | "warning" {
  return fit === "recommended" ? "success" : fit === "supported" ? "info" : "warning";
}

/** Human label for an area/slot id, preferring the registered area's label. */
export function areaLabel(id: UiSlot): string {
  return getArea(id)?.label
    ?? id.split(".").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" · ");
}

/** Every placement area as grouped <Select> options for one widget, ordered
 * Recommended → Supported → Other, alphabetical within each group. */
export function areaPlacementOptions(
  widget: Pick<WidgetDef, "id" | "supportedSlots" | "recommended" | "minSize" | "defaultSize" | "title">,
): SelectOption[] {
  const rank: Record<WidgetFit, number> = { recommended: 0, supported: 1, unusual: 2 };
  return allPlacementAreas()
    .map((id) => ({ id, fit: widgetFitInArea(widget, id), label: areaLabel(id) }))
    .sort((a, b) => rank[a.fit] - rank[b.fit] || a.label.localeCompare(b.label))
    .map(({ id, fit, label }) => ({ value: id, label, group: fitGroupLabel(fit) }));
}
