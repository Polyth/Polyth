import { useState } from "react";
import {
  COMPACTION_EARLIER_PERCENT,
  COMPACTION_REMINDER_PERCENT,
  compactionMarkPercent,
  compactionTargetPercent,
  type CompactionPreference,
} from "@polyth/contracts/compaction-policy";
import { api } from "@polyth/session/web-api";
import { chatMemoryOverrideFor, type ChatMemoryState } from "../chatMemory.ts";
import { fmtTokens } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { contextTone, formatContextPercent, type ContextGauge } from "../reduce.ts";
import { contextUsageLabel } from "../sessionMetrics.ts";
import { friendlyError } from "../settings.ts";
import { openSettingsPage, setUiError } from "../store.ts";
import { Button } from "./ui/index.ts";
import "./ChatMemoryCard.css";

const percentText = (value: number): string => `${Math.round(value)}%`;

/** The one sentence that says what happens with the current choice. */
export function chatMemorySentence(preference: CompactionPreference, mark: number | undefined): string {
  if (preference.mode === "manual") return tr("chatmemory.sayManual");
  const target = compactionTargetPercent(preference);
  if (target !== undefined) return tr("chatmemory.sayTarget", { percent: percentText(mark ?? target) });
  return tr("chatmemory.sayAuto");
}

/** Context pie's card: how full the chat's memory is, where it will be
 *  compacted, and the choice of when. Plain words first; the exact figures stay
 *  a quiet line because this is the only place to read them on touch. */
export default function ChatMemoryCard({ sessionId, gauge, state, personDefault, compact }: {
  sessionId: string;
  gauge: ContextGauge;
  state: ChatMemoryState;
  personDefault: CompactionPreference;
  compact?: { pending: boolean; disabled: boolean; run: () => void } | undefined;
}) {
  // The pick shows at once; the projection confirms it through the session feed.
  const [picked, setPicked] = useState<CompactionPreference | null>(null);
  const [manualRefused, setManualRefused] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const preference = picked ?? state.effective;
  const limitTokens = gauge.contextTokens && gauge.contextTokens > 0 ? gauge.contextTokens : undefined;
  const mark = compactionMarkPercent(preference, { limitTokens });
  const percentLabel = formatContextPercent(gauge);
  const usage = contextUsageLabel(gauge, percentLabel, null, tr("common.unavailable"), fmtTokens);
  const fill = gauge.percent === null ? 0 : Math.min(100, Math.max(0, gauge.percent));

  const save = (next: CompactionPreference | null) => {
    setPicked(next ?? personDefault);
    void api.setCompactionPreference(sessionId, next)
      .catch((error: unknown) => setUiError(friendlyError(tr("chatmemory.saveFailed"), error)))
      .finally(() => setPicked(null));
  };
  const choose = (pick: CompactionPreference) => {
    setManualRefused(false);
    if (pick.mode === "manual" && !state.canSwitchOffAutoCompaction) {
      setManualRefused(true);
      return;
    }
    if (pick.mode === preference.mode && pick.percent === preference.percent) return;
    save(chatMemoryOverrideFor(pick, personDefault));
  };

  const options: Array<{ pick: CompactionPreference; label: string; refused?: boolean }> = [
    { pick: { mode: "earlier" }, label: tr("chatmemory.modeEarlier") },
    { pick: { mode: "auto" }, label: tr("chatmemory.modeAuto") },
    ...(preference.mode === "custom"
      ? [{ pick: preference, label: percentText(preference.percent ?? COMPACTION_EARLIER_PERCENT) }]
      : []),
    { pick: { mode: "manual" }, label: tr("chatmemory.modeManual"), refused: !state.canSwitchOffAutoCompaction },
  ];
  const hint = manualRefused || (state.chosen.mode === "manual" && !state.canSwitchOffAutoCompaction)
    ? tr("chatmemory.hintManualUnavailable")
    : preference.mode === "earlier" ? tr("chatmemory.hintEarlier")
    : preference.mode === "custom" ? tr("chatmemory.hintCustom")
    : preference.mode === "manual" ? tr("chatmemory.hintManual", { percent: percentText(COMPACTION_REMINDER_PERCENT) })
    : tr("chatmemory.hintAuto");

  return (
    <div className="chat-memory">
      <div className="chat-memory-head">
        <h3>{tr("chatmemory.title")}</h3>
        {percentLabel && <span className="chat-memory-percent">{percentLabel}</span>}
      </div>
      <div className="chat-memory-track">
        <div
          className={`session-activity-meter level-${contextTone(gauge)}`}
          role="progressbar"
          aria-label={tr("chatmemory.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percentLabel && gauge.percent !== null ? { "aria-valuenow": fill } : { "aria-valuetext": usage })}
        >
          <span style={{ width: `${fill}%` }} />
        </div>
        {mark !== undefined && <i className="chat-memory-mark" style={{ insetInlineStart: `${Math.min(100, mark)}%` }} aria-hidden="true" />}
        {preference.mode === "manual" && <i className="chat-memory-mark" data-reminder="true" style={{ insetInlineStart: `${COMPACTION_REMINDER_PERCENT}%` }} aria-hidden="true" />}
      </div>
      <div className="chat-memory-scale">
        <span>{usage}</span>
        {mark !== undefined && <span>{tr("chatmemory.markAt", { percent: percentText(mark) })}</span>}
        {preference.mode === "manual" && <span>{tr("chatmemory.markReminder", { percent: percentText(COMPACTION_REMINDER_PERCENT) })}</span>}
      </div>
      <p className="chat-memory-say">{chatMemorySentence(preference, mark)}</p>
      <div className="seg chat-memory-modes" role="group" aria-label={tr("chatmemory.modesLabel")} data-count={options.length}>
        {options.map(({ pick, label, refused }) => (
          <Button
            key={pick.mode}
            variant="ghost"
            size="sm"
            className={preference.mode === pick.mode ? "on" : ""}
            aria-pressed={preference.mode === pick.mode}
            {...(refused ? { "aria-disabled": true, "data-refused": "true" } : {})}
            onClick={() => choose(pick)}
          >
            {label}
          </Button>
        ))}
      </div>
      <p className="chat-memory-hint" aria-live="polite">{hint}</p>
      <div className="chat-memory-actions">
        {compact && (
          <Button
            type="button"
            size="sm"
            title={tr("commands.compactDescription")}
            disabled={compact.disabled || compact.pending}
            busy={compact.pending}
            onClick={compact.run}
          >
            {tr("chatmemory.compactNow")}
          </Button>
        )}
        <button type="button" className="chat-memory-link" aria-expanded={howOpen} onClick={() => setHowOpen((open) => !open)}>
          {tr("chatmemory.how")}
        </button>
      </div>
      {howOpen && (
        <ol className="chat-memory-steps">
          <li>{tr("chatmemory.step1")}</li>
          <li>{tr("chatmemory.step2")}</li>
          <li>{tr("chatmemory.step3")}</li>
        </ol>
      )}
      <div className="chat-memory-foot">
        {state.overridden
          ? (
            <>
              <span>{tr("chatmemory.scopeChat")}</span>
              <button type="button" className="chat-memory-link" onClick={() => { setManualRefused(false); save(null); }}>{tr("chatmemory.useDefault")}</button>
            </>
          )
          : (
            <>
              <span>{tr("chatmemory.scopeDefault")}</span>
              <button type="button" className="chat-memory-link" onClick={() => openSettingsPage("sessions", { itemId: "sessions.chatMemory" })}>{tr("chatmemory.allChats")}</button>
            </>
          )}
      </div>
    </div>
  );
}
