import type { WidgetDef } from "../widgets/catalog.ts";
import { widgetIconFor } from "../railIcons.ts";

export default function WidgetGlyph({ widget }: { widget: Pick<WidgetDef, "id" | "pluginId" | "capabilities"> }) {
  const Glyph = widgetIconFor(widget);
  return <span className="widget-choice-glyph" aria-hidden="true"><Glyph /></span>;
}
