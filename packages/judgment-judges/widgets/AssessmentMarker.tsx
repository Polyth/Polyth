// Quiet timeline marker for one `judgment/assessment` event. The answer is
// evidence; the only button fills the composer. When the person gave the judge
// actions, the marker also says what it did with their access, or why not.
import type { SessionEvent } from "@polyth/contracts";
import { tr } from "@polyth/web/i18n";
import { Badge, Button, EditIcon } from "@polyth/web/ui";
import { ASSESSMENT_EVENT, type AssessmentAction, type AssessmentData } from "../src/types.ts";

const percent = (value: number) => `${Math.round(value * 100)}%`;
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
  const detail = data.kind === "custom" && data.label && data.label !== "yes"
    ? tr("judgesui.markerLabelLikely", { label: data.label, percent: percent(data.probability) })
    : tr("judgesui.markerLikely", { percent: percent(data.probability) });
  const actions = Array.isArray(data.actions) ? data.actions.filter((action) => action && typeof action.kind === "string") : [];
  const failed = actions.some((action) => action.status === "failed");
  return <aside className="judges-marker" data-attention={data.attention || failed ? "true" : undefined} data-event-seq={event.seq}
    aria-label={tr("judgesui.markerAria", { title: data.title })}>
    <span className="judges-marker-body">
      <Badge tone={failed ? "danger" : data.attention ? "warning" : "neutral"} dot>{data.title}</Badge>
      <span className="judges-marker-detail">{detail}</span>
      {data.followUp && insert && <Button size="sm" variant="ghost" iconStart={EditIcon} onClick={() => insert(data.followUp!)}
        aria-label={tr("judgesui.markerPutInComposer", { text: data.followUp })}>{data.kind === "completion-check" ? tr("judgesui.markerVerify") : tr("judgesui.markerDraft")}</Button>}
    </span>
    {actions.length > 0 && <ul className="judges-marker-actions" aria-label={tr("judgesui.markerWhatDid")}>
      {actions.map((action, index) => <li key={index} className="judges-marker-action" data-status={action.status}>{actionText(action)}</li>)}
    </ul>}
  </aside>;
}
