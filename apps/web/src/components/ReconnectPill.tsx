import { useEffect, useState } from "react";
import { getSyncStatus, reconnectSync, subscribeSyncStatus } from "../init.ts";
import { createReconnectPillState } from "../reconnectPillState.ts";
import { registerSlot } from "../slots.ts";
import { tr } from "../i18n/index.ts";

export function ReconnectPill() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const state = createReconnectPillState(setVisible);
    const update = () => state.update(getSyncStatus());
    update();
    const unsubscribe = subscribeSyncStatus(update);
    return () => {
      unsubscribe();
      state.dispose();
    };
  }, []);

  if (!visible) return null;
  return (
    <div className="reconnect-pill" role="status">
      <span className="reconnect-pill-dot" aria-hidden="true" />
      <span>{tr("header.reconnecting")}</span>
      <button type="button" onClick={reconnectSync}>{tr("sidebar.reconnect")}</button>
    </div>
  );
}

let installed = false;

export function installReconnectPill(): void {
  if (installed) return;
  installed = true;
  registerSlot("app.header.actions", "shell.reconnect-status", () => <ReconnectPill />, -100);
}
