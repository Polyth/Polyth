import { useState } from "react";
import { Badge, IconButton, CopyIcon, RefreshIcon, Skeleton, Spinner } from "../../../apps/web/src/components/ui/index.ts";
import { DisclosureRow, EmptyState, ItemList, ItemRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { isBuiltinRole, type OrchestrationState, type ResolvedRole, type ShortlistRow } from "../src/contracts.ts";
import { formatAgo, formatSpan, percent, skippedReasons, statusText, type Translate } from "./helpers.ts";
import { harnessLabel, QuotaMeter } from "./Meter.tsx";

const translate: Translate = (key, values) => tr(key as never, values);

export const roleName = (role: { id: string; label?: string }): string =>
  isBuiltinRole(role.id) ? tr(`orchestration.role.${role.id}`) : role.label || role.id;

function rowMeta(row: ShortlistRow, now: number, windowDays: number): string {
  const parts = [harnessLabel(row.harnessId)];
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

export default function NowTab({ state, loading, refreshing, mode, ceiling, now, onRefresh, onOpenRole }: {
  state: OrchestrationState | null;
  loading: boolean;
  refreshing: boolean;
  mode: "auto" | "roles";
  ceiling: number;
  now: number;
  onRefresh: () => void;
  onOpenRole: (id: string) => void;
}) {
  const [textOpen, setTextOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const activeRoles = mode === "roles" ? state.roles.filter((role) => role.enabled && role.choices.length > 0) : [];
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
      {mode === "roles" && activeRoles.length > 0 && (
        <Section title={tr("orchestration.now.roles")}>
          <ItemList>
            {activeRoles.map((role) => <RoleNow key={role.id} role={role} ceiling={ceiling} now={now} onOpen={() => onOpenRole(role.id)} />)}
          </ItemList>
        </Section>
      )}
      <Section title={tr("orchestration.now.list")}>
        {shortlist.rows.length === 0 ? (
          <EmptyState title={tr("orchestration.now.emptyTitle")} body={tr("orchestration.now.emptyBody")} compact />
        ) : (
          <ItemList>
            {shortlist.rows.map((row, i) => {
              const used = percent(row.quotaUsed);
              return (
                <ItemRow
                  key={row.key}
                  className="orch-ranked"
                  icon={<span className="orch-rank" aria-label={tr("orchestration.now.rank", { rank: i + 1 })}>{i + 1}</span>}
                  title={`${row.favorite ? "★ " : ""}${row.name}`}
                  meta={<span className="orch-meta">{[row.runs, rowMeta(row, now, shortlist.windowDays)].filter(Boolean).join(" · ")}</span>}
                  inactive={!row.available}
                  trailing={(
                    <span className="orch-trailing">
                      {used !== undefined && <QuotaMeter used={row.quotaUsed} window={row.quotaWindow} ceiling={ceiling} blocked={row.blocked} now={now} />}
                      {row.blocked && <Badge tone="danger">{row.blockedUntil && row.blockedUntil > now
                        ? tr("orchestration.status.blocked", { time: formatSpan(row.blockedUntil - now, translate) })
                        : tr("orchestration.status.blockedNoTime")}</Badge>}
                      {!row.available && <Badge>{tr("orchestration.status.unavailable")}</Badge>}
                      {row.available && !row.listed && <Badge>{tr("orchestration.status.unverified")}</Badge>}
                    </span>
                  )}
                />
              );
            })}
          </ItemList>
        )}
        <div className="orch-foot">
          {shortlist.omitted > 0 && <p>{tr("orchestration.now.omitted", { count: shortlist.omitted })}</p>}
          {shortlist.unlisted > 0 && <p>{tr("orchestration.now.unlisted", { count: shortlist.unlisted })}</p>}
          {shortlist.excluded > 0 && <p>{tr("orchestration.now.excluded", { count: shortlist.excluded })}</p>}
        </div>
      </Section>
      {shortlist.quotas.length > 0 && (
        <Section title={tr("orchestration.now.quotas")}>
          <ItemList>
            {shortlist.quotas.map((source) => (
              <ItemRow
                key={source.sourceId}
                className="orch-flat orch-quota-row"
                icon={null}
                title={source.label ? `${source.sourceId} · ${source.label}` : source.sourceId}
                inactive={source.stale}
                trailing={(
                  <span className="orch-windows">
                    {source.windows.map((w) => (
                      <span key={w.id} className="orch-window">
                        <span>{w.label}</span> <strong>{percent(w.used) ?? 0}%</strong>
                        {w.resetsAt && w.resetsAt > now ? <span className="orch-muted"> ↻ {formatSpan(w.resetsAt - now, translate)}</span> : null}
                        {w.pace === "over" && <span className="orch-chip orch-chip--warning">{tr("orchestration.now.pace")}</span>}
                      </span>
                    ))}
                    {source.stale && <span className="orch-chip orch-chip--neutral">{tr("orchestration.now.stale")}</span>}
                  </span>
                )}
              />
            ))}
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
