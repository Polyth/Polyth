// Browser-safe shapes of the Relay routes.
import type { HarnessRelayVendorPolicy } from "@polyth/contracts";
import type { RelayView } from "@polyth/harness-runtime/relay";

export const RELAYS_PATH = "/api/harness-relay/relays";
export const RELAY_FAMILIES_PATH = "/api/harness-relay/families";

/** One account family and whether its Relay is on. */
export interface RelayFamilyView {
    family: string;
    label: string;
    relayId: string;
    policy: HarnessRelayVendorPolicy;
    /** The family's Relay harness exists. Never `true` under `prohibited`. */
    enabled: boolean;
    /** The caller may turn it on or off. */
    editable: boolean;
    /** The caller may use enough of the family's accounts to rotate at all. */
    offered: boolean;
}

/** `GET /api/harness-relay/relays`: the caller's Relays (families that are on)
 *  and every family they may see. */
export interface RelaysResponse {
    relays: RelayView[];
    families: RelayFamilyView[];
}
