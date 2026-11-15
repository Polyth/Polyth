// The hold that turns Send into "keep as a draft": its length, and a specimen
// that behaves like the real button. A duration is hard to judge as a number —
// 500 ms and 1200 ms are one sentence apart — so the specimen runs the chosen
// hold through the composer's own press (composer/sendHoldPress.ts) and ring,
// with nothing sent from here: the ring winds, the check appears once the hold
// is reached, and letting go keeps it for a beat. The slider is the control;
// the specimen is marked decorative for assistive tech, which already hears
// the value from the track's `aria-valuetext`.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { tr } from "../../i18n/index.ts";
import { SEND_HOLD_MAX_MS, SEND_HOLD_MIN_MS, SEND_HOLD_STEP_MS } from "../../sendHold.ts";
import { createSendHoldPress } from "../../composer/sendHoldPress.ts";
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
  const clearKept = () => {
    if (keptTimer.current !== null) clearTimeout(keptTimer.current);
    keptTimer.current = null;
  };
  const press = useMemo(() => createSendHoldPress({ onFull: () => { clearKept(); setKept(true); } }), []);
  useEffect(() => () => {
    press.dispose();
    clearKept();
  }, [press]);

  const begin = (event: PointerEvent<HTMLSpanElement>) => {
    clearKept();
    setKept(false);
    press.arm(event.currentTarget, event.timeStamp, ms);
  };
  // A completed hold keeps its check for a beat; a shorter one simply stops.
  const end = (outcome: "send" | "draft" | null) => {
    if (outcome === null) return;
    clearKept();
    if (outcome !== "draft") {
      setKept(false);
      return;
    }
    setKept(true);
    keptTimer.current = setTimeout(() => {
      keptTimer.current = null;
      setKept(false);
    }, SPECIMEN_KEPT_MS);
  };

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
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            begin(event);
          }}
          onPointerUp={(event) => end(press.release(event.timeStamp))}
          onPointerLeave={(event) => { if (press.armed) end(press.abandon(event.timeStamp) ?? "send"); }}
          onPointerCancel={(event) => { if (press.armed) end(press.abandon(event.timeStamp) ?? "send"); }}
        >
          {kept ? <Icon icon={CheckIcon} size="sm" /> : <Icon icon={SendIcon} size="sm" />}
          <span className="send-hold-ring" />
        </span>
        <span className="chat-hold-caption">{tr("settings.chatPage.sendHoldTry")}</span>
      </span>
    </div>
  );
}
