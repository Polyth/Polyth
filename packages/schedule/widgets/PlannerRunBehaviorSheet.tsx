import type { SessionProjection } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  CheckIcon,
  Icon,
  ResponsiveOverlay,
} from "../../../apps/web/src/components/ui/index.ts";

export type TargetMode = "new-session-per-run" | "existing-session" | "dedicated-session";
export type Overlap = "skip" | "queue" | "parallel";

function Choice({
  selected,
  label,
  onSelect,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      className={`planner-choice${selected ? " is-selected" : ""}`}
      aria-selected={selected}
      onClick={onSelect}
    >
      <span className="planner-choice-label">{label}</span>
      {selected && <Icon icon={CheckIcon} size="sm" />}
    </button>
  );
}

export default function PlannerRunBehaviorSheet({
  open,
  onClose,
  targetMode,
  sessionId,
  overlap,
  sessions,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  targetMode: TargetMode;
  sessionId: string;
  overlap: Overlap;
  sessions: readonly SessionProjection[];
  onChange: (patch: { targetMode?: TargetMode; sessionId?: string; overlap?: Overlap }) => void;
}) {
  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title={tr("scheduleview.runGroup")}
      desktop="dialog"
      dialogSize="sm"
      className="planner-sheet-overlay"
      sheetAction={{ label: tr("common.done"), onClick: onClose }}
      dialogFooter={<Button variant="primary" onClick={onClose}>{tr("common.done")}</Button>}
    >
      <div className="planner-sheet">
        <div className="planner-choice-group">
          <div className="planner-choice-heading">{tr("scheduleview.session")}</div>
          <div role="listbox" aria-label={tr("scheduleview.session")}>
            <Choice
              selected={targetMode === "new-session-per-run"}
              label={tr("scheduleview.newSessionPerRun")}
              onSelect={() => onChange({ targetMode: "new-session-per-run", sessionId: "" })}
            />
            <Choice
              selected={targetMode === "dedicated-session"}
              label={tr("scheduleview.reuseSession")}
              onSelect={() => onChange({ targetMode: "dedicated-session", sessionId: "" })}
            />
            <Choice
              selected={targetMode === "existing-session"}
              label={tr("scheduleview.existingSession")}
              onSelect={() => onChange({ targetMode: "existing-session" })}
            />
          </div>
        </div>
        {targetMode === "existing-session" && (
          <div className="planner-choice-group">
            <div className="planner-choice-heading">{tr("scheduleview.existingSession")}</div>
            <div role="listbox" aria-label={tr("scheduleview.existingSession")}>
              <Choice
                selected={sessionId === ""}
                label={tr("scheduleview.pickASession")}
                onSelect={() => onChange({ sessionId: "" })}
              />
              {sessions.map((session) => (
                <Choice
                  key={session.id}
                  selected={sessionId === session.id}
                  label={session.title || session.id}
                  onSelect={() => onChange({ sessionId: session.id })}
                />
              ))}
            </div>
          </div>
        )}
        <div className="planner-choice-group">
          <div className="planner-choice-heading">{tr("scheduleview.whenBusy")}</div>
          <div role="listbox" aria-label={tr("scheduleview.whenBusy")}>
            <Choice
              selected={overlap === "skip"}
              label={tr("scheduleview.skipThisRun")}
              onSelect={() => onChange({ overlap: "skip" })}
            />
            <Choice
              selected={overlap === "queue"}
              label={tr("scheduleview.queueAfter")}
              onSelect={() => onChange({ overlap: "queue" })}
            />
            <Choice
              selected={overlap === "parallel"}
              label={tr("scheduleview.runAnyway")}
              onSelect={() => onChange({ overlap: "parallel" })}
            />
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
