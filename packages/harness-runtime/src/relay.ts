// The rotation shapes the account store, the Accounts page and a package that
// rotates a family's accounts (Relay) share: one person's settings and the
// browser-safe views. Nothing here chooses an account or does I/O.
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

export interface RelaySettings {
    /** Ordered member harness ids. */
    members: string[];
    order: RelayOrder;
    handoverAt: number;
}
export const defaultRelaySettings = (): RelaySettings => ({ members: [], order: "expire-first", handoverAt: 0.05 });

/** Browser-safe views a rotating package serves. */
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
