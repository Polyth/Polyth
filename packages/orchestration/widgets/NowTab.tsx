import { useMemo, useState } from "react";
import {
  ArrowDownIcon, ArrowUpIcon, Badge, BlockedIcon, CopyIcon, IconButton, Menu, MoreIcon, PinIcon, PullIcon, RefreshIcon,
  Skeleton, Spinner, UndoIcon, type MenuAction, type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { DisclosureRow, EmptyState, ItemList, ItemRow, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AGENT_SHORTLIST_ROWS, POLICY_LIMITS, isBuiltinRole,
  type HarnessRule, type OrchestrationState, type ResolvedRole, type RoutingPolicy, type ShortlistRow,
} from "../src/contracts.ts";
import {
  formatAgo, formatSpan, harnessChips, harnessDisplay, orderEdits, orderRows, percent, quotaSourceName, rankReasons, rowsMeteredBy,
  skippedReasons, statusText, type Translate,
} from "./helpers.ts";
import { harnessLabel, QuotaMeter } from "./Meter.tsx";

const translate: Translate = (key, values) => tr(key as never, values);

export const roleName = (role: { id: string; label?: string }): string =>
  isBuiltinRole(role.id) ? tr(`orchestration.role.${role.id}`) : role.label || role.id;

function rowMeta(row: ShortlistRow, now: number, windowDays: number): string {
  const parts = [harnessDisplay(row.harnessId, row.harnessName)];
  if (row.turns <= 0) {
    parts.push(tr("orchestration.now.notUsed", { days: windowDays }));
    return parts.join(" · ");
  }
  parts.push(tr("orchestration.now.turns", { count: row.turns }));
  if (row.sessions > 0) parts.push(tr("orchestration.now.chats", { count: row.sessions }));
  const failed = Math.round((row.failed / row.turns) * 100);
  if (failed > 0) parts.push(tr("orchestration.now.failed", { percent: failed }));
  if (row.lastUsedAt) parts.push(tr("orchestration.now.lastUsed", { time: formatAgo(row.lastUsedAt, now, translate) }));
  return parts.join(" · ");
}

function RoleNow({ role, ceiling, now, onOpen }: { role: ResolvedRole; ceiling: number; now: number; onOpen: () => void }) {
  const picked = role.pick !== undefined ? role.choices[role.pick] : undefined;
  const skipped = picked && role.pick !== undefined && role.pick > 0 ? role.choices[0] : undefined;
  const meta = picked
    ? [
      picked.name,
      harnessLabel(picked.harnessId),
      skipped ? tr("orchestration.now.fallbackWhy", { model: skipped.name, reason: statusText(skipped, ceiling, now, translate) }) : "",
    ].filter(Boolean).join(" · ")
    : skippedReasons(role.choices, ceiling, now, translate);
  const badge = !picked
    ? <Badge tone="danger">{tr("orchestration.status.none")}</Badge>
    : skipped ? <Badge tone="warning">{tr("orchestration.status.fallback")}</Badge> : <Badge tone="success">{tr("orchestration.status.ready")}</Badge>;
  return (
    <ItemRow
      className="orch-flat"
      icon={null}
      title={roleName(role)}
      meta={<span className="orch-meta">{meta}</span>}
      trailing={badge}
      onOpen={onOpen}
      openLabel={roleName(role)}
    />
  );
}

/** One ranked model: its facts, quota and a menu that explains the rank and moves it. */
function RankedRow({ row, rank, draft, setDraft, ceiling, overPaceCeiling, now, windowDays, beyond }: {
  row: ShortlistRow;
  rank: number;
  draft: RoutingPolicy;
  setDraft: (next: RoutingPolicy) => void;
  ceiling: number;
  overPaceCeiling: number | null;
  now: number;
  windowDays: number;
  beyond: boolean;
}) {
  const pinAt = draft.pinned.indexOf(row.key);
  const pinned = pinAt >= 0;
  const demoted = draft.demoted.includes(row.key);
  const action = (id: string, icon: MenuAction["icon"], edit: (policy: RoutingPolicy) => RoutingPolicy, extra: Partial<MenuAction> = {}): MenuAction =>
    ({ id, label: translate(`orchestration.row.${id}`), icon, onSelect: () => setDraft(edit(draft)), ...extra });
  const entries: MenuEntry[] = [];
  if (pinned) {
    if (pinAt > 0) entries.push(action("up", ArrowUpIcon, (p) => orderEdits.move(p, row.key, -1)));
    if (pinAt < draft.pinned.length - 1) entries.push(action("down", ArrowDownIcon, (p) => orderEdits.move(p, row.key, 1)));
    entries.push(action("unpin", UndoIcon, (p) => orderEdits.unpin(p, row.key)));
  } else {
    entries.push(action("pin", PinIcon, (p) => orderEdits.pin(p, row.key), { disabled: draft.pinned.length >= POLICY_LIMITS.pinned }));
  }
  entries.push(demoted
    ? action("undemote", UndoIcon, (p) => orderEdits.undemote(p, row.key))
    : action("demote", PullIcon, (p) => orderEdits.demote(p, row.key), { disabled: draft.demoted.length >= POLICY_LIMITS.demoted }));
  entries.push("separator", action("never", BlockedIcon, (p) => orderEdits.never(p, row.key), {
    danger: true, disabled: draft.excluded.length >= POLICY_LIMITS.excluded,
  }));
  const reasons = rankReasons(row, windowDays, translate);
  const placedChip = row.placed
    ? <span className={`orch-chip orch-chip--place orch-chip--${row.placed}`}>{tr(`orchestration.place.${row.placed}`)}</span>
    : null;
  return (
    <ItemRow
      className="orch-ranked"
      icon={<span className="orch-rank" aria-label={tr("orchestration.now.rank", { rank })}>{rank}</span>}
      title={`${row.favorite ? "★ " : ""}${row.name}`}
      meta={<span className="orch-meta">{[row.runs, rowMeta(row, now, windowDays)].filter(Boolean).join(" · ")}</span>}
      inactive={!row.available || beyond}
      trailing={(
        <span className="orch-trailing">
          {placedChip}
          {percent(row.quotaUsed) !== undefined && (
            <QuotaMeter used={row.quotaUsed} window={row.quotaWindow} ceiling={ceiling} overPaceCeiling={overPaceCeiling} blocked={row.blocked} now={now} />
          )}
          {row.blocked && <Badge tone="danger">{row.blockedUntil && row.blockedUntil > now
            ? tr("orchestration.status.blocked", { time: formatSpan(row.blockedUntil - now, translate) })
            : tr("orchestration.status.blockedNoTime")}</Badge>}
          {!row.available && <Badge>{tr("orchestration.status.unavailable")}</Badge>}
          {row.available && !row.listed && <Badge>{tr("orchestration.status.unverified")}</Badge>}
          <Menu
            label={tr("orchestration.row.menu", { name: row.name })}
            title={row.name}
            align="end"
            entries={entries}
            header={(
              <div className="orch-why">
                <strong>{tr("orchestration.row.why", { rank })}</strong>
                <ul>{reasons.map((text) => <li key={text}>{text}</li>)}</ul>
              </div>
            )}
          >
            {(trigger) => (
              <IconButton {...trigger} icon={MoreIcon} label={tr("orchestration.row.menu", { name: row.name })} size="sm" className="orch-row-menu" />
            )}
          </Menu>
        </span>
      )}
    />
  );
}

type Filter = { kind: "all" } | { kind: "harness"; id: string };

const RULES: ReadonlyArray<HarnessRule | "normal"> = ["prefer", "normal", "avoid", "never"];

function HarnessFilter({ chips, filter, setFilter, draft, setDraft }: {
  chips: ReturnType<typeof harnessChips>;
  filter: Filter;
  setFilter: (next: Filter) => void;
  draft: RoutingPolicy;
  setDraft: (next: RoutingPolicy) => void;
}) {
  if (chips.length < 2 && !chips.some((chip) => chip.rule)) return null;
  const active = filter.kind === "harness" ? chips.find((chip) => chip.id === filter.id) : undefined;
  const rule = active ? draft.harnesses[active.id] ?? "normal" : "normal";
  return (
    <div className="orch-filter">
      <div className="orch-filter-chips" role="group" aria-label={tr("orchestration.now.filterLabel")}>
        <button type="button" className="orch-filter-chip" aria-pressed={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
          {tr("orchestration.now.filterAll")}
        </button>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="orch-filter-chip"
            data-rule={chip.rule}
            aria-pressed={active?.id === chip.id}
            onClick={() => setFilter(active?.id === chip.id ? { kind: "all" } : { kind: "harness", id: chip.id })}
          >
            <span>{chip.name}</span>
            {chip.rule ? <em className="orch-filter-rule">{tr(`orchestration.rule.${chip.rule}`)}</em> : <em className="orch-filter-count">{chip.count}</em>}
          </button>
        ))}
      </div>
      {active && (
        <div className="orch-rule">
          <span className="orch-rule-label">{tr("orchestration.now.ruleLabel", { harness: active.name })}</span>
          <div className="orch-seg">
            <Seg
              label={tr("orchestration.now.ruleLabel", { harness: active.name })}
              value={rule}
              options={RULES.map((id) => [id, tr(`orchestration.rule.${id}`)] as [HarnessRule | "normal", string])}
              onChange={(next) => setDraft(orderEdits.harness(draft, active.id, next))}
            />
          </div>
          <p className="orch-hint">{tr(`orchestration.rule.${rule}Hint`, { harness: active.name })}</p>
        </div>
      )}
    </div>
  );
}

function QuotaWindow({ source, window: w, rows, ceiling, overPaceCeiling, now }: {
  source: OrchestrationState["shortlist"]["quotas"][number];
  window: OrchestrationState["shortlist"]["quotas"][number]["windows"][number];
  rows: readonly ShortlistRow[];
  ceiling: number;
  overPaceCeiling: number | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const limited = rowsMeteredBy(rows, source.sourceId, w.id);
  const body = (
    <>
      <span className="orch-window-label">
        <span>{w.label}</span>
        {w.pace === "over" && <span className="orch-chip orch-chip--warning">{tr("orchestration.now.pace")}</span>}
      </span>
      <QuotaMeter
        used={w.used}
        window={{ sourceId: source.sourceId, label: w.label, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}), ...(w.pace ? { pace: w.pace } : {}) }}
        ceiling={ceiling}
        overPaceCeiling={overPaceCeiling}
        now={now}
      />
      <span className="orch-window-reset" aria-hidden="true">
        {w.resetsAt && w.resetsAt > now ? `↻ ${formatSpan(w.resetsAt - now, translate)}` : ""}
      </span>
    </>
  );
  if (limited.length === 0) return <span className="orch-window">{body}</span>;
  return (
    <>
      <button
        type="button"
        className="orch-window orch-window--link"
        aria-expanded={open}
        title={tr("orchestration.now.windowShow", { window: w.label })}
        onClick={() => setOpen((v) => !v)}
      >
        {body}
      </button>
      {open && (
        <span className="orch-window-models">
          <span className="orch-muted">{tr("orchestration.now.windowLimits")}</span>
          {limited.map(({ rank, row }) => (
            <span key={row.key} className="orch-window-model"><span className="orch-rank">{rank}</span>{row.name}</span>
          ))}
        </span>
      )}
    </>
  );
}

export default function NowTab({ state, draft, setDraft, loading, refreshing, ceiling, overPaceCeiling, now, onRefresh, onOpenRole }: {
  state: OrchestrationState | null;
  draft: RoutingPolicy;
  setDraft: (next: RoutingPolicy) => void;
  loading: boolean;
  refreshing: boolean;
  ceiling: number;
  /** Roles mode only; null in automatic mode. */
  overPaceCeiling: number | null;
  now: number;
  onRefresh: () => void;
  onOpenRole: (id: string) => void;
}) {
  const [textOpen, setTextOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [showBeyond, setShowBeyond] = useState(false);
  const ordered = useMemo(() => orderRows(state?.shortlist.rows ?? [], draft), [state, draft]);
  const chips = useMemo(() => harnessChips(ordered, state?.harnesses ?? [], draft), [ordered, state, draft]);
  const copy = () => {
    if (!state) return;
    void navigator.clipboard?.writeText(state.agentText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  if (loading && !state) {
    return (
      <div className="orch-skeleton" aria-hidden="true">
        {[0, 1, 2].map((n) => <Skeleton key={n} shape="block" height={52} />)}
      </div>
    );
  }
  if (!state) return null;
  const { shortlist } = state;
  const activeRoles = draft.mode === "roles" ? state.roles.filter((role) => role.enabled && role.choices.length > 0) : [];
  const cut = Math.min(AGENT_SHORTLIST_ROWS, ordered.length);
  const ranked = ordered.map((row, i) => ({ row, rank: i + 1 }));
  const shown = filter.kind === "harness" ? ranked.filter(({ row }) => row.harnessId === filter.id) : ranked;
  const seen = shown.filter(({ rank }) => rank <= cut);
  const beyond = shown.filter(({ rank }) => rank > cut);
  const renderRow = ({ row, rank }: { row: ShortlistRow; rank: number }) => (
    <RankedRow
      key={row.key}
      row={row}
      rank={rank}
      draft={draft}
      setDraft={setDraft}
      ceiling={ceiling}
      overPaceCeiling={overPaceCeiling}
      now={now}
      windowDays={shortlist.windowDays}
      beyond={rank > cut}
    />
  );
  const refreshBar = (
    <div className="orch-refresh">
      <span className="orch-muted">{tr("orchestration.now.updated", { time: formatAgo(state.generatedAt, now, translate) })}</span>
      {refreshing ? <Spinner label={tr("orchestration.now.refresh")} /> : null}
      <IconButton icon={RefreshIcon} label={tr("orchestration.now.refresh")} size="sm" onClick={onRefresh} disabled={refreshing} />
    </div>
  );
  return (
    <div className="orch-now">
      {refreshBar}
      {draft.mode === "roles" && activeRoles.length > 0 && (
        <Section title={tr("orchestration.now.roles")}>
          <ItemList>
            {activeRoles.map((role) => <RoleNow key={role.id} role={role} ceiling={ceiling} now={now} onOpen={() => onOpenRole(role.id)} />)}
          </ItemList>
        </Section>
      )}
      <Section title={tr("orchestration.now.list")} hint={tr("orchestration.now.listHint")}>
        <HarnessFilter chips={chips} filter={filter} setFilter={setFilter} draft={draft} setDraft={setDraft} />
        {ordered.length === 0 ? (
          <EmptyState title={tr("orchestration.now.emptyTitle")} body={tr("orchestration.now.emptyBody")} compact />
        ) : shown.length === 0 ? (
          <p className="orch-inline-note">{tr("orchestration.now.filterEmpty")}</p>
        ) : (
          <>
            {seen.length > 0 && <ItemList>{seen.map(renderRow)}</ItemList>}
            {beyond.length > 0 && (
              <div className="orch-cut">
                <span>{tr("orchestration.now.agentCut", { count: cut })}</span>
                <button type="button" className="orch-link" aria-expanded={showBeyond} onClick={() => setShowBeyond((v) => !v)}>
                  {showBeyond ? tr("orchestration.now.showLess") : tr("orchestration.now.showMore", { count: beyond.length })}
                </button>
              </div>
            )}
            {beyond.length > 0 && showBeyond && <ItemList className="orch-beyond">{beyond.map(renderRow)}</ItemList>}
          </>
        )}
        <div className="orch-foot">
          {shortlist.omitted > 0 && <p>{tr("orchestration.now.omitted", { count: shortlist.omitted })}</p>}
          {shortlist.unlisted > 0 && <p>{tr("orchestration.now.unlisted", { count: shortlist.unlisted })}</p>}
          {shortlist.excluded > 0 && <p>{tr("orchestration.now.excluded", { count: shortlist.excluded })}</p>}
        </div>
      </Section>
      {shortlist.quotas.length > 0 && (
        <Section title={tr("orchestration.now.quotas")} hint={tr("orchestration.now.quotasHint")}>
          <ItemList>
            {shortlist.quotas.map((source) => {
              const { title, plan } = quotaSourceName(source);
              return (
                <ItemRow
                  key={source.sourceId}
                  className="orch-flat orch-quota-row"
                  icon={null}
                  title={title}
                  meta={plan || source.stale ? (
                    <span className="orch-meta">
                      {plan}
                      {source.stale && <span className="orch-chip">{tr("orchestration.now.stale")}</span>}
                    </span>
                  ) : undefined}
                  inactive={source.stale}
                  trailing={(
                    <span className="orch-windows">
                      {source.windows.map((w) => (
                        <QuotaWindow key={w.id} source={source} window={w} rows={ordered} ceiling={ceiling} overPaceCeiling={overPaceCeiling} now={now} />
                      ))}
                    </span>
                  )}
                />
              );
            })}
          </ItemList>
        </Section>
      )}
      <ItemList>
        <DisclosureRow
          label={tr("orchestration.now.agentText")}
          open={textOpen}
          onToggle={() => setTextOpen((open) => !open)}
          rowId="orchestration.agent-text"
        >
          <div className="orch-agent-text">
            <IconButton
              icon={CopyIcon}
              label={tr("orchestration.now.agentTextCopy")}
              size="sm"
              pressed={copied}
              onClick={copy}
              className="orch-agent-copy"
            />
            <pre tabIndex={0}>{state.agentText}</pre>
          </div>
        </DisclosureRow>
      </ItemList>
    </div>
  );
}
