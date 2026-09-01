import type { UiSlot } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { useWidgetCatalog, type WidgetDef } from "../widgets/catalog.ts";
import {
  applyWidgetLayoutMutations,
  updateWidgetLayout,
  useWidgetLayout,
} from "../widgets/widgetLayout.ts";
import { widgetsForZone } from "../widgets/zoneWidgets.ts";
import { EditIcon, IconButton, Menu, type MenuEntry, type MenuProps } from "./ui/index.ts";

export default function CustomizeZoneButton({
  slot,
  slots = [slot],
  className = "",
  align = "end",
  extraEntries = [],
}: {
  slot: UiSlot;
  slots?: readonly UiSlot[];
  className?: string;
  align?: MenuProps["align"];
  extraEntries?: readonly MenuEntry[];
}) {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const groups = widgetsForZone(widgets, layout, slots);
  const entries: MenuEntry[] = [...extraEntries];
  const addGroup = (heading: string, items: WidgetDef[], checked: boolean) => {
    if (items.length === 0) return;
    if (entries.length > 0) entries.push("separator");
    entries.push({ heading });
    entries.push(...items.map((widget): MenuEntry => ({
      id: `widget:${widget.id}`,
      label: widget.title,
      detail: widget.description,
      kind: "checkbox",
      checked,
      disabled: checked && layout.widgets[widget.id]?.requiredVisible === true,
      onSelect: () => updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current,
        checked
          ? [{ type: "visibility", id: widget.id, visible: false }]
          : [{ type: "visibility", id: widget.id, visible: true }, { type: "place", id: widget.id, slot }],
        widgets,
      )),
    })));
  };
  addGroup(tr("settings.packagespage.enabled"), groups.active, true);
  addGroup(tr("settings.packagespage.disabled"), groups.inactive, false);

  return (
    <Menu label={tr("settingsview.customize")} align={align} entries={entries}>
      {(trigger) => (
        <IconButton
          {...trigger}
          className={`zone-customize-trigger zone-edit-button${className ? ` ${className}` : ""}`}
          icon={EditIcon}
          size="sm"
          variant="ghost"
          label={tr("settingsview.customize")}
        />
      )}
    </Menu>
  );
}
