import { useId } from "react";
import {
  COMPACTION_CUSTOM_MAX_PERCENT,
  COMPACTION_CUSTOM_MIN_PERCENT,
  COMPACTION_CUSTOM_STEP_PERCENT,
  COMPACTION_EARLIER_PERCENT,
  COMPACTION_REMINDER_PERCENT,
  compactionLatestTokens,
  type CompactionMode,
} from "@polyth/contracts/compaction-policy";
import { fmtTokens } from "../../format.ts";
import { tr } from "../../i18n/index.ts";
import { updateSettings, useStore } from "../../store.ts";
import { Badge } from "../ui/index.ts";
import { Section } from "./parts.tsx";
import "./ChatMemorySection.css";

const CUSTOM_DEFAULT_PERCENT = 75;
/** "Automatic" acts near the end (measured on Claude Code), for the small picture only. */
const AUTO_PICTURE_PERCENT = 95;
const RESERVE_EXAMPLES = [
  { tokens: 32_000, label: "chatmemory.exampleLocal" },
  { tokens: 200_000, label: "chatmemory.exampleRegular" },
  { tokens: 1_000_000, label: "chatmemory.exampleLarge" },
] as const;

/** A person's default for when their chats are compacted. Each choice carries a
 *  small picture of where on the bar it acts, so the difference shows before
 *  the description is read. Tokens stay inside "For advanced users". */
export default function ChatMemorySection() {
  const preference = useStore((s) => s.settings.compactionDefault);
  const name = useId();
  const choose = (mode: Exclude<CompactionMode, "custom">) => updateSettings({ compactionDefault: { mode } });
  const custom = preference.mode === "custom" ? preference.percent ?? CUSTOM_DEFAULT_PERCENT : CUSTOM_DEFAULT_PERCENT;
  const options = [
    {
      mode: "earlier" as const,
      label: tr("chatmemory.settingsEarlier"),
      hint: tr("chatmemory.settingsEarlierHint", { percent: `${COMPACTION_EARLIER_PERCENT}%` }),
      mark: COMPACTION_EARLIER_PERCENT,
    },
    {
      mode: "auto" as const,
      label: tr("chatmemory.settingsAuto"),
      hint: tr("chatmemory.settingsAutoHint"),
      mark: AUTO_PICTURE_PERCENT,
      recommended: true,
    },
    {
      mode: "manual" as const,
      label: tr("chatmemory.settingsManual"),
      hint: tr("chatmemory.settingsManualHint", { percent: `${COMPACTION_REMINDER_PERCENT}%` }),
      mark: COMPACTION_REMINDER_PERCENT,
      reminder: true,
    },
  ];
  return (
    <Section title={tr("chatmemory.settingsTitle")} hint={tr("chatmemory.settingsHint")} itemId="sessions.chatMemory">
      <div className="chat-memory-options" role="radiogroup" aria-label={tr("chatmemory.settingsTitle")}>
        {options.map((option) => (
          <label key={option.mode} className="chat-memory-option" data-selected={preference.mode === option.mode ? "true" : undefined}>
            <input
              type="radio"
              name={name}
              checked={preference.mode === option.mode}
              onChange={() => choose(option.mode)}
            />
            <span className="chat-memory-option-copy">
              <span className="chat-memory-option-label">
                {option.label}
                {option.recommended && <Badge tone="accent">{tr("chatmemory.settingsRecommended")}</Badge>}
              </span>
              <span className="chat-memory-option-hint">{option.hint}</span>
            </span>
            <span className="chat-memory-option-picture" aria-hidden="true">
              <i data-reminder={option.reminder ? "true" : undefined} style={{ insetInlineStart: `${option.mark}%` }} />
            </span>
          </label>
        ))}
      </div>
      <p className="chat-memory-note">{tr("chatmemory.settingsScope")}</p>
      <details className="chat-memory-advanced" open={preference.mode === "custom" || undefined}>
        <summary>{tr("chatmemory.settingsAdvanced")}</summary>
        <label className="chat-memory-custom">
          <span>{tr("chatmemory.settingsCustom", { percent: `${custom}%` })}</span>
          <input
            type="range"
            min={COMPACTION_CUSTOM_MIN_PERCENT}
            max={COMPACTION_CUSTOM_MAX_PERCENT}
            step={COMPACTION_CUSTOM_STEP_PERCENT}
            value={custom}
            aria-valuetext={`${custom}%`}
            onChange={(event) => updateSettings({ compactionDefault: { mode: "custom", percent: Number(event.target.value) } })}
          />
        </label>
        <p className="chat-memory-note">{tr("chatmemory.settingsReserve")}</p>
        <dl className="chat-memory-examples">
          {RESERVE_EXAMPLES.map((example) => (
            <div key={example.tokens}>
              <dt>{tr(example.label, { tokens: fmtTokens(example.tokens) })}</dt>
              <dd>{Math.round(((compactionLatestTokens(example.tokens) ?? 0) / example.tokens) * 100)}%</dd>
            </div>
          ))}
        </dl>
      </details>
    </Section>
  );
}
