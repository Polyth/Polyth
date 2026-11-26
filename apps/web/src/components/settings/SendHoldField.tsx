// The hold that turns Send into "keep as a draft": its length, and a specimen
// that behaves like the real button. A duration is hard to judge as a number —
// 500 ms and 1200 ms are one sentence apart — so the specimen runs the chosen
// hold through the composer's own press (composer/sendPress.ts) and ring,
// with nothing sent from here: the ring winds, the check appears once the hold
// is reached, and letting go keeps it for a beat. The slider is the control;
// the specimen is marked decorative for assistive tech, which already hears
// the value from the track's `aria-valuetext`.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { tr } from "../../i18n/index.ts";
import { SEND_HOLD_MAX_MS, SEND_HOLD_MIN_MS, SEND_HOLD_STEP_MS } from "../../sendHold.ts";
import { attachSendPress } from "../../composer/sendPress.ts";
import { CheckIcon, SendIcon } from "../ui/icons.ts";
import { Icon } from "../ui/index.ts";
import { SizeStepper } from "./parts.tsx";

/** How long the kept check stays after a completed specimen hold. */
const SPECIMEN_KEPT_MS = 900;

export default function SendHoldField({ ms, onChange }: {
  ms: number;
  onChange: (ms: number) => void;
}) {
  const [kept, setKept] = useState(false);
  const keptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msRef = useRef(ms);
  msRef.current = ms;
  const clearKept = () => {
    if (keptTimer.current !== null) clearTimeout(keptTimer.current);
    keptTimer.current = null;
  };
  useEffect(() => clearKept, []);
  // The specimen is the composer's Send with nothing behind it: the check
  // appears once the hold is reached and stays for a beat once it is kept; a
  // shorter press simply stops.
  const specimen = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const show = (on: boolean) => {
      clearKept();
      setKept(on);
    };
    return attachSendPress(node, {
      holdMs: () => msRef.current,
      onSend: () => show(false),
      onCue: () => show(true),
      onCueDropped: () => show(false),
      onDraft: () => {
        show(true);
        keptTimer.current = setTimeout(() => {
          keptTimer.current = null;
          setKept(false);
        }, SPECIMEN_KEPT_MS);
      },
    });
  }, []);

  return (
    <div className="chat-hold-field">
      <SizeStepper
        value={ms}
        min={SEND_HOLD_MIN_MS}
        max={SEND_HOLD_MAX_MS}
        step={SEND_HOLD_STEP_MS}
        label={tr("settings.chatPage.sendHoldDuration")}
        unit={tr("settings.chatPage.sendHoldUnit")}
        onChange={onChange}
      />
      <span className="chat-hold-specimen" aria-hidden="true">
        <span
          className="chat-hold-send"
          data-parked={kept || undefined}
          style={{ "--send-hold-ms": `${ms}ms` } as CSSProperties}
          ref={specimen}
        >
          {kept ? <Icon icon={CheckIcon} size="sm" /> : <Icon icon={SendIcon} size="sm" />}
          <span className="send-hold-ring" />
        </span>
        <span className="chat-hold-caption">{tr("settings.chatPage.sendHoldTry")}</span>
      </span>
    </div>
  );
}
