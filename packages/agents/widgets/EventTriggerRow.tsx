import { useEffect, useState } from "react";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import {
  api,
  type AgentEventSourceDto,
  type AgentEventFilterDto,
  type AgentEventTriggerDto,
  type AgentPaceDto,
  type AgentScriptTestDto,
  type AgentTriggerPreviewDto,
} from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Checkbox,
  CloseIcon,
  DeleteIcon,
  IconButton,
  PlusIcon,
  RefreshIcon,
  Button,
  Select,
  Tabs,
  Textarea,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { EVENT_FIELDS } from "../src/agentEvents.ts";
import { DEFAULT_TRIGGER_PACE, triggerSentence } from "./agentModel.ts";
import { formatWake } from "./agentTime.ts";

const QUIET_CHOICES = [0, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RATE_CHOICES = [1, 3, 6, 12, 30];

function quietLabel(ms: number): string {
  if (ms === 0) return tr("agents.quietNone");
  if (ms < 60 * 60_000) return tr("agents.quietMinutesValue", { count: ms / 60_000 });
  return tr("agents.quietHoursValue", { count: ms / (60 * 60_000) });
}

function dryRunReason(event: NonNullable<AgentTriggerPreviewDto["recent"]>[number]): string {
  if (event.reason === "own") return tr("agents.dryRunOwn");
  if (event.reason === "outcome") return tr("agents.dryRunOutcome");
  if (event.reason === "filter" && event.filter) {
    return tr("agents.dryRunFilterValue", {
      field: tr(`agents.field.${event.filter.field}` as never),
      op: tr(`agents.op.${event.filter.op}`),
      value: event.filter.value,
    });
  }
  return tr("agents.dryRunSource");
}

const SCRIPT_EXAMPLE = `// events: [{ kind, outcome, at, fields: { title, error, … } }]
// agent: { name, runsToday, lastRunAt }
const failed = events.filter((e) => /deploy/i.test(e.fields.title ?? ""));
if (!failed.length) return { action: "skip", reason: "no deploy failed" };
return { action: "run", note: failed.map((e) => e.fields.title).join(", ") };`;

/** The optional sandboxed script of a wake, with a test on recent events.
 *  Until one is written it is a single "Add a script" action. */
function WakeScript({ script, onChange, onTest }: {
  script: string;
  onChange: (script: string) => void;
  onTest: () => Promise<AgentScriptTestDto>;
}) {
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState("");
  const test = async () => {
    setTesting(true);
    setOutcome("");
    try {
      const tested = await onTest();
      const result = tested.result;
      if (!tested.events || !result) setOutcome(tr("agents.scriptNoEvents"));
      else if (!result.ok) setOutcome(tr("agents.scriptErrorValue", { error: result.error }));
      else if (result.decision.action === "run") {
        setOutcome(tr("agents.scriptWouldRunValue", { ms: result.ms, count: tested.events })
          + (result.decision.note ? ` — ${result.decision.note}` : ""));
      } else {
        const why = result.decision.reason ? ` — ${result.decision.reason}` : "";
        setOutcome((result.decision.action === "skip" ? tr("agents.scriptWouldSkipValue", { ms: result.ms, count: tested.events })
          : tr("agents.scriptWouldPauseValue", { ms: result.ms, count: tested.events })) + why);
      }
    } catch (cause) {
      setOutcome(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };
  if (!script && !adding) {
    return (
      <div className="agent-field agent-script">
        <span className="agent-field-label">{tr("agents.script")}</span>
        <span className="agent-field-hint">{tr("agents.scriptHint")}</span>
        <span>
          <Button size="sm" variant="ghost" iconStart={PlusIcon} className="agent-script-toggle" onClick={() => setAdding(true)}>
            {tr("agents.addScript")}
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className="agent-field agent-script">
      <span className="agent-field-label">{tr("agents.script")}</span>
      <span className="agent-field-hint">{tr("agents.scriptHint")}</span>
      <Textarea
        className="agent-script-text"
        aria-label={tr("agents.script")}
        spellCheck={false}
        autoGrow
        minRows={5}
        maxRows={20}
        value={script}
        placeholder={SCRIPT_EXAMPLE}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="agent-script-actions">
        <Button size="sm" busy={testing} disabled={testing || !script.trim()} onClick={() => void test()}>
          {tr("agents.scriptTest")}
        </Button>
        {outcome && <span className="agent-script-outcome" role="status">{outcome}</span>}
      </span>
    </div>
  );
}

/** A webhook wake's address. Only its fingerprint is stored, so the address
 *  shows once, right after it is issued; a lost one is replaced, never
 *  recovered. */
function WebhookAddress({ hookUrl, issued, onRenew }: {
  hookUrl?: string;
  issued: boolean;
  /** Issue a new address now; absent until the agent is saved. */
  onRenew?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const example = `curl -X POST ${hookUrl ?? "<address>"} \\\n  -H 'content-type: application/json' \\\n  -d '{"title": "Deploy failed"}'`;
  const renew = async () => {
    if (!onRenew) return;
    setBusy(true);
    try { await onRenew(); } finally { setBusy(false); }
  };
  return (
    <div className="agent-hook">
      <span className="agent-field-label">{tr("agents.webhookUrl")}</span>
      {hookUrl ? (
        <>
          <span className="agent-hook-url">
            <code>{hookUrl}</code>
            <CopyButton text={hookUrl} label={tr("agents.copyWebhookUrl")} />
          </span>
          <p className="agent-field-hint is-warning" role="status">{tr("agents.webhookShownOnce")}</p>
        </>
      ) : issued ? (
        <>
          <p className="agent-field-hint">{tr("agents.webhookHidden")}</p>
          <span>
            <Button size="sm" iconStart={RefreshIcon} busy={busy} disabled={busy || !onRenew} onClick={() => void renew()}>
              {tr("agents.webhookNew")}
            </Button>
          </span>
          {!onRenew && <p className="agent-field-hint">{tr("agents.webhookSaveFirst")}</p>}
        </>
      ) : (
        <p className="agent-field-hint">{tr("agents.webhookAfterSave")}</p>
      )}
      <p className="agent-field-hint">{tr("agents.webhookHowTo")}</p>
      <span className="agent-hook-url agent-hook-example">
        <code dir="ltr">{example}</code>
        {hookUrl && <CopyButton text={example} label={tr("agents.copyExample")} />}
      </span>
    </div>
  );
}

/** One event wake: its sentence, what it waits for, and — with the advanced
 *  settings shown — its conditions, pace, script and a dry run. Nothing folds. */
export default function EventTriggerRow({
  trigger,
  projectId,
  agentId,
  agents,
  sources = [],
  hookUrl,
  advanced = false,
  onRenewHook,
  onChange,
  onRemove,
}: {
  trigger: AgentEventTriggerDto;
  projectId: string;
  /** The saved agent, so the preview leaves out its own sessions. */
  agentId?: string;
  /** Other agents this one may follow. */
  agents: ReadonlyArray<{ id: string; name: string }>;
  /** Registered integration sources (Monitoring…). */
  sources?: readonly AgentEventSourceDto[];
  /** A webhook URL issued by the last save; shown only in this session. */
  hookUrl?: string;
  /** Conditions, pace, script and the dry run's events. */
  advanced?: boolean;
  /** Issue a new webhook address for this wake now. */
  onRenewHook?: () => Promise<void>;
  onChange: (next: AgentEventTriggerDto) => void;
  onRemove: () => void;
}) {
  const pace: AgentPaceDto = trigger.pace ?? { ...DEFAULT_TRIGGER_PACE };
  const filters = trigger.filters ?? [];
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "";
  const fields = EVENT_FIELDS[trigger.kind];
  const source = trigger.kind === "integration" ? sources.find((item) => item.id === trigger.source) : undefined;

  // "Would have woken": the server replays the last day through the same rules.
  const [preview, setPreview] = useState<AgentTriggerPreviewDto | null>(null);
  const previewKey = JSON.stringify(trigger);
  useEffect(() => {
    if (!projectId || trigger.kind === "webhook" || (trigger.kind === "agent" && !trigger.agentId) || !trigger.on.length) {
      setPreview(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.scheduleTriggerPreview({ projectId, ...(agentId ? { agentId } : {}), trigger })
        .then((result) => { if (live) setPreview(result); })
        .catch(() => { if (live) setPreview(null); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, projectId, agentId]);

  const toggleOutcome = (outcome: string, on: boolean) => {
    if (trigger.kind === "webhook") return;
    const current: readonly string[] = trigger.on;
    const next = on ? [...new Set([...current, outcome])] : current.filter((item) => item !== outcome);
    onChange({ ...trigger, on: next } as AgentEventTriggerDto);
  };
  const setFilters = (next: AgentEventFilterDto[]) => {
    const { filters: _old, ...rest } = trigger;
    onChange((next.length ? { ...rest, filters: next } : rest) as AgentEventTriggerDto);
  };
  const setPace = (patch: Partial<AgentPaceDto>) => onChange({ ...trigger, pace: { ...pace, ...patch } });
  const outcomes: ReadonlyArray<{ id: string; label: string }> = trigger.kind === "agent"
    ? (["ok", "failed"] as const).map((id) => ({ id, label: tr(`agents.outcome.${id}`) }))
    : trigger.kind === "session"
      ? (["completed", "failed", "stopped"] as const).map((id) => ({ id, label: tr(`agents.outcome.${id}`) }))
      : trigger.kind === "integration"
        ? source?.types ?? trigger.on.map((id) => ({ id, label: id }))
        : [];
  const sentence = triggerSentence(trigger, agentName, sources);
  const invalid = trigger.kind !== "webhook" && (!trigger.on.length || (trigger.kind === "agent" && !trigger.agentId));
  const hint = trigger.kind === "agent" && !trigger.agentId ? tr("agents.chooseAgentHint") : tr("agents.chooseOutcomeHint");

  return (
    <div className="agent-wake agent-event-wake">
      <div className="agent-wake-head">
        <span className="agent-wake-title">
          {sentence}
          {!advanced && filters.length > 0 && <span className="agent-wake-note">{tr("agents.conditionsValue", { count: filters.length })}</span>}
        </span>
        <IconButton icon={DeleteIcon} size="sm" label={tr("agents.removeWakeValue", { wake: sentence })} onClick={onRemove} />
      </div>
      {preview && (
        <p className="agent-wake-preview" role="status">
          {preview.events
            ? tr("agents.wouldHaveWokenValue", { wakes: preview.wakes, events: preview.events })
            : tr("agents.wouldNotHaveWoken")}
        </p>
      )}
      {advanced && preview?.recent?.length ? (
        <details className="agent-dry-run-events">
          <summary>{tr("agents.dryRunTitle")}</summary>
          <ul>
            {preview.recent.map((event, index) => (
              <li key={`${event.at}-${index}`} data-matched={event.matched || undefined}>
                <span className="agent-dry-run-mark" aria-hidden="true">{event.matched ? "✓" : "–"}</span>
                <span className="agent-dry-run-copy">
                  <span>{event.text}</span>
                  <span className="agent-dry-run-why">
                    {formatWake(event.at)}
                    {" · "}
                    {event.matched ? tr("agents.dryRunWould") : dryRunReason(event)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {invalid && <p className="agent-field-hint is-warning">{hint}</p>}
      {trigger.kind === "integration" && !source && (
        <p className="agent-field-hint is-warning">{tr("agents.sourceUnavailableValue", { source: trigger.source })}</p>
      )}
      {trigger.kind === "webhook" && (
        <WebhookAddress
          {...(hookUrl ? { hookUrl } : {})}
          issued={!!trigger.hasToken}
          {...(onRenewHook ? { onRenew: onRenewHook } : {})}
        />
      )}
      <div className="agent-wake-body">
        {trigger.kind === "agent" && (
          <label className="agent-field">
            <span className="agent-field-label">{tr("agents.followAgent")}</span>
            <Select
              label={tr("agents.followAgent")}
              value={trigger.agentId}
              placeholder={agents.length ? tr("agents.chooseAgent") : tr("agents.noOtherAgents")}
              options={agents.map((agent) => ({ value: agent.id, label: agent.name || tr("agents.untitled") }))}
              onChange={(value) => onChange({ ...trigger, agentId: value })}
            />
          </label>
        )}
        {outcomes.length > 0 && trigger.kind !== "webhook" && (
          <fieldset className="agent-choice-group">
            <legend className="agent-field-label">{trigger.kind === "integration" ? tr("agents.wakeOnTypes") : tr("agents.wakeWhen")}</legend>
            {outcomes.map((outcome) => (
              <Checkbox
                key={outcome.id}
                checked={(trigger.on as readonly string[]).includes(outcome.id)}
                onChange={(on) => toggleOutcome(outcome.id, on)}
                label={outcome.label}
              />
            ))}
          </fieldset>
        )}

        {advanced && (
        <>
        <div className="agent-field">
          <span className="agent-field-label">{tr("agents.onlyIf")}</span>
          {filters.map((filter, index) => (
            <div className="agent-filter-row" key={index}>
              <Select
                label={tr("agents.filterField")}
                value={filter.field}
                options={fields.map((field) => ({ value: field, label: tr(`agents.field.${field}`) }))}
                onChange={(value) => setFilters(filters.map((item, i) => i === index ? { ...item, field: value } : item))}
              />
              <Select
                label={tr("agents.filterOp")}
                value={filter.op}
                options={(["contains", "not-contains", "equals", "not-equals"] as const).map((op) => ({ value: op, label: tr(`agents.op.${op}`) }))}
                onChange={(value) => setFilters(filters.map((item, i) => i === index ? { ...item, op: value as AgentEventFilterDto["op"] } : item))}
              />
              <TextInput
                aria-label={tr("agents.filterValue")}
                value={filter.value}
                placeholder={tr("agents.filterValue")}
                onChange={(event) => setFilters(filters.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
              />
              <IconButton icon={CloseIcon} size="sm" label={tr("agents.removeCondition")} onClick={() => setFilters(filters.filter((_, i) => i !== index))} />
            </div>
          ))}
          {filters.length < 8 && (
            <span>
              <Button size="sm" variant="ghost" iconStart={PlusIcon} onClick={() => setFilters([...filters, { field: fields[0], op: "contains", value: "" }])}>
                {tr("agents.addCondition")}
              </Button>
            </span>
          )}
        </div>

        <div className="agent-field">
          <span className="agent-field-label">{tr("agents.pace")}</span>
          <div className="agent-pace">
            <label className="agent-pace-item">
              <span>{tr("agents.quietPeriod")}</span>
              <Select
                label={tr("agents.quietPeriod")}
                value={String(pace.quietMs)}
                options={QUIET_CHOICES.map((ms) => ({ value: String(ms), label: quietLabel(ms) }))}
                onChange={(value) => setPace({ quietMs: Number(value) })}
              />
            </label>
            <label className="agent-pace-item">
              <span>{tr("agents.maxPerHour")}</span>
              <Select
                label={tr("agents.maxPerHour")}
                value={String(pace.maxPerHour)}
                options={RATE_CHOICES.map((count) => ({ value: String(count), label: tr("agents.perHourValue", { count }) }))}
                onChange={(value) => setPace({ maxPerHour: Number(value) })}
              />
            </label>
          </div>
          <Tabs
            size="sm"
            label={tr("agents.combine")}
            value={pace.coalesce}
            tabs={[
              { id: "latest", label: tr("agents.combineLatest") },
              { id: "batch", label: tr("agents.combineBatch") },
            ]}
            onChange={(id) => setPace({ coalesce: id as AgentPaceDto["coalesce"] })}
          />
          <span className="agent-field-hint">{tr("agents.paceHint")}</span>
        </div>

        <WakeScript
          script={trigger.script ?? ""}
          onChange={(script) => {
            const { script: _old, ...rest } = trigger;
            onChange((script.trim() ? { ...rest, script } : rest) as AgentEventTriggerDto);
          }}
          onTest={() => api.scheduleScriptTest({ projectId, ...(agentId ? { agentId } : {}), trigger })}
        />
        </>
        )}
      </div>
    </div>
  );
}
