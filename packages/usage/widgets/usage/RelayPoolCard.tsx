import { useState, type ReactNode } from "react";
import { Button, ChevronDownIcon, Icon } from "../../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import type { UsageLimitSnapshotDto } from "./limitsClient.ts";
import { useUsageLimitsPrefs } from "./limitsPrefs.ts";
import { includedMembers, memberShortName, nextRefill, type UsageRelay, type UsageRelayMember } from "./relayClient.ts";

const clock = (at: number, now: number): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

/** One sentence for a pool: who runs now, who follows, when the next refill is.
 *  Never a combined percentage: each account has its own plan and windows. */
export function relayPoolSentence(relay: UsageRelay, now: number): string {
  const members = includedMembers(relay);
  const current = members.find((member) => member.state === "now");
  const next = members.find((member) => member.state === "next");
  const refill = nextRefill(relay);
  const parts: string[] = [];
  if (current) {
    parts.push(tr("usage.relaySentenceNow", { now: memberShortName(current) }));
    if (next) parts.push(tr("usage.relaySentenceThen", { next: memberShortName(next) }));
  } else {
    parts.push(tr("usage.relaySentenceAllOut"));
  }
  if (refill) parts.push(tr("usage.relaySentenceRefill", { name: memberShortName(refill.member), time: clock(refill.at, now) }));
  else if (!current) parts.push(tr("usage.relaySentenceNoRefill"));
  return `${parts.join(" · ")}.`;
}

/** One account in the queue: its place, its name, whether it runs now or
 *  next, and its tightest window (or when it refills). The meter fills as the
 *  account is spent, like every limit bar on the page, so the queue reads as
 *  accounts filling up one after another. Opening the row shows the account's
 *  own windows, so a Relay's members need no separate cards. */
function MemberRow({
  member,
  place,
  now,
  source,
  renderSource,
}: {
  member: UsageRelayMember;
  place: number;
  now: number;
  source: UsageLimitSnapshotDto | undefined;
  renderSource?: (source: UsageLimitSnapshotDto) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { displayMode } = useUsageLimitsPrefs();
  const remaining = member.tightest?.remaining;
  const out = member.state === "exhausted" || member.state === "skipped";
  const name = memberShortName(member);
  const used = remaining === undefined ? undefined : out ? 1 : Math.min(1, Math.max(0, 1 - remaining));
  const value = remaining === undefined
    ? tr("usage.relayNoReading")
    : out && member.refillsAt !== undefined
      ? tr("usage.relayRefills", { time: clock(member.refillsAt, now) })
      : tr(displayMode === "used" ? "usage.limitShareUsed" : "usage.limitShareLeft", {
        value: `${Math.round((displayMode === "used" ? 1 - remaining : remaining) * 100)}%`,
      });
  const state = member.state === "now" ? tr("usage.relayNow") : member.state === "next" ? tr("usage.relayNext") : "";
  const detailId = `usage-relay-detail-${member.harnessId}`;
  const expandable = Boolean(source && renderSource);
  const content = (
    <>
      <span className="usage-relay-member-place" aria-hidden="true">{place}</span>
      <span className="usage-relay-member-title">
        <span className="usage-relay-member-name">{name}</span>
        {state ? <span className="usage-relay-member-state">{state}</span> : null}
      </span>
      <span className="usage-relay-member-value">{value}</span>
      {expandable ? <Icon icon={ChevronDownIcon} size="sm" className="usage-relay-member-chevron" /> : null}
      <span className="usage-relay-member-meter" role="img" aria-label={`${name}: ${value}`}>
        {used !== undefined ? <i style={{ inlineSize: `${Math.round(used * 100)}%` }} /> : null}
      </span>
    </>
  );
  return (
    <li
      className="usage-relay-member"
      data-member={member.harnessId}
      data-state={member.state}
      data-out={out ? "" : undefined}
      data-unknown={remaining === undefined ? "" : undefined}
      data-open={open ? "" : undefined}
    >
      {expandable ? (
        <button
          type="button"
          className="usage-relay-member-row"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          {content}
        </button>
      ) : <div className="usage-relay-member-row">{content}</div>}
      {open && source && renderSource ? (
        <div className="usage-relay-member-detail" id={detailId}>{renderSource(source)}</div>
      ) : null}
    </li>
  );
}

export function RelayPoolCard({
  relay,
  now,
  sources,
  renderSource,
  onRefresh,
}: {
  relay: UsageRelay;
  now: number;
  /** Each member's own limits snapshot, by harness id. */
  sources?: ReadonlyMap<string, UsageLimitSnapshotDto>;
  /** What an opened member row shows: the account's limit windows. */
  renderSource?: (source: UsageLimitSnapshotDto) => ReactNode;
  /** Refresh every member's limits. */
  onRefresh?: (providerIds: string[]) => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const members = includedMembers(relay);
  if (members.length === 0) return null;
  const name = `${relay.label} · Relay`;
  const anyRunning = members.some((member) => member.state === "now");
  const memberSources = members.flatMap((member) => sources?.get(member.harnessId) ?? []);
  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh(memberSources.map((source) => source.providerId));
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="usage-limit-provider usage-relay-pool" data-testid="relay-pool" aria-label={tr("usage.relayPoolAria", { name })}>
      <header className="usage-limit-provider-head">
        <div className="usage-limit-provider-copy">
          <h3>{tr("usage.relayPool", { name })}</h3>
          <p>{members.length < 2 ? tr("usage.relaySingle") : tr("usage.relayAccounts", { count: members.length })}</p>
        </div>
        {onRefresh && memberSources.length ? (
          <div className="usage-limit-provider-actions">
            <Button size="sm" variant="quiet" busy={refreshing} onClick={() => void refresh()}>
              {tr("usage.limitRefresh")}
            </Button>
          </div>
        ) : null}
      </header>
      <ol className="usage-relay-queue">
        {members.map((member, index) => (
          <MemberRow
            key={member.harnessId}
            member={member}
            place={index + 1}
            now={now}
            source={sources?.get(member.harnessId)}
            renderSource={renderSource}
          />
        ))}
      </ol>
      {/* The rows already say who runs and who follows; the sentence only
          speaks when nobody can run. */}
      {members.length >= 2 && !anyRunning ? <p className="usage-relay-sentence">{relayPoolSentence(relay, now)}</p> : null}
    </section>
  );
}
