// One family's Relay: a virtual harness (`<family>-relay`) that resolves to
// one of the acting person's member accounts, plus the views and the save its
// routes serve. Built on the family handle harness-runtime publishes; the
// person's member list stays in the family's account store.
import {
    harnessUsableByUser,
    type HarnessContext,
    type HarnessDescriptor,
    type HarnessDiscovery,
    type HarnessProbe,
    type HarnessProvider,
    type HarnessRelayPlan,
    type HarnessRelayVendorPolicy,
} from "@polyth/contracts";
import type { HarnessAccountFamilyHandle } from "@polyth/harness-runtime/accounts";
import {
    RELAY_HANDOVER_LEVELS,
    RELAY_MAX_MEMBERS,
    RELAY_MIN_MEMBERS,
    RELAY_ORDERS,
    type RelayMemberView,
    type RelaySettings,
    type RelayView,
} from "@polyth/harness-runtime/relay";
import { chooseRelayMembers, judgeMember, readRelayHeadroom, RELAY_DEFAULT_REFUSAL_MS, tightestWindow } from "./chooser.ts";

export interface RelayActor {
    userId: string;
    spaceId: string;
    allowedHarnesses: readonly string[] | null;
}
export interface FamilyRelay {
    id: string;
    family: string;
    label: string;
    policy: HarnessRelayVendorPolicy;
    view(actor: RelayActor, context: HarnessContext): Promise<RelayView>;
    save(actor: RelayActor, body: Record<string, unknown>, context: HarnessContext): Promise<RelayView>;
    /** The actor's Relay has `RELAY_MIN_MEMBERS` members they may use, so the
     *  harness list and the picker show it to them. Cheap: no member probes. */
    listed(actor: RelayActor): Promise<boolean>;
    /** The actor may use enough of the family's accounts to rotate at all. */
    offered(actor: RelayActor): Promise<boolean>;
    provider(): HarnessProvider;
}

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

export function createFamilyRelay(handle: HarnessAccountFamilyHandle): FamilyRelay {
    const { family, label } = handle;
    const relayId = `${family}-relay`;
    const refusedUntil = new Map<string, number>();
    const actorOf = (context: HarnessContext): RelayActor | undefined => {
        const userId = context.actorUserId ?? context.space?.userId;
        return userId ? {
            userId,
            spaceId: context.spaceId,
            allowedHarnesses: (context.space as { allowedHarnesses?: readonly string[] | null } | undefined)?.allowedHarnesses ?? null,
        } : undefined;
    };
    /** A registered harness of this family the actor may use here. */
    const accessible = (id: string, actor: RelayActor): HarnessDescriptor | undefined => {
        if (id === relayId) return undefined;
        const descriptor = handle.registry().get(id)?.descriptor;
        if (!descriptor || descriptor.accounts?.family !== family) return undefined;
        return harnessUsableByUser(descriptor, actor.userId, actor.allowedHarnesses, actor.spaceId) ? descriptor : undefined;
    };
    const probeReady = (probe: HarnessProbe) => probe.installed && probe.healthy && probe.authenticated !== false
        && !["starting", "auth-required", "setup-required", "partially-configured", "incompatible", "offline", "not-installed"].includes(probe.state ?? "");
    /** Which of `ids` are accessible, and of those which are signed in and
     *  healthy. Without `probe`, every accessible member counts as ready: the
     *  hot paths (a plan on every Relay send, the Relay's own probe) must not
     *  run member CLIs; the registry's cached readiness check rejects a
     *  signed-out member when it resolves the plan's candidates. */
    const usableOf = async (ids: readonly string[], actor: RelayActor, context: HarnessContext, probe = false) => {
        const open = ids.filter((id) => accessible(id, actor));
        if (!probe) return { open: new Set(open), ready: new Set(open) };
        const ready = new Set<string>();
        await Promise.all(open.map(async (id) => {
            try {
                if (probeReady(await handle.registry().get(id)!.probe(context))) ready.add(id);
            } catch { /* unreadable = not usable */ }
        }));
        return { open: new Set(open), ready };
    };
    const evaluate = async (context: HarnessContext, actor: RelayActor, settings: RelaySettings, sticky?: string, probe = false) => {
        const { open, ready } = await usableOf(settings.members, actor, context, probe);
        const members = settings.members.filter((id) => open.has(id));
        const headroom = await readRelayHeadroom(members);
        const input = { members, headroom, refusedUntil, usable: ready, ...(sticky ? { sticky } : {}), order: settings.order, handoverAt: settings.handoverAt, now: Date.now() };
        return { input, open, members, plan: chooseRelayMembers(input) };
    };
    const planFor = async (context: HarnessContext, stickyId?: string): Promise<HarnessRelayPlan> => {
        const actor = actorOf(context);
        if (!actor) return { candidates: [] };
        return (await evaluate(context, actor, await handle.relay(actor.userId), stickyId)).plan;
    };
    const listed = async (actor: RelayActor): Promise<boolean> =>
        (await handle.relay(actor.userId)).members.filter((id) => accessible(id, actor)).length >= RELAY_MIN_MEMBERS;
    const relayProvider = (): HarnessProvider => ({
        descriptor: {
            id: relayId,
            name: `${label} · Relay`,
            integration: "relay",
            priority: 1000,
            autoSelect: false,
            relay: { family, policy: handle.relayPolicy },
        },
        relay: {
            plan: planFor,
            refused: (harnessId, until) => { refusedUntil.set(harnessId, until ?? Date.now() + RELAY_DEFAULT_REFUSAL_MS); },
            listed,
        },
        probe: async (context): Promise<HarnessProbe> => {
            const actor = actorOf(context);
            const settings = actor ? await handle.relay(actor.userId) : undefined;
            const usable = actor && settings ? (await usableOf(settings.members, actor, context)).ready.size : 0;
            return usable > 0
                ? { harnessId: relayId, installed: true, authenticated: true, healthy: true, state: "ready" }
                : { harnessId: relayId, installed: true, authenticated: "unknown", healthy: true, state: "setup-required", message: "Add accounts to Relay in Settings" };
        },
        // The picker's model catalog is the first member Relay would run on now.
        discover: async (context): Promise<HarnessDiscovery> => {
            const actor = actorOf(context);
            if (!actor) return {};
            const settings = await handle.relay(actor.userId);
            const { plan, members } = await evaluate(context, actor, settings);
            const first = plan.candidates[0] ?? members[0];
            const target = first ? handle.registry().get(first) : undefined;
            if (!target?.discover) return {};
            const discovery = await target.discover(context);
            // The picker keeps only models owned by the harness it shows, so a
            // member's catalog is re-owned by the Relay; the member runtime
            // resolves the chosen model against its own catalog.
            const models = discovery.catalog?.models;
            return models
                ? { ...discovery, catalog: { ...discovery.catalog, models: models.map((model) => ({ ...model, harnessId: relayId })) } }
                : discovery;
        },
        createRuntime: async () => { throw coded(`${label} Relay resolves to one of its member accounts and runs no runtime of its own`, "runtime-unavailable"); },
    });
    const viewFor = async (actor: RelayActor, context: HarnessContext): Promise<RelayView> => {
        const accounts = await handle.accounts();
        const rows = [{ harnessId: family, ownerUserId: undefined as string | undefined }, ...accounts]
            .filter((row) => accessible(row.harnessId, actor));
        const settings = await handle.relay(actor.userId);
        // Settings and Usage read this on demand: probing shows signed-out members.
        const { input, open, members, plan } = await evaluate(context, actor, settings, undefined, true);
        const headroom = input.headroom;
        const position = new Map(members.map((id, index) => [id, index + 1] as const));
        const order = new Map(plan.candidates.map((id, index) => [id, index] as const));
        const memberViews: RelayMemberView[] = rows.map((row): RelayMemberView => {
            const id = row.harnessId;
            const included = open.has(id) && settings.members.includes(id);
            const judgement = judgeMember(input, id);
            const reading = headroom.get(id);
            const tightest = tightestWindow(reading);
            const rank = order.get(id);
            return {
                harnessId: id,
                name: handle.registry().get(id)?.descriptor.name ?? id,
                included,
                ...(included ? { position: position.get(id)! } : {}),
                state: !included ? "skipped"
                    : rank === 0 ? "now" : rank === 1 ? "next" : rank !== undefined ? "queued"
                    : judgement.reason === "signed-out" ? "skipped" : "exhausted",
                ...(included && !judgement.eligible && judgement.reason ? { reason: judgement.reason } : {}),
                ...(tightest ? { tightest } : {}),
                ...(included && judgement.until !== undefined ? { refillsAt: judgement.until } : {}),
                owner: row.ownerUserId === actor.userId ? "mine" : "shared",
            };
        });
        return {
            id: relayId,
            family,
            label,
            settings: { ...settings, members },
            limitsAvailable: headroom.size > 0,
            ...(plan.candidates.length === 0 && plan.exhaustedUntil !== undefined ? { exhaustedUntil: plan.exhaustedUntil } : {}),
            members: memberViews,
        };
    };
    return {
        id: relayId,
        family,
        label,
        policy: handle.relayPolicy,
        view: viewFor,
        save: async (actor, body, context) => {
            const bad = (message: string) => coded(message, "invalid-input");
            if (!Array.isArray(body.members) || body.members.length > RELAY_MAX_MEMBERS || body.members.some((id) => typeof id !== "string")) throw bad("members must be a list of up to 16 accounts");
            const members = body.members as string[];
            if (new Set(members).size !== members.length) throw bad("members must not repeat an account");
            // Unknown, foreign and forbidden accounts are indistinguishable.
            if (members.some((id) => !accessible(id, actor))) throw bad("Unknown or unavailable account");
            if (!RELAY_ORDERS.includes(body.order as never)) throw bad("order must be expire-first or manual");
            if (!RELAY_HANDOVER_LEVELS.includes(body.handoverAt as number)) throw bad("handoverAt must be 0.02, 0.05 or 0.1");
            await handle.setRelay(actor.userId, { members, order: body.order as RelaySettings["order"], handoverAt: body.handoverAt as number });
            return viewFor(actor, context);
        },
        listed,
        offered: async (actor) => [family, ...(await handle.accounts()).map((account) => account.harnessId)]
            .filter((id) => accessible(id, actor)).length >= RELAY_MIN_MEMBERS,
        provider: () => {
            const provider = relayProvider();
            // The Relay's own Settings page lists the family's accounts.
            Object.defineProperty(provider.descriptor, "accounts", { value: handle.ref, enumerable: true, configurable: true });
            return provider;
        },
    };
}
