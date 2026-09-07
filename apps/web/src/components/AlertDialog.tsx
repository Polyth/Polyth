import { useEffect, useId, useState } from "react";
import { resolveAlert, useAlert } from "../alerts.ts";
import { Button, Dialog, TextInput } from "./ui/index.ts";
import { tr } from "../i18n/index.ts";

/** Single, themed replacement for native confirm and prompt dialogs. */
export default function AlertDialog() {
  const alert = useAlert();
  const descriptionId = useId();
  const [value, setValue] = useState("");
  useEffect(() => { setValue(alert?.kind === "prompt" ? alert.initialValue ?? "" : ""); }, [alert]);
  if (!alert) return null;
  const close = () => resolveAlert(alert.kind === "confirm" ? false : null);
  return (
    <Dialog
      title={alert.title}
      onClose={close}
      size="sm"
      className="alert-dialog"
      initialFocus={alert.kind === "prompt" ? "input" : "button.alert-confirm"}
      ariaDescribedBy={descriptionId}
      footer={(
        <>
          <Button size="sm" onClick={close}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant={alert.kind === "confirm" && alert.destructive ? "danger" : "primary"}
            className="alert-confirm"
            onClick={() => resolveAlert(alert.kind === "confirm" ? true : value)}
          >
            {alert.confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="alert-dialog-body">
        <p id={descriptionId}>{alert.message}</p>
        {alert.kind === "prompt" && (
          <TextInput
            type={alert.secret ? "password" : "text"}
            autoComplete={alert.secret ? "off" : undefined}
            value={value}
            placeholder={alert.placeholder}
            aria-label={alert.message}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") resolveAlert(value); }}
          />
        )}
      </div>
    </Dialog>
  );
}
