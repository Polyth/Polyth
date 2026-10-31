import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { tr } from "../i18n/index.ts";
import Button from "./ui/Button.tsx";
import Icon from "./ui/Icon.tsx";
import Spinner from "./ui/Spinner.tsx";
import { ChevronDownIcon, UndoIcon } from "./ui/icons.ts";
import "./RewindMarker.css";

/**
 * The cut point of an active rewind. It stays deliberately sparse: one short
 * label, an optional activity spinner, an opt-in peek and Restore. The hidden
 * conversation is never inserted into the visible flow unless requested.
 */
export default function RewindMarker({
  running,
  confirming,
  canPeek,
  onRestore,
  onConfirmRestore,
  onKeepEditing,
  renderRewound,
}: {
  /** The rewound turn is still executing until the replacement interrupts it. */
  running: boolean;
  /** Restore would discard an edited draft and waits for a decision. */
  confirming: boolean;
  /** The hidden rows are loaded and can be previewed in place. */
  canPeek: boolean;
  onRestore: (invoker: HTMLElement) => void;
  onConfirmRestore: (invoker: HTMLElement) => void;
  onKeepEditing: () => void;
  /** Rewound rows, rendered only while the peek is open. */
  renderRewound: () => ReactNode;
}) {
  const [peek, setPeek] = useState<"closed" | "open" | "closing">("closed");
  const peekId = useId();
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (peek !== "closing") return;
    const timer = window.setTimeout(() => setPeek("closed"), 200);
    return () => window.clearTimeout(timer);
  }, [peek]);

  // The inline decision replaces its opener. Keep keyboard focus inside it.
  useEffect(() => {
    if (confirming) keepEditingRef.current?.focus();
  }, [confirming]);

  const open = peek === "open";
  const restoreFromMarker = (invoker: HTMLElement) => {
    setPeek("closed");
    onRestore(invoker);
  };
  const label = (
    <>
      <Icon icon={UndoIcon} size="sm" className="rewind-marker-icon" />
      <span className="rewind-marker-label">{tr("timeline.rewindMarkerLabel")}</span>
      {running && (
        <Spinner size="sm" label={tr("timeline.rewindStillRunning")} />
      )}
    </>
  );

  return (
    <div
      className="rewind-marker"
      role="group"
      aria-label={tr("timeline.rewindMarkerName")}
      data-state={confirming ? "confirming" : "idle"}
      data-peek={peek}
    >
      <div className="rewind-marker-rule">
        {confirming ? (
          <div className="rewind-marker-confirm" role="group" aria-label={tr("timeline.confirmRestore")}>
            <span className="rewind-marker-question">{tr("timeline.discardEditedDraftQuestion")}</span>
            <Button
              size="sm"
              variant="ghost"
              ref={keepEditingRef}
              onClick={onKeepEditing}
            >{tr("timeline.keepEditing")}</Button>
            <Button
              size="sm"
              variant="danger"
              onClick={(event) => onConfirmRestore(event.currentTarget)}
            >{tr("timeline.discardDraftAndRestore")}</Button>
          </div>
        ) : (
          <div className="rewind-marker-controls">
            {canPeek ? (
              <button
                type="button"
                className="rewind-marker-peek"
                aria-expanded={open}
                aria-controls={peekId}
                aria-label={[
                  tr("timeline.rewindMarkerLabel"),
                  ...(running ? [tr("timeline.rewindStillRunning")] : []),
                  open ? tr("timeline.hideRewoundMessages") : tr("timeline.showRewoundMessages"),
                ].join(". ")}
                onClick={() => setPeek(open ? "closing" : "open")}
              >
                {label}
                <Icon icon={ChevronDownIcon} size="sm" className="rewind-marker-chevron" />
              </button>
            ) : <span className="rewind-marker-peek" data-static="">{label}</span>}
            <Button
              size="sm"
              variant="ghost"
              className="rewind-marker-restore"
              aria-label={tr("timeline.restoreOriginalTimeline")}
              data-rewind-restore=""
              onClick={(event) => restoreFromMarker(event.currentTarget)}
            >{tr("common.restore")}</Button>
          </div>
        )}
      </div>
      <div className="rewind-marker-peek-body" id={peekId} hidden={peek === "closed"}>
        <div className="rewind-marker-peek-inner">
          {peek !== "closed" && renderRewound()}
        </div>
      </div>
    </div>
  );
}
