import { tr } from "../../../../apps/web/src/i18n/index.ts";
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

function Segment({ member, now }: { member: UsageRelayMember; now: number }) {
  const remaining = member.tightest?.remaining;
  const out = member.state === "exhausted" || member.state === "skipped";
  const label = remaining === undefined
    ? tr("usage.relayNoReading")
    : out && member.refillsAt !== undefined ? tr("usage.relayRefills", { time: clock(member.refillsAt, now) }) : tr("usage.relayLeft", { percent: Math.round(remaining * 100) });
  return (
    <li
      className="usage-relay-seg"
      data-state={member.state}
      data-unknown={remaining === undefined ? "" : undefined}
      data-out={out ? "" : undefined}
    >
      <span className="usage-relay-seg-tag">
        {member.state === "now" ? tr("usage.relayNow") : member.state === "next" ? tr("usage.relayNext") : " "}
      </span>
      <span className="usage-relay-seg-bar" role="img" aria-label={`${memberShortName(member)}: ${label}`}>
        {remaining !== undefined && !out ? <i style={{ inlineSize: `${Math.round(remaining * 100)}%` }} /> : null}
      </span>
      <span className="usage-relay-seg-name">{memberShortName(member)}</span>
      <span className="usage-relay-seg-detail">{label}</span>
    </li>
  );
}

export function RelayPoolCard({ relay, now }: { relay: UsageRelay; now: number }) {
  const members = includedMembers(relay);
  if (members.length === 0) return null;
  const name = `${relay.label} · Relay`;
  return (
    <section className="usage-limit-provider usage-relay-pool" data-testid="relay-pool" aria-label={tr("usage.relayPoolAria", { name })}>
      <header className="usage-limit-provider-head">
        <div className="usage-limit-provider-copy">
          <h3>{tr("usage.relayPool", { name })}</h3>
          <p>{tr("usage.relayPoolSub")}</p>
        </div>
      </header>
      <div className="usage-relay-body">
        <ol className="usage-relay-strip">{members.map((member) => <Segment key={member.harnessId} member={member} now={now} />)}</ol>
        <p className="usage-relay-sentence">{members.length < 2 ? tr("usage.relaySingle") : relayPoolSentence(relay, now)}</p>
      </div>
    </section>
  );
}
