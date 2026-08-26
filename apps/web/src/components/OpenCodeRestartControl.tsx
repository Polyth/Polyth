import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@polyth/session/web-api";
import { refreshOpenCodePending, useOpenCodePending } from "../opencodeRestart.ts";
import { registerSlot } from "../slots.ts";
import { setUiError } from "../store.ts";
import { announce } from "./a11y/live.tsx";
import RestartOverlay from "./RestartOverlay.tsx";

export function OpenCodeRestartControl() {
  const pending = useOpenCodePending();
  const [restarting, setRestarting] = useState(false);

  if (pending.count === 0 && !restarting) return null;
  const details = pending.changes.map((change) => change.label).join(", ");

  const apply = async () => {
    setRestarting(true);
    try {
      const result = await api.opencodeApplyRestart();
      await refreshOpenCodePending();
      announce(`Applied ${result.applied} OpenCode change${result.applied === 1 ? "" : "s"} and restarted the runtime`);
    } catch (error) {
      setUiError(`Couldn’t apply and restart OpenCode: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <div className="opencode-restart-control">
        <button
          type="button"
          className="opencode-restart-button"
          disabled={restarting}
          title={details || "Pending OpenCode configuration"}
          onClick={() => void apply()}
        >
          <span className="opencode-restart-icon" aria-hidden="true">↻</span>
          <span>Apply &amp; restart</span>
          <span className="opencode-restart-count" aria-label={`${pending.count} pending changes`}>{pending.count}</span>
        </button>
      </div>
      {restarting && typeof document !== "undefined"
        ? createPortal(<RestartOverlay />, document.body)
        : null}
    </>
  );
}

export function installOpenCodeRestartControl(): () => void {
  return registerSlot("settings.footer", "opencode.apply-restart", () => <OpenCodeRestartControl />);
}
