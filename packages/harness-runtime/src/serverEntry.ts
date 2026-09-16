import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
    AgentCapabilityContribution,
    AgentCapabilityContributionRegistry,
    AgentCapabilityDescriptor,
    Disposable,
    HarnessContext,
    HarnessProvisioningQuery,
    HarnessRegistry,
    HarnessSelection,
    HarnessSnapshot,
    JsonValue,
    RouteHandler,
} from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry, type HarnessPreferences, harnessError } from "./index.ts";
import { promptPrefixDiagnostics } from "./promptPrefixDiagnostics.ts";

const MAX_HARNESS_SYSTEM_PROMPT = 64 * 1024;
type StoredHarnessPreference = {
    enabled?: boolean;
    priority?: number;
    systemPrompt?: string;
};
type StoredHarnessPreferences = Record<string, StoredHarnessPreference>;
type HarnessSystemPromptDescriptor = AgentCapabilityDescriptor & { targetHarnessId: string };
type ContextualCapabilityContribution = AgentCapabilityContribution & {
    resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};
type HarnessProvisioningDiagnostics = HarnessProvisioningQuery & {
    desired?(context: HarnessContext): Promise<AgentCapabilityDescriptor[]>;
};

export function readHarnessSelection(value: unknown): HarnessSelection {
    if (value && typeof value === "object") {
        const input = value as Record<string, unknown>;
        if (input.mode === "auto")
            return { mode: "auto" };
        if (input.mode === "pinned" && typeof input.harnessId === "string" && /^[a-z][a-z0-9-]*$/.test(input.harnessId))
            return { mode: "pinned", harnessId: input.harnessId };
    }
    throw harnessError("invalid-input", "Choose Auto or a registered harness");
}
async function readPreferences(file: string): Promise<StoredHarnessPreferences> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as StoredHarnessPreferences;
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === "ENOENT")
            return {};
        throw error;
    }
}
function readPreferencesSync(file: string): StoredHarnessPreferences {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as StoredHarnessPreferences;
    }
    catch (error) {
        if ((error as { code?: string }).code === "ENOENT")
            return {};
        throw error;
    }
}
async function writePreferences(file: string, preferences: StoredHarnessPreferences): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
    await rename(temporary, file);
}
const prospectiveCandidate = (snapshot: HarnessSnapshot): boolean => {
    const state = snapshot.availability.state;
    return snapshot.policy.enabled
        && snapshot.policy.autoSelect
        && snapshot.availability.installed
        && snapshot.availability.healthy
        && snapshot.availability.authenticated !== false
        && (state === "ready" || state === "unknown");
};
export function harnessRoutes(host: ServerPackageHost): RouteHandler {
    return async (request) => {
        if (!request.path.startsWith("/api/harnesses"))
            return false;
        const scoped = host.forSpace(request.space);
        const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
        const preferenceFile = host.spaceStorage(request.space).path("harnesses/preferences.json");
        if (request.path === "/api/harnesses/preferences" && request.method === "PUT") {
            const input = await request.body();
            const existing = await readPreferences(preferenceFile);
            const preferences: StoredHarnessPreferences = {};
            for (const provider of registry.providers()) {
                const value = (input.preferences as HarnessPreferences | undefined)?.[provider.descriptor.id];
                if (!value)
                    continue;
                if (typeof value.enabled !== "boolean" || !Number.isInteger(value.priority) || Math.abs(value.priority!) > 10000)
                    throw harnessError("invalid-input", "Invalid harness preferences");
                const systemPrompt = existing[provider.descriptor.id]?.systemPrompt;
                preferences[provider.descriptor.id] = {
                    enabled: value.enabled,
                    priority: value.priority,
                    ...(typeof systemPrompt === "string" && systemPrompt.trim() ? { systemPrompt } : {}),
                };
            }
            await writePreferences(preferenceFile, preferences);
            registry.invalidate({ spaceId: request.space.spaceId });
            request.json(200, preferences);
            return true;
        }
        const contextForRequest = async () => {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            return { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
        };
        if (request.path === "/api/harnesses/roster" && request.method === "GET") {
            request.json(200, await registry.roster(await contextForRequest()));
            return true;
        }
        if (request.path === "/api/harnesses/snapshots" && request.method === "GET") {
            const context = await contextForRequest();
            let harnessId = request.url.searchParams.get("harnessId") ?? undefined;
            if (harnessId && !registry.providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            const detail = request.url.searchParams.get("detail") === "1";
            const force = request.url.searchParams.get("force") === "1";
            if (!harnessId && request.url.searchParams.get("auto") === "1") {
                const summaries = await registry.snapshots(context, { force });
                harnessId = summaries
                    .filter(prospectiveCandidate)
                    .toSorted((left, right) => left.policy.priority - right.policy.priority || left.identity.id.localeCompare(right.identity.id))[0]
                    ?.identity.id;
                if (!harnessId) {
                    request.json(200, []);
                    return true;
                }
            }
            request.json(200, await registry.snapshots(context, {
                ...(harnessId ? { harnessId } : {}),
                detail,
                force,
            }));
            return true;
        }
        if (request.path === "/api/harnesses" && request.method === "GET") {
            const context = await contextForRequest();
            const [probes, preferences] = await Promise.all([registry.probe(context), readPreferences(preferenceFile)]);
            request.json(200, registry.providers().map((provider) => ({ ...provider.descriptor, enabled: preferences[provider.descriptor.id]?.enabled ?? true, priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority, ...probes.find((p) => p.harnessId === provider.descriptor.id) })));
            return true;
        }
        if (request.path === "/api/harnesses/capabilities" && request.method === "GET") {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            const query = host.services.get(serverServiceKey<HarnessProvisioningQuery>("harness.provisioning"));
            if (!query) {
                request.json(200, []);
                return true;
            }
            const context = { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
            request.json(200, query.status(context));
            return true;
        }
        if (request.path === "/api/harnesses/prompt-prefix-diagnostics" && request.method === "GET") {
            const requestedProjectId = request.url.searchParams.get("projectId") ?? undefined;
            const sessionId = request.url.searchParams.get("sessionId") ?? undefined;
            const requestedHarnessId = request.url.searchParams.get("harnessId") ?? undefined;
            const session = sessionId ? await scoped.sessions.snapshot(sessionId) : undefined;
            if (requestedProjectId && session && session.projectId !== requestedProjectId)
                throw harnessError("invalid-input", "session does not belong to the requested project");
            const projectId = requestedProjectId ?? session?.projectId;
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            if (session && project && session.projectId !== project.id)
                throw harnessError("not-found", "session project not found in this Space");
            const resolvedHarnessId = session?.resolvedHarnessId
                ?? (session?.harness?.mode === "pinned" ? session.harness.harnessId : undefined);
            if (requestedHarnessId && resolvedHarnessId && requestedHarnessId !== resolvedHarnessId)
                throw harnessError("invalid-input", "requested harness does not match the session runtime");
            const harnessId = requestedHarnessId ?? resolvedHarnessId;
            if (harnessId && !registry.providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            const context: HarnessContext = {
                space: request.space,
                spaceId: request.space.spaceId,
                projectId: project?.id ?? "__default__",
                cwd: session?.worktreePath ?? project?.path ?? process.cwd(),
                remote: Boolean(project?.remote),
                ...(sessionId ? { sessionId } : {}),
            };
            const provisioning = host.services.get(
                serverServiceKey<HarnessProvisioningDiagnostics>("harness.provisioning"),
            );
            if (!provisioning?.desired)
                throw harnessError("unsupported", "prompt prefix diagnostics are unavailable");
            request.json(200, promptPrefixDiagnostics(await provisioning.desired(context), harnessId));
            return true;
        }
        const systemPrompt = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/system-prompt$/);
        if (systemPrompt && (request.method === "GET" || request.method === "PUT")) {
            const harnessId = systemPrompt[1]!;
            if (!registry.providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            if (request.method === "GET") {
                const preferences = await readPreferences(preferenceFile);
                request.json(200, { systemPrompt: preferences[harnessId]?.systemPrompt ?? "" });
                return true;
            }
            const input = await request.body();
            if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > MAX_HARNESS_SYSTEM_PROMPT || input.systemPrompt.includes("\0"))
                throw harnessError("invalid-input", `System prompt must be text up to ${MAX_HARNESS_SYSTEM_PROMPT} characters`);
            const preferences = await readPreferences(preferenceFile);
            const current = preferences[harnessId] ?? {};
            if (input.systemPrompt.trim()) {
                preferences[harnessId] = { ...current, systemPrompt: input.systemPrompt };
            }
            else {
                const { systemPrompt: _systemPrompt, ...rest } = current;
                if (Object.keys(rest).length)
                    preferences[harnessId] = rest;
                else
                    delete preferences[harnessId];
            }
            await writePreferences(preferenceFile, preferences);
            registry.invalidate({ spaceId: request.space.spaceId, harnessId });
            request.json(200, { systemPrompt: preferences[harnessId]?.systemPrompt ?? "" });
            return true;
        }
        const control = request.path.match(/^\/api\/harnesses\/([a-z][a-z0-9-]*)\/controls\/([^/]+)$/);
        if (control && request.method === "POST") {
            const provider = registry.providers().find((candidate) => candidate.descriptor.id === control[1]);
            if (!provider)
                throw harnessError("not-found", "harness not found");
            if (!provider.applyControl)
                throw harnessError("unsupported", "this harness has no editable generic controls");
            const context = await contextForRequest();
            const [snapshot] = await registry.snapshots(context, { harnessId: provider.descriptor.id, detail: true });
            const descriptor = snapshot?.configuration?.controls.find((candidate) => candidate.id === decodeURIComponent(control[2]!));
            if (!descriptor)
                throw harnessError("not-found", "harness control not found");
            if (descriptor.applySemantics === "read-only" || descriptor.available === false)
                throw harnessError("conflict", descriptor.unavailableReason ?? "harness control is read-only");
            const input = await request.body();
            await provider.applyControl(context, descriptor.id, input.value as JsonValue);
            registry.invalidate({ spaceId: context.spaceId, projectId: context.projectId, cwd: context.cwd, harnessId: provider.descriptor.id });
            request.json(200, (await registry.snapshots(context, { harnessId: provider.descriptor.id, detail: true, force: true }))[0]);
            return true;
        }
        if (request.path === "/api/harnesses/sessions" && request.method === "POST") {
            const input = await request.body();
            const project = typeof input.projectId === "string" ? await scoped.projects.get(input.projectId) : undefined;
            if (!project)
                throw harnessError("not-found", "project not found");
            const ref = await scoped.sessions.create({ projectId: project.id, harness: readHarnessSelection(input.selection) });
            request.json(200, await scoped.sessions.snapshot(ref.id));
            return true;
        }
        const featuresMatch = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)\/features$/);
        if (featuresMatch && request.method === "GET") {
            const features = scoped.sessions.runtimeFeatures;
            if (!features)
                throw harnessError("unsupported", "runtime features are unavailable");
            request.json(200, await features(featuresMatch[1]!));
            return true;
        }
        const match = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)$/);
        if (match && request.method === "POST") {
            const input = await request.body();
            if (!scoped.sessions.switchHarness)
                throw harnessError("unsupported", "harness switching is unavailable");
            if (input.timing !== undefined && input.timing !== "after-turn" && input.timing !== "stop-now")
                throw harnessError("invalid-input", "invalid switch timing");
            request.json(200, await scoped.sessions.switchHarness(match[1]!, readHarnessSelection(input.selection), input.timing as "after-turn" | "stop-now" | undefined));
            return true;
        }
        const cancel = request.path.match(/^\/api\/harnesses\/sessions\/([^/]+)\/cancel$/);
        if (cancel && request.method === "POST") {
            if (!scoped.sessions.cancelHarnessSwitch)
                throw harnessError("unsupported", "harness switch cancellation is unavailable");
            request.json(200, await scoped.sessions.cancelHarnessSwitch(cancel[1]!));
            return true;
        }
        return false;
    };
}

function harnessSystemPromptContribution(
    host: ServerPackageHost,
    registry: HarnessRegistry,
): ContextualCapabilityContribution {
    return {
        descriptor: {
            id: "harness-runtime.system-prompts",
            kind: "instruction",
            owner: "harness-runtime",
            scope: "deployment",
            revision: "1",
            title: "Harness system prompts",
            text: "",
        },
        resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[] {
            if (!context.space)
                return [];
            const preferences = readPreferencesSync(host.spaceStorage(context.space).path("harnesses/preferences.json"));
            return registry.providers().flatMap((provider) => {
                const text = preferences[provider.descriptor.id]?.systemPrompt;
                if (typeof text !== "string" || !text.trim() || text.length > MAX_HARNESS_SYSTEM_PROMPT)
                    return [];
                return [{
                    id: `harness-runtime.system-prompt.${provider.descriptor.id}`,
                    kind: "instruction",
                    owner: "harness-runtime",
                    scope: "space",
                    spaceId: context.spaceId,
                    revision: "1",
                    title: `${provider.descriptor.name} system prompt`,
                    text,
                    targetHarnessId: provider.descriptor.id,
                } as HarnessSystemPromptDescriptor];
            });
        },
    };
}

export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<ReturnType<typeof createHarnessRegistry>>("harnesses"));
    registry.configurePolicy(async (context) => context.space ? readPreferences(host.spaceStorage(context.space).path("harnesses/preferences.json")) : {});
    let promptContribution: Disposable | undefined;
    return {
        routes: harnessRoutes(host),
        remoteAccess: localOnlyRemoteAccess(["harnesses"]),
        onEnable() {
            if (promptContribution)
                return;
            const capabilities = host.services.require(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
            promptContribution = capabilities.register("harness-runtime", harnessSystemPromptContribution(host, registry));
        },
        onDisable() {
            const contribution = promptContribution;
            promptContribution = undefined;
            return contribution?.dispose();
        },
    };
}
