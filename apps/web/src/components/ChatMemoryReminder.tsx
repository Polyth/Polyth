import { compactionContextForHandoff, compactionHandoffDraft } from "@polyth/session/compaction-handoff";
import { chatMemoryReminderDue, type ChatMemoryState } from "../chatMemory.ts";
import { tr } from "../i18n/index.ts";
import { formatContextPercent, type ContextGauge } from "../reduce.ts";
import { getState, startNewSession } from "../store.ts";
import { Button } from "./ui/index.ts";
import ComposerNoticeRow from "./ui/ComposerNoticeRow.tsx";
import "./ChatMemoryCard.css";

/** "Only when I ask" keeps its promise with one quiet row above the composer,
 *  never a toast: compact now, or carry on in a new chat. The same row says so
 *  when the harness has refused a message because the chat is full, in any mode,
 *  and when the model picked for the next message cannot hold the chat: then it
 *  says, before the send, that Polyth will summarize it first (or, for a person
 *  who compacts by hand, that they need to). */
export default function ChatMemoryReminder({ sessionId, projectId, title, gauge, state, idle, full, compact, switching }: {
  sessionId: string;
  projectId: string;
  title: string | undefined;
  gauge: ContextGauge;
  state: ChatMemoryState;
  idle: boolean;
  /** The harness refused the last message because the conversation no longer fits. */
  full: boolean;
  compact: { pending: boolean; run: () => void };
  /** The model picked for the next message has a smaller window than this chat needs. */
  switching?: { model: string; outcome: "compact" | "manual" } | undefined;
}) {
  const open = idle && (full || chatMemoryReminderDue(state, gauge.percent) || (Boolean(switching) && !compact.pending));
  const startNewChat = () => {
    const name = title?.trim() ?? "";
    startNewSession(projectId, {
      ...(name ? { title: tr("harnessruntime.compaction.newChatTitle", { title: name }) } : {}),
      draft: compactionHandoffDraft(compactionContextForHandoff(getState().events[sessionId] ?? []), {
        intro: name
          ? tr("chatmemory.draftIntro", { title: name, sessionId })
          : tr("chatmemory.draftIntroUntitled", { sessionId }),
        summary: tr("harnessruntime.compaction.summaryHeading"),
        pinned: tr("harnessruntime.compaction.pinnedHeading"),
        recent: tr("harnessruntime.compaction.recentHeading"),
        user: tr("harnessruntime.compaction.draftUser"),
        assistant: tr("harnessruntime.compaction.draftAssistant"),
      }),
    });
  };
  return (
    <ComposerNoticeRow open={open}>
      <div className="chat-memory-reminder" role={full ? "alert" : "status"}>
        <span>{full
          ? tr("chatmemory.fullReminder")
          : switching
            ? tr(switching.outcome === "manual" ? "chatmemory.switchManual" : "chatmemory.switchCompact", { model: switching.model })
            : tr("chatmemory.reminder", { percent: formatContextPercent(gauge) ?? "" })}</span>
        {/* Polyth compacts on its own before the send: nothing to decide. */}
        {!full && switching?.outcome === "compact" ? null : <span className="chat-memory-reminder-actions">
          <Button size="sm" variant="primary" disabled={compact.pending} busy={compact.pending} onClick={compact.run}>{tr("chatmemory.compactNow")}</Button>
          <Button size="sm" onClick={startNewChat}>{tr("chatmemory.newChat")}</Button>
        </span>}
      </div>
    </ComposerNoticeRow>
  );
}
