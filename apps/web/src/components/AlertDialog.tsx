import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placeAnchoredAlert, resolveAlert, useAlert, type AlertOrigin } from "../alerts.ts";
import { Button, Dialog, TextInput } from "./ui/index.ts";
import { tr } from "../i18n/index.ts";
import { isImeComposing } from "./input/editorCore.ts";

/** Narrowest inset an anchored card keeps from the band's edges, in px. */
const ANCHORED_MIN_INSET = 12;

/**
 * Pin an anchored confirmation over the control it was asked from. Phone
 * widths present dialogs as bottom sheets; a confirmation with an origin is a
 * card at that spot instead (styles.css "Anchored confirmation"). The card is
 * measured before the first paint, so it never shows anywhere else first; on
 * wider screens the CSS ignores these properties and the dialog stays centred.
 */
function useAnchoredPlacement(origin: AlertOrigin | undefined, bodyRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const panel = bodyRef.current?.closest<HTMLElement>(".dialog-panel");
    const backdrop = panel?.parentElement;
    if (!origin || !panel || !backdrop) return;
    const place = () => {
      const band = backdrop.getBoundingClientRect();
      const padding = getComputedStyle(backdrop);
      const inset = (value: string) => Math.max(ANCHORED_MIN_INSET, Number.parseFloat(value) || 0);
      // offsetWidth/offsetHeight ignore the entrance scale.
      const placement = placeAnchoredAlert({
        origin,
        card: { width: panel.offsetWidth, height: panel.offsetHeight },
        band: { left: band.left, top: band.top, width: band.width, height: band.height },
        insets: {
          top: inset(padding.paddingTop),
          right: inset(padding.paddingRight),
          bottom: inset(padding.paddingBottom),
          left: inset(padding.paddingLeft),
        },
      });
      panel.style.setProperty("--alert-anchor-left", `${Math.round(placement.left)}px`);
      panel.style.setProperty("--alert-anchor-top", `${Math.round(placement.top)}px`);
      panel.style.setProperty("--alert-anchor-origin", `${Math.round(placement.originX)}px ${Math.round(placement.originY)}px`);
    };
    place();
    const viewport = window.visualViewport;
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
    };
  }, [origin, bodyRef]);
}

/** Single, themed replacement for native confirm and prompt dialogs. */
export default function AlertDialog() {
  const alert = useAlert();
  const descriptionId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => { setValue(alert?.kind === "prompt" ? alert.initialValue ?? "" : ""); }, [alert]);
  const origin = alert?.kind === "confirm" ? alert.origin : undefined;
  useAnchoredPlacement(origin, bodyRef);
  if (!alert) return null;
  const close = () => resolveAlert(alert.kind === "confirm" ? false : null);
  return (
    <Dialog
      title={alert.title}
      onClose={close}
      size="sm"
      className={origin ? "alert-dialog is-anchored" : "alert-dialog"}
      {...(origin ? { backdropClassName: "alert-anchored-backdrop" } : {})}
      initialFocus={alert.kind === "prompt" ? "input" : "button.alert-confirm"}
      {...(alert.kind === "confirm" && alert.keepKeyboard ? { keepKeyboard: true } : {})}
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
      <div ref={bodyRef} className="alert-dialog-body">
        <p id={descriptionId}>{alert.message}</p>
        {alert.kind === "prompt" && (
          <TextInput
            type={alert.secret ? "password" : "text"}
            autoComplete={alert.secret ? "off" : undefined}
            value={value}
            placeholder={alert.placeholder}
            aria-label={alert.message}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter") resolveAlert(value); }}
          />
        )}
      </div>
    </Dialog>
  );
}
