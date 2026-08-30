import { useSyncExternalStore } from "react";
import { getSyncStatus, reconnectSync, subscribeSyncStatus } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";

/** System health is a full widget, so it can live in any workspace panel
 * instead of occupying permanent shell chrome. */
const SYSTEM_STATUS_SLOTS = [
  "workspace.header",
  "workspace.left",
  "workspace.main",
  "workspace.right",
  "workspace.bottom",
  "workspace.floating",
] as const;

function SystemStatusWidget() {
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => "disconnected");
  const label = syncStatus === "connected"
    ? tr("sidebar.connected")
    : syncStatus === "connecting"
      ? tr("sidebar.connecting")
      : tr("sidebar.connectionProblem");

  return (
    <div className={`system-status-widget ${syncStatus}`} role="status" aria-live="polite">
      <span className="system-status-widget-dot" aria-hidden="true" />
      <span className="system-status-widget-label">{label}</span>
      {syncStatus !== "connected" && (
        <button type="button" onClick={reconnectSync}>{tr("sidebar.reconnect")}</button>
      )}
    </div>
  );
}

const SYSTEM_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "system",
  name: tr("header.application"),
  widgets: [{
    id: "system.status",
    title: tr("sidebar.serverConnectionDetails"),
    description: tr("sidebar.serverConnectionValue", { syncStatus: tr("sidebar.connected") }),
    defaultSlot: "workspace.right",
    supportedSlots: SYSTEM_STATUS_SLOTS,
    defaultVisible: true,
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    maxSize: { w: 12, h: 4 },
    audience: "simple",
    scope: "global",
    resizable: true,
    render: () => <SystemStatusWidget />,
  }],
});

let installed = false;

export function installSystemWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SYSTEM_WIDGET_PLUGIN);
}
