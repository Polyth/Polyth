// Relay: a per-family virtual harness that spends a person's member accounts
// one after another. This file is the pure chooser plus the settings shapes
// the store, the registry redirection and the routes share; it does no I/O.
import type { HarnessRelayPlan } from "@polyth/contracts";

export type RelayOrder = "expire-first" | "manual";
export const RELAY_ORDERS: readonly RelayOrder[] = ["expire-first", "manual"];
/** Fractions of a window that must remain before a member hands over. */
export const RELAY_HANDOVER_LEVELS: readonly number[] = [0.02, 0.05, 0.1];
export const RELAY_MAX_MEMBERS = 16;
/** A Relay with fewer members has nothing to rotate: the harness list and the
 *  picker leave it out for that person, and Settings keeps it out of sight
 *  until the family has this many accounts the person may use. A chat already
 *  pinned to it still runs on its one member. */
export const RELAY_MIN_MEMBERS = 2;
/** How long a member that refused a turn is skipped when no time was stated. */
export const RELAY_DEFAULT_REFUSAL_MS = 15 * 60_000;

export interface RelaySettings {
    /** Ordered member harness ids. */
    members: string[];
    order: RelayOrder;
    handoverAt: number;
}
export const defaultRelaySettings = (): RelaySettings => ({ members: [], order: "expire-first", handoverAt: 0.05 });

/** Browser-safe views served by `/api/harnesses/relays`. */
export interface RelayMemberView {
    harnessId: string;
    name: string;
    included: boolean;
    /** 1-based among included members. */
    position?: number;
    state: "now" | "next" | "queued" | "skipped" | "exhausted";
    reason?: "signed-out" | "refused" | "limit" | "no-access";
    tightest?: { label: string; remaining: number; resetsAt?: number };
    refillsAt?: number;
    owner: "mine" | "shared" | "shared-by-other";
    ownerName?: string;
}
export interface RelayView {
    id: string;
    family: string;
    label: string;
    settings: RelaySettings;
    limitsAvailable: boolean;
    exhaustedUntil?: number;
    members: RelayMemberView[];
}

export interface RelayWindow { used: number; limit: number; resetsAt?: number; label?: string }
export interface RelayHeadroom {
    windows: readonly RelayWindow[];
    /** `false`: no limits reading for this member. */
    known: boolean;
}

export interface RelayChooserInput {
    members: readonly string[];
    headroom: ReadonlyMap<string, RelayHeadroom> | Readonly<Record<string, RelayHeadroom>>;
    refusedUntil: ReadonlyMap<string, number>;
    usable: ReadonlySet<string>;
    sticky?: string;
    order: RelayOrder;
    handoverAt: number;
    now: number;
}

const remainingOf = (window: RelayWindow): number => window.limit > 0 ? 1 - window.used / window.limit : 1;

export interface RelayMemberJudgement {
    eligible: boolean;
    reason?: "signed-out" | "refused" | "limit";
    /** When this member may qualify again, if known. */
    until?: number;
}

const lookup = (map: RelayChooserInput["headroom"], id: string): RelayHeadroom | undefined =>
    map instanceof Map ? map.get(id) : (map as Record<string, RelayHeadroom>)[id];

export function judgeMember(input: RelayChooserInput, id: string): RelayMemberJudgement {
    if (!input.usable.has(id)) return { eligible: false, reason: "signed-out" };
    const refused = input.refusedUntil.get(id);
    const reading = lookup(input.headroom, id);
    const blocking = reading?.known
        ? reading.windows.filter((window) => remainingOf(window) <= input.handoverAt + 1e-9)
        : [];
    const refusedNow = refused !== undefined && refused > input.now;
    if (!refusedNow && blocking.length === 0) return { eligible: true };
    // Eligible again only once the refusal and every blocking window have
    // passed: the latest of them. A blocking window with no reset time leaves
    // the member's return unknown.
    const blockingResets = blocking.map((window) => window.resetsAt);
    const unknownReturn = blockingResets.some((at) => at === undefined);
    const times = [
        ...(refusedNow ? [refused] : []),
        ...blockingResets.flatMap((at) => at !== undefined && at > input.now ? [at] : []),
    ];
    return {
        eligible: false,
        reason: refusedNow ? "refused" : "limit",
        ...(times.length && !unknownReturn ? { until: Math.max(...times) } : {}),
    };
}

/** The earliest future `resetsAt` among running windows, if any. */
export const earliestRunningReset = (reading: RelayHeadroom | undefined, now: number): number | undefined => {
    if (!reading?.known) return undefined;
    let best: number | undefined;
    for (const window of reading.windows) {
        if (window.resetsAt !== undefined && window.resetsAt > now && (best === undefined || window.resetsAt < best)) best = window.resetsAt;
    }
    return best;
};

export function chooseRelayMembers(input: RelayChooserInput): HarnessRelayPlan {
    const unique = [...new Set(input.members)];
    const eligible = unique.filter((id) => judgeMember(input, id).eligible);
    if (eligible.length === 0) {
        const times = unique.flatMap((id) => {
            const until = judgeMember(input, id).until;
            return until === undefined ? [] : [until];
        });
        return { candidates: [], ...(times.length ? { exhaustedUntil: Math.min(...times) } : {}) };
    }
    const sticky = input.sticky !== undefined && eligible.includes(input.sticky) ? input.sticky : undefined;
    const rest = eligible.filter((id) => id !== sticky);
    if (input.order === "expire-first") {
        const position = new Map(unique.map((id, index) => [id, index] as const));
        const reset = new Map(rest.map((id) => [id, earliestRunningReset(lookup(input.headroom, id), input.now)] as const));
        rest.sort((a, b) => {
            const ra = reset.get(a);
            const rb = reset.get(b);
            if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
            if ((ra === undefined) !== (rb === undefined)) return ra === undefined ? 1 : -1;
            return position.get(a)! - position.get(b)!;
        });
    }
    return { candidates: sticky ? [sticky, ...rest] : rest };
}

/** Structural mirror of the Usage package's limits service (never imported). */
export interface RelayLimitsSource {
    snapshots(): readonly {
        providerId: string;
        windows: readonly { used: number; limit: number; unit: string; label?: string; resetsAt?: number }[];
    }[] | Promise<readonly {
        providerId: string;
        windows: readonly { used: number; limit: number; unit: string; label?: string; resetsAt?: number }[];
    }[]>;
}
/** The host wiring Relay needs and the family helper cannot reach: set by the
 *  harness package on enable, read lazily on every plan. */
export const relayHost: { limits: () => RelayLimitsSource | undefined } = { limits: () => undefined };

/** Percent windows per member harness id; absent member = unknown reading. */
export async function readRelayHeadroom(members: readonly string[]): Promise<Map<string, RelayHeadroom>> {
    const out = new Map<string, RelayHeadroom>();
    let rows: Awaited<ReturnType<RelayLimitsSource["snapshots"]>> | undefined;
    try {
        rows = await relayHost.limits()?.snapshots();
    } catch {
        rows = undefined;
    }
    if (!rows) return out;
    for (const id of members) {
        const row = rows.find((candidate) => candidate.providerId === id);
        const windows = row?.windows.filter((window) => window.unit === "percent" && Number.isFinite(window.used) && Number.isFinite(window.limit)) ?? [];
        if (row && windows.length) {
            out.set(id, { known: true, windows: windows.map(({ used, limit, resetsAt, label }) => ({ used, limit, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(label ? { label } : {}) })) });
        }
    }
    return out;
}

export const tightestWindow = (reading: RelayHeadroom | undefined): { label: string; remaining: number; resetsAt?: number } | undefined => {
    if (!reading?.known || reading.windows.length === 0) return undefined;
    let index = 0;
    reading.windows.forEach((window, i) => { if (remainingOf(window) < remainingOf(reading.windows[index]!)) index = i; });
    const window = reading.windows[index]!;
    return {
        label: window.label ?? "",
        remaining: Math.max(0, Math.min(1, remainingOf(window))),
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    };
};
