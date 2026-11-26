import { useEffect, useState } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

/** The slice of `/api/harness-relay/relays` the Limits page reads. Mirrors
 *  `RelayView` of `@polyth/harness-runtime/relay`; kept structural so Usage
 *  does not depend on that package. */
export interface UsageRelayMember {
  harnessId: string;
  name: string;
  included: boolean;
  position?: number;
  state: "now" | "next" | "queued" | "skipped" | "exhausted";
  reason?: string;
  tightest?: { label: string; remaining: number; resetsAt?: number };
  refillsAt?: number;
}
export interface UsageRelay {
  id: string;
  family: string;
  label: string;
  exhaustedUntil?: number;
  members: UsageRelayMember[];
}

/** The family's own login is the account Settings calls "Default". */
export const withDefaultName = (relay: UsageRelay): UsageRelay => ({
  ...relay,
  members: relay.members.map((member) => member.harnessId === relay.family ? { ...member, name: tr("usage.relayDefault") } : member),
});

/** Relays the person may see. A server without Relay (404) or a paired device
 *  without access (403) yields none. */
export async function requestUsageRelays(signal?: AbortSignal): Promise<UsageRelay[]> {
  try {
    const body = await sessionFetch<{ relays?: UsageRelay[] }>("/api/harness-relay/relays", signal ? { signal } : undefined);
    return Array.isArray(body?.relays) ? body.relays.map(withDefaultName) : [];
  } catch {
    return [];
  }
}

export function useUsageRelays(): UsageRelay[] {
  const [relays, setRelays] = useState<UsageRelay[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => { void requestUsageRelays().then((next) => { if (live) setRelays(next); }); };
    load();
    const timer = setInterval(load, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return relays;
}

/** Included members in plan order. */
export const includedMembers = (relay: UsageRelay): UsageRelayMember[] =>
  relay.members.filter((member) => member.included).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

/** "Claude Code · Iryna" → "Iryna"; the default account keeps its name. */
export const memberShortName = (member: UsageRelayMember): string => {
  const at = member.name.lastIndexOf(" · ");
  return at >= 0 ? member.name.slice(at + 3) : member.name;
};

/** The earliest time an out-of-limit included member comes back. */
export function nextRefill(relay: UsageRelay): { at: number; member: UsageRelayMember } | undefined {
  const candidates = includedMembers(relay)
    .filter((member) => member.state === "exhausted" || member.state === "skipped" ? member.refillsAt !== undefined : false)
    .map((member) => ({ at: member.refillsAt!, member }));
  return candidates.sort((a, b) => a.at - b.at)[0];
}

/** Harnesses whose accounts a Relay card already shows: the included members
 *  of every Relay that rotates (two or more included accounts). A Relay of one
 *  account rotates nothing, so that account keeps its own card. */
export function relayMemberHarnesses(relays: readonly UsageRelay[]): Set<string> {
  const ids = new Set<string>();
  for (const relay of relays) {
    const members = includedMembers(relay);
    if (members.length < 2) continue;
    for (const member of members) ids.add(member.harnessId);
  }
  return ids;
}

/** Badge data for the per-account card of one harness. */
export function relayBadgeFor(relays: readonly UsageRelay[], harnessId: string): { n: number; state: UsageRelayMember["state"] } | undefined {
  for (const relay of relays) {
    const member = relay.members.find((candidate) => candidate.harnessId === harnessId && candidate.included && candidate.position !== undefined);
    if (member) return { n: member.position!, state: member.state };
  }
  return undefined;
}
