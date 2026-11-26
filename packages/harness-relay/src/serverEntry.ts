// Relay: rotate a harness family's signed-in accounts. This package owns the
// Relay harnesses (`<family>-relay`), which families have one, and the routes
// Settings and Usage read. Harness-runtime publishes the account families and
// names no package that rotates them.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Disposable, HarnessContext, RouteHandler } from "@polyth/contracts";
import { harnessUsableByUser, REMOTE_CAPABILITY } from "@polyth/contracts";
import { allowedHarnessesFor, hasHarnessManagerAuthority, requireHarnessManagerAuthority } from "@polyth/contracts/instance-authority";
import { harnessAccountFamilies, type HarnessAccountFamilyHandle } from "@polyth/harness-runtime/accounts";
import { localOnlyRemoteAccess, packageDataDir, serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { relayHost, type RelayLimitsSource } from "./chooser.ts";
import { createFamilyRelay, type FamilyRelay, type RelayActor } from "./family.ts";
import { RELAY_FAMILIES_PATH, RELAYS_PATH, type RelayFamilyView, type RelaysResponse } from "./views.ts";

/** Paired devices may read the person's Relays (Settings group, Usage pool):
 *  member account names and limit headroom only, the same names a chat reader
 *  already sees under each answer. Saving and the family switch stay local. */
export const HARNESS_RELAY_REMOTE_ACCESS = {
    ...localOnlyRemoteAccess(["harness-relay"]),
    http: [{ methods: ["GET"] as const, path: RELAYS_PATH, capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false }],
};

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Which families' Relay someone switched on or off; absent = never chosen.
 *  One file for the deployment: the accounts are logins on this host, and a
 *  suspension reaches everyone who shares them. */
export function createRelayChoices(file: string) {
    const read = async (): Promise<Record<string, boolean>> => {
        let text: string;
        try {
            text = await readFile(file, "utf8");
        } catch (error) {
            if ((error as { code?: unknown }).code === "ENOENT") return {};
            throw error;
        }
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    };
    let writing: Promise<void> = Promise.resolve();
    return {
        get: async (family: string): Promise<boolean | undefined> => (await read())[family],
        set: (family: string, enabled: boolean): Promise<void> => writing = writing.catch(() => {}).then(async () => {
            const next = { ...await read(), [family]: enabled };
            await mkdir(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, JSON.stringify(next, null, 2));
            await rename(tmp, file);
        }),
    };
}

interface LiveFamily {
    handle: HarnessAccountFamilyHandle;
    relay: FamilyRelay;
    /** Present while the family's Relay harness is registered. */
    registration?: Disposable;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
    const choices = createRelayChoices(join(packageDataDir(host), "families.json"));
    const live = new Map<string, LiveFamily>();
    let active = false;
    let unsubscribe: (() => void) | undefined;

    const wanted = async (handle: HarnessAccountFamilyHandle): Promise<boolean> => {
        if (handle.relayPolicy === "prohibited") return false;
        // Never chosen: a tolerated vendor's Relay is on, and a Relay people
        // already rotate (it predates this switch) stays on rather than
        // vanish under their running chats.
        return await choices.get(handle.family) ?? (handle.relayPolicy === "tolerated" || await handle.relayInUse());
    };
    /** Bring the registered Relay harnesses in line with the live families
     *  and their switches. Rejects with the first refusal: the registry keeps
     *  a harness that still holds session leases. */
    const apply = async () => {
        const handles = active ? harnessAccountFamilies.list() : [];
        const failures: unknown[] = [];
        for (const [family, entry] of live) {
            if (handles.includes(entry.handle)) continue;
            try {
                await entry.registration?.dispose();
                live.delete(family);
            } catch (error) {
                failures.push(error);
            }
        }
        for (const handle of handles) {
            let entry = live.get(handle.family);
            if (!entry) live.set(handle.family, entry = { handle, relay: createFamilyRelay(handle) });
            try {
                const on = await wanted(entry.handle);
                if (on && !entry.registration) entry.registration = entry.handle.registry().register(entry.relay.provider());
                else if (!on && entry.registration) {
                    await entry.registration.dispose();
                    entry.registration = undefined;
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) throw failures[0];
    };
    let applying: Promise<void> = Promise.resolve();
    const serial = (step: () => Promise<void>): Promise<void> => applying = applying.catch(() => {}).then(step);
    const reconcile = () => serial(apply);
    const warn = (error: unknown) => console.warn("[polyth] Relay harnesses could not all be applied", error);
    const follow = () => { unsubscribe ??= harnessAccountFamilies.subscribe(() => { void reconcile().catch(warn); }); };

    const routes: RouteHandler = async (request) => {
        if (!request.path.startsWith("/api/harness-relay/")) return false;
        // Per person: the actor is the gateway-validated `request.space`,
        // never the body. Another person's private account, a shared account
        // not open to this caller or Space, and a family outside this Space's
        // harness limits do not exist for them.
        const actor: RelayActor = { userId: request.space.userId, spaceId: request.space.spaceId, allowedHarnesses: allowedHarnessesFor(request) };
        const visible = (entry: LiveFamily) => harnessUsableByUser(
            entry.handle.registry().get(entry.relay.id)?.descriptor ?? { id: entry.relay.id },
            actor.userId, actor.allowedHarnesses, actor.spaceId,
        );
        const contextFor = async (): Promise<HarnessContext> => {
            const scoped = host.forSpace(request.space);
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project) throw coded("project not found", "not-found");
            return { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
        };
        const familyView = async (entry: LiveFamily): Promise<RelayFamilyView> => ({
            family: entry.relay.family,
            label: entry.relay.label,
            relayId: entry.relay.id,
            policy: entry.relay.policy,
            enabled: Boolean(entry.registration),
            editable: entry.relay.policy !== "prohibited" && hasHarnessManagerAuthority(request),
            offered: await entry.relay.offered(actor),
        });
        const familyPath = request.path.startsWith(`${RELAY_FAMILIES_PATH}/`) ? request.path.slice(RELAY_FAMILIES_PATH.length + 1) : "";
        // The switch is a deployment decision: the accounts at risk are shared.
        if (familyPath && request.method === "PUT") requireHarnessManagerAuthority(request);
        try {
            await applying.catch(() => {});
            const entries = [...live.values()].filter(visible);
            if (request.path === RELAYS_PATH && request.method === "GET") {
                const context = await contextFor();
                const body: RelaysResponse = {
                    relays: await Promise.all(entries.filter((entry) => entry.registration).map((entry) => entry.relay.view(actor, context))),
                    families: await Promise.all(entries.map(familyView)),
                };
                request.json(200, body);
                return true;
            }
            const relayId = request.path.startsWith(`${RELAYS_PATH}/`) ? request.path.slice(RELAYS_PATH.length + 1) : "";
            if (relayId && !relayId.includes("/") && request.method === "PUT") {
                const entry = entries.find((candidate) => candidate.registration && candidate.relay.id === relayId);
                if (!entry) throw coded("Relay not found", "not-found");
                request.json(200, await entry.relay.save(actor, await request.body(), await contextFor()));
                return true;
            }
            if (familyPath && !familyPath.includes("/") && request.method === "PUT") {
                const entry = entries.find((candidate) => candidate.relay.family === familyPath);
                if (!entry) throw coded("Harness not found", "not-found");
                const enabled = (await request.body() as { enabled?: unknown }).enabled;
                if (typeof enabled !== "boolean") throw coded("enabled must be true or false", "invalid-input");
                if (enabled && entry.relay.policy === "prohibited") throw coded(`${entry.relay.label} does not allow one person several accounts, so it has no Relay`, "invalid-input");
                // Off: the harness leaves first, so a refusal (chats still run
                // on it) changes nothing. On: the choice is stored first.
                await serial(async () => {
                    if (!enabled && entry.registration) {
                        await entry.registration.dispose();
                        entry.registration = undefined;
                    }
                    await choices.set(entry.relay.family, enabled);
                    if (enabled && active && !entry.registration && live.get(entry.relay.family) === entry) {
                        entry.registration = entry.handle.registry().register(entry.relay.provider());
                    }
                }).catch((error: unknown) => {
                    throw (error as { code?: unknown }).code ? error : coded(error instanceof Error ? error.message : String(error), "conflict");
                });
                request.json(200, await familyView(entry));
                return true;
            }
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            const status = code === "invalid-input" ? 400 : code === "not-found" ? 404 : code === "conflict" ? 409 : 500;
            request.json(status, { error: error instanceof Error ? error.message : String(error) });
            return true;
        }
        request.json(404, { error: "Not found" });
        return true;
    };

    return {
        routes,
        remoteAccess: HARNESS_RELAY_REMOTE_ACCESS,
        onEnable() {
            active = true;
            relayHost.limits = () => host.services.get(serverServiceKey<RelayLimitsSource>("usage-limits"));
            follow();
            return reconcile().catch(warn);
        },
        async onDisable() {
            active = false;
            unsubscribe?.();
            unsubscribe = undefined;
            try {
                await reconcile();
            } catch (error) {
                // Package lifecycle keeps an enabled descriptor when disable
                // fails; stay enabled so a retry can finish the job.
                active = true;
                follow();
                throw error;
            }
            relayHost.limits = () => undefined;
        },
    };
}
