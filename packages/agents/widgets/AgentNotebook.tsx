import { useEffect, useState } from "react";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Icon, Notice, Textarea, ThumbsDownIcon, ThumbsUpIcon } from "../../../apps/web/src/components/ui/index.ts";
import { NOTEBOOK_LIMIT } from "../src/agentReport.ts";
import { formatWake } from "./agentTime.ts";

/** What the agent remembers between conversations: its own "Remember:" notes
 *  and anything the person writes. Every new session starts with it. */
export default function AgentNotebook({ task, onSave }: {
  task: ScheduleTaskDto;
  onSave: (text: string) => Promise<void>;
}) {
  const saved = task.notebook ?? "";
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const dirty = text !== saved;
  // A note the agent adds while the person is not editing shows at once.
  useEffect(() => {
    if (!dirty) setText(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const name = task.title?.trim() || tr("agents.untitled");
  const updated = task.notebookUpdatedAt
    ? task.notebookEditedBy === "user"
      ? tr("agents.notebookEditedByUserValue", { when: formatWake(task.notebookUpdatedAt) })
      : tr("agents.notebookEditedByAgentValue", { when: formatWake(task.notebookUpdatedAt) })
    : "";
  const save = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await onSave(text);
      setNote(tr("agents.notebookSaved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const feedback = (task.history ?? []).filter((run) => run.feedback);
  return (
    <div className="agent-memory">
      <p className="agent-memory-hint">
        {tr("agents.notebookHint")}
        {updated && <span className="agent-memory-updated">{updated}</span>}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <Textarea
        className="agent-memory-text"
        aria-label={tr("agents.notebookTitleValue", { name })}
        autoGrow
        minRows={6}
        maxRows={30}
        maxLength={NOTEBOOK_LIMIT}
        value={text}
        placeholder={tr("agents.notebookPlaceholder")}
        onChange={(event) => { setText(event.target.value); setNote(""); }}
      />
      <div className="agent-memory-foot">
        <span className="agent-memory-count" role="status">
          {note || `${text.length.toLocaleString(getLocale())} / ${NOTEBOOK_LIMIT.toLocaleString(getLocale())}`}
        </span>
        {dirty && (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setText(saved)}>{tr("agents.discardChanges")}</Button>
            <Button size="sm" variant="primary" busy={busy} disabled={busy} onClick={() => void save()}>{tr("common.save")}</Button>
          </>
        )}
      </div>

      <section className="agents-section agent-memory-feedback" aria-labelledby={`feedback-${task.id}`}>
        <h2 className="agents-section-title" id={`feedback-${task.id}`}>{tr("agents.feedbackHistory")}</h2>
        {feedback.length === 0 ? (
          <p className="agent-memory-hint">{tr("agents.feedbackHistoryEmpty")}</p>
        ) : (
          <ul className="agent-feedback-list">
            {feedback.map((run) => (
              <li key={run.runId} data-verdict={run.feedback!.verdict}>
                <Icon icon={run.feedback!.verdict === "up" ? ThumbsUpIcon : ThumbsDownIcon} size="sm" />
                <span className="agent-feedback-what">
                  <strong>{run.headline ?? run.summary?.split("\n")[0] ?? tr("agents.runOk")}</strong>
                  {run.feedback!.note && <span>“{run.feedback!.note}”</span>}
                </span>
                <span className="agent-feedback-when">
                  {formatWake(run.feedback!.at)} · {run.feedback!.delivered ? tr("agents.feedbackHeard") : tr("agents.feedbackPending")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
