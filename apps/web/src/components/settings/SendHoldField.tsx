// The hold that turns Send into "keep as a draft": its length, and a specimen
// that behaves like the real button. A duration is hard to judge as a number —
// 500 ms and 1200 ms are one sentence apart — so the specimen runs the chosen
// hold in the real ring, with nothing sent from here. The slider is the
// control; the specimen is marked decorative for assistive tech, which already
// hears the value from the track's `aria-valuetext`.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { tr } from "../../i18n/index.ts";
import { SEND_HOLD_MAX_MS, SEND_HOLD_MIN_MS, SEND_HOLD_STEP_MS } from "../../sendHold.ts";
import { CheckIcon, SendIcon } from "../ui/icons.ts";
import { Icon } from "../ui/index.ts";
import { SizeStepper } from "./parts.tsx";

/** How long the kept check stays after a completed specimen hold. */
const SPECIMEN_KEPT_MS = 900;

export default function SendHoldField({ ms, onChange }: {
  ms: number;
  onChange: (ms: number) => void;
}) {
  const [state, setState] = useState<"idle" | "holding" | "kept">("idle");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(() => () => {
    clear();
    if (keptTimer.current !== null) clearTimeout(keptTimer.current);
  }, []);

  const begin = () => {
    if (keptTimer.current !== null) clearTimeout(keptTimer.current);
    keptTimer.current = null;
    clear();
    setState("holding");
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      setState("kept");
      keptTimer.current = setTimeout(() => {
        keptTimer.current = null;
        setState("idle");
      }, SPECIMEN_KEPT_MS);
    }, ms);
  };
  const release = () => {
    clear();
    // A completed hold keeps its check; an interrupted one simply stops.
    setState((current) => current === "kept" ? current : "idle");
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
          data-state={state}
          style={{ "--send-hold-ms": `${ms}ms` } as CSSProperties}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            begin();
          }}
          onPointerUp={release}
          onPointerLeave={release}
          onPointerCancel={release}
        >
          {state === "kept" ? <Icon icon={CheckIcon} size="sm" /> : <Icon icon={SendIcon} size="sm" />}
          <span className="chat-hold-ring">
            <svg viewBox="0 0 48 48">
              <circle cx="24" cy="24" r="22.5" pathLength="100" />
            </svg>
          </span>
        </span>
        <span className="chat-hold-caption">{tr("settings.chatPage.sendHoldTry")}</span>
      </span>
    </div>
  );
}
