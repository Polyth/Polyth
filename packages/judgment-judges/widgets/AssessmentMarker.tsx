// Quiet timeline marker for one `judgment/assessment` event. The answer is
// evidence; the only button fills the composer. When the person gave the judge
// actions, the marker also says what it did with their access, or why not.
import type { CSSProperties } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { tr } from "@polyth/web/i18n";
import { Button, CheckIcon, EditIcon, ErrorIcon, Icon, JudgeIcon, MinusIcon, SendIcon, type LucideIcon } from "@polyth/web/ui";
import { ASSESSMENT_EVENT, type AssessmentAction, type AssessmentData } from "../src/types.ts";

const percent = (value: number) => `${Math.round(value * 100)}%`;
/** Each outcome's mark; the words say the same, the glyph only lets the eye scan. */
const OUTCOME_MARKS: Record<AssessmentAction["status"], LucideIcon> = { done: CheckIcon, sending: SendIcon, skipped: MinusIcon, failed: ErrorIcon };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const ACTION_NAMES: Record<AssessmentAction["kind"], Parameters<typeof tr>[0]> = {
  "send-message": "judgesui.markerAction",
  "merge-isolated": "judgesui.markerMerge",
  "approve-request": "judgesui.markerApproval",
  "deny-request": "judgesui.markerDenial",
  "set-approval": "judgesui.markerAutoApprove",
  "switch-route": "judgesui.markerSwitch",
};

export function readAssessment(event: SessionEvent): AssessmentData | undefined {
  if (event.type !== ASSESSMENT_EVENT) return undefined;
  const data = event.data as Partial<AssessmentData>;
  if (typeof data.title !== "string" || typeof data.probability !== "number" || !Number.isFinite(data.probability)) return undefined;
  return data as AssessmentData;
}

/** One action in the person's words: what happened, or what did not and why. */
export function actionText(action: AssessmentAction): string {
  const detail = typeof action.detail === "string" ? action.detail : "";
  if (action.kind === "send-message" && (action.status === "sending" || action.status === "done")) return tr("judgesui.markerSent", { text: clip(detail, 90) });
  const name = tr(ACTION_NAMES[action.kind] ?? "judgesui.markerActionGeneric");
  if (action.status === "done") return detail || tr("judgesui.markerDone", { name });
  const text = tr(action.status === "failed" ? "judgesui.markerFailed" : "judgesui.markerSkipped", { name });
  return detail ? tr("judgesui.markerWithDetail", { text, detail }) : text;
}

export default function AssessmentMarker({ event, insert }: { event: SessionEvent; insert?: (text: string) => void }) {
  const data = readAssessment(event);
  if (!data) return null;
  // The chance is a second model's opinion about the turn above, so it says "likely", never "verified" or "true".
  // A yes-or-no judge only fires on "yes", so only a choice label adds information.
  const answer = data.kind === "custom" && data.label && data.label !== "yes" ? data.label : "";
  const chance = Math.min(1, Math.max(0, data.probability));
  const actions = Array.isArray(data.actions) ? data.actions.filter((action) => action && typeof action.kind === "string") : [];
  const failed = actions.some((action) => action.status === "failed");
  // The trace of a decision made for the person, as a quiet note: the judge
  // and its answer with the request card's short chance meter on one line,
  // then each thing it did with a mark for its outcome. The glyph repeats
  // attention and failure; the words carry them.
  return <aside className="judges-marker" data-attention={data.attention || failed ? "true" : undefined}
    data-tone={failed ? "danger" : data.attention ? "warning" : undefined} data-event-seq={event.seq}
    aria-label={tr("judgesui.markerAria", { title: data.title })}>
    <span className="judges-marker-mark" aria-hidden="true"><Icon icon={JudgeIcon} size="sm" /></span>
    <span className="judges-marker-head">
      <strong className="judges-marker-title">{data.title}</strong>
      <span className="judges-marker-detail">
        {answer && <span className="judges-marker-answer">{answer}</span>}
        <span className="judges-marker-meter" aria-hidden="true" style={{ "--judges-marker-chance": chance } as CSSProperties} />
        <span className="judges-marker-chance">{tr("judgesui.markerLikely", { percent: percent(data.probability) })}</span>
      </span>
    </span>
    {actions.length > 0 && <ul className="judges-marker-actions" aria-label={tr("judgesui.markerWhatDid")}>
      {actions.map((action, index) => <li key={index} className="judges-marker-action" data-status={action.status}>
        <span className="judges-marker-action-mark" aria-hidden="true"><Icon icon={OUTCOME_MARKS[action.status] ?? MinusIcon} size="sm" /></span>
        <span className="judges-marker-action-text">{actionText(action)}</span>
      </li>)}
    </ul>}
    {data.followUp && insert && <span className="judges-marker-follow">
      <Button size="sm" variant="ghost" iconStart={EditIcon} onClick={() => insert(data.followUp!)}
        aria-label={tr("judgesui.markerPutInComposer", { text: data.followUp })}>{data.kind === "completion-check" ? tr("judgesui.markerVerify") : tr("judgesui.markerDraft")}</Button>
    </span>}
  </aside>;
}
