import type { WebPackageHost } from "@polyth/web-sdk";
import { currentStage, STAGE_IDS, type StageId, type StudioState } from "../src/index.ts";
import { AlertGlyph, BellGlyph, CheckGlyph, ExportGlyph, PlayGlyph, ReviewGlyph, SparkGlyph } from "./glyphs.tsx";
import { fill, label, type StudioStrings } from "./strings.ts";
import { isDelivered, stageProgress, stagesDone, type AgentState, type Moment } from "./studioModel.ts";

/** "Storyboard · needs your approval" — what the studio is on, in one line. */
export function pipelineLine(t: StudioStrings, state: StudioState): { stage: StageId; title: string; detail: string } {
  if (isDelivered(state)) return { stage: "export", title: label(t, "stage_export"), detail: t.detail_delivered };
  const stage = currentStage(state);
  const status = state.stages[stage].status;
  const title = label(t, `stage_${stage}`);
  if (status === "awaiting-approval" || status === "blocked") return { stage, title, detail: label(t, `status_${status}`) };
  if (status === "pending") return { stage, title, detail: label(t, "status_pending") };
  const progress = stageProgress(state, stage);
  return { stage, title, detail: fill(label(t, `detail_${stage}`), { done: progress.done, total: progress.total }) };
}

export function Pipeline({ t, state, agent, onOpen }: { t: StudioStrings; state: StudioState; agent: AgentState; onOpen(): void }) {
  const line = pipelineLine(t, state);
  return (
    <button type="button" className="cs-pipeline" data-agent={agent} onClick={onOpen} aria-label={`${t.pipelineLabel}: ${line.title}, ${line.detail}. ${fill(t.progressOf, { done: stagesDone(state), total: STAGE_IDS.length })}`}>
      <span className="cs-pipeline-bar" aria-hidden="true">
        {STAGE_IDS.map((stage) => {
          const status = state.stages[stage].status;
          const progress = status === "active" ? stageProgress(state, stage) : null;
          return (
            <span key={stage} className="cs-pipeline-seg" data-status={status} data-current={stage === line.stage || undefined}>
              <span style={progress ? { inlineSize: `${Math.max(8, Math.round((progress.done / Math.max(1, progress.total)) * 100))}%` } : undefined} />
            </span>
          );
        })}
      </span>
      <span className="cs-pipeline-text"><b>{line.title}</b><span>{line.detail}</span></span>
    </button>
  );
}

/** The agent's state as the person reads it: a storyboard waiting for their
 * approval is their turn even though the agent itself is idle. */
export function StatusPill({ t, agent, delivered, yourTurn }: { t: StudioStrings; agent: AgentState; delivered: boolean; yourTurn: boolean }) {
  const shown: AgentState | "done" = agent === "idle" && yourTurn ? "needs-you" : delivered && agent === "idle" ? "done" : agent;
  const key = shown === "done" ? "agent_done" : `agent_${shown}`;
  return (
    <span className="cs-status" data-agent={shown} role="status">
      <span className="cs-status-dot" aria-hidden="true" />
      {label(t, key)}
    </span>
  );
}

export interface MomentActions {
  openConversation(): void;
  approve(): void;
  requestChanges(): void;
  stopRender(): void;
  watch(): void;
  openFinal(): void;
  review(): void;
  askFix(): void;
  continueWork(): void;
}

export function MomentCard({ host, t, moment, busy, actions }: {
  host: WebPackageHost; t: StudioStrings; moment: Moment; busy: string | null; actions: MomentActions;
}) {
  const { Button } = host.ui.components;
  const v = moment.values;
  const content = (() => {
    switch (moment.kind) {
      case "needs-you":
        return { glyph: <BellGlyph />, title: t.moment_needs_title, body: t.moment_needs_body, actions: <Button variant="primary" onClick={actions.openConversation}>{t.openConversation}</Button> };
      case "approve":
        return {
          glyph: <SparkGlyph />, title: t.moment_approve_title, body: fill(t.moment_approve_body, v),
          actions: <>
            <Button variant="primary" busy={busy === "approve"} iconStart={CheckGlyph} onClick={actions.approve}>{t.approve}</Button>
            <Button variant="quiet" onClick={actions.requestChanges}>{t.requestChanges}</Button>
          </>,
        };
      case "rendering":
        return {
          glyph: <ExportGlyph />, title: fill(t.moment_rendering_title, v), body: t.moment_rendering_body,
          progress: Number(v.percent) || 0,
          actions: <Button variant="ghost" size="sm" onClick={actions.stopRender}>{t.stopRender}</Button>,
        };
      case "delivered":
        return {
          glyph: <CheckGlyph />, title: t.moment_delivered_title, body: fill(t.moment_delivered_body, v),
          actions: <>
            <Button variant="primary" iconStart={PlayGlyph} onClick={actions.watch}>{t.watch}</Button>
            <Button variant="quiet" onClick={actions.openFinal}>{t.openFile}</Button>
          </>,
        };
      case "issues":
        return { glyph: <ReviewGlyph />, title: fill(t.moment_issues_title, v), body: t.moment_issues_body, actions: <Button variant="quiet" onClick={actions.review}>{t.review}</Button> };
      case "failed":
        return {
          glyph: <AlertGlyph />, title: t.moment_failed_title, body: String(v.error || t.moment_failed_body),
          actions: <Button variant="quiet" busy={busy === "fix"} onClick={actions.askFix}>{t.askFix}</Button>,
        };
      case "paused":
        return {
          glyph: <SparkGlyph />, title: t.moment_paused_title, body: t.moment_paused_body,
          actions: <Button variant="quiet" busy={busy === "continue"} onClick={actions.continueWork}>{t.continue}</Button>,
        };
    }
  })();
  return (
    <section className="cs-moment" data-kind={moment.kind} aria-live="polite">
      <span className="cs-moment-glyph" aria-hidden="true">{content.glyph}</span>
      <div className="cs-moment-text">
        <strong>{content.title}</strong>
        <p>{content.body}</p>
        {"progress" in content && (
          <span className="cs-progress" aria-hidden="true"><span style={{ inlineSize: `${content.progress}%` }} /></span>
        )}
      </div>
      <div className="cs-moment-actions">{content.actions}</div>
    </section>
  );
}
