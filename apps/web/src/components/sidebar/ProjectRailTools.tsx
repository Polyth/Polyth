// The Project rail's own icon area (`sidebar.rail`): launchers and icon
// widgets under the project icons. It is a rail like the top, right and
// header ones (railPlacement.ts zone `sidebar`): items reorder by drag or
// Alt+↑/↓, arrive from and leave for the other rails, are pulled off by
// dragging them away, and are added or removed from the rail's Customize
// pencil, whose editor edits this same area.
import { tr } from "../../i18n/index.ts";
import { CAPABILITY_MIME } from "../../dnd.ts";
import {
  commitRailZoneOrder,
  railItemRemovable,
  railWidgetFits,
  removeRailItem,
  sidebarRailAcceptsCapability,
  SIDEBAR_RAIL_SLOT,
} from "../../railPlacement.ts";
import { useRailDragZone } from "../../railDrag.ts";
import { RailWidgetItemView, useRailWidgetItems } from "../RailZoneWidgets.tsx";

export function ProjectRailTools({ projectId, sessionId }: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const items = useRailWidgetItems([SIDEBAR_RAIL_SLOT], { projectId, sessionId });
  const byId = new Map(items.map((item) => [item.id, item]));
  const movable = (id: string) => byId.get(id)?.draggable ?? true;
  const drag = useRailDragZone({
    id: "sidebar",
    axis: "y",
    ids: items.map((item) => item.id),
    isDraggable: movable,
    externalMime: CAPABILITY_MIME,
    accepts: (id) => railWidgetFits("sidebar", id) || sidebarRailAcceptsCapability(id),
    commit: (order) => commitRailZoneOrder("sidebar", order.filter(movable)),
    remove: (id) => removeRailItem("sidebar", id),
    canRemove: railItemRemovable,
  });
  // An empty area still mounts (it is the landing place of the first icon);
  // it only takes room while it holds something or an icon could land here.
  const empty = items.length === 0;
  return (
    <div
      ref={drag.ref}
      {...drag.dropProps}
      className="sidebar-project-rail-tools"
      data-empty={empty || undefined}
      data-receiving={drag.receiving || undefined}
      data-rail-drop-target={drag.targeted || undefined}
      aria-label={tr("sidebar.projectRail")}
    >
      {drag.order.map((entry) => {
        if (entry === null) return <span key={drag.slotKey} className="sidebar-project-rail-slot rail-drag-slot" data-rail-slot aria-hidden="true" />;
        const item = byId.get(entry);
        return item ? <RailWidgetItemView key={entry} item={item} drag={drag} /> : null;
      })}
    </div>
  );
}
