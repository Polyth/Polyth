import { useEffect, useState } from "react";
import { resolveAlert, useAlert } from "../alerts.ts";
import Dialog from "./a11y/Dialog.tsx";

/** Single, themed replacement for native confirm and prompt dialogs. */
export default function AlertDialog() {
  const alert = useAlert();
  const [value, setValue] = useState("");
  useEffect(() => { setValue(alert?.kind === "prompt" ? alert.initialValue ?? "" : ""); }, [alert]);
  if (!alert) return null;
  const close = () => resolveAlert(alert.kind === "confirm" ? false : null);
  return (
    <Dialog title={alert.title} onClose={close} className="alert-dialog" initialFocus={alert.kind === "prompt" ? "input" : "button.alert-confirm"}>
      <div className="alert-dialog-body">
        <p>{alert.message}</p>
        {alert.kind === "prompt" && (
          <input
            autoFocus
            value={value}
            placeholder={alert.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") resolveAlert(value); }}
          />
        )}
      </div>
      <div className="dialog-foot alert-dialog-actions">
        <button type="button" className="small-btn" onClick={close}>Cancel</button>
        <button
          type="button"
          className={`primary-btn alert-confirm${alert.kind === "confirm" && alert.destructive ? " danger-btn" : ""}`}
          onClick={() => resolveAlert(alert.kind === "confirm" ? true : value)}
        >{alert.confirmLabel}</button>
      </div>
    </Dialog>
  );
}
