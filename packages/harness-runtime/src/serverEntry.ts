import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessProvisioningQuery, HarnessRegistry, HarnessSelection, JsonValue, RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry, type HarnessPreferences, harnessError } from "./index.ts";
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
async function readPreferences(file: string): Promise<HarnessPreferences> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as HarnessPreferences;
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === "ENOENT")
            return {};
        throw error;
    }
}
export function harnessRoutes(host: ServerPackageHost): RouteHandler {
    return async (request) => {
        if (!request.path.startsWith("/api/harnesses"))
            return false;
        const scoped = host.forSpace(request.space);
        const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
        const preferenceFile = host.spaceStorage(request.space).path("harnesses/preferences.json");
        if (request.path === "/api/harnesses/preferences" && request.method === "PUT") {
            const input = await request.body();
            const preferences: HarnessPreferences = {};
            for (const provider of registry.providers()) {
                const value = (input.preferences as HarnessPreferences | undefined)?.[provider.descriptor.id];
                if (!value)
                    continue;
                if (typeof value.enabled !== "boolean" || !Number.isInteger(value.priority) || Math.abs(value.priority!) > 10000)
                    throw harnessError("invalid-input", "Invalid harness preferences");
                preferences[provider.descriptor.id] = { enabled: value.enabled, priority: value.priority };
            }
            await mkdir(dirname(preferenceFile), { recursive: true });
            const temporary = `${preferenceFile}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
            await rename(temporary, preferenceFile);
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
        if (request.path === "/api/harnesses/snapshots" && request.method === "GET") {
            const context = await contextForRequest();
            const harnessId = request.url.searchParams.get("harnessId") ?? undefined;
            if (harnessId && !registry.providers().some((provider) => provider.descriptor.id === harnessId))
                throw harnessError("not-found", "harness not found");
            request.json(200, await registry.snapshots(context, {
                ...(harnessId ? { harnessId } : {}),
                detail: request.url.searchParams.get("detail") === "1",
                force: request.url.searchParams.get("force") === "1",
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
export default function registerPackage(host: ServerPackageHost) {
    host.services.require(serverServiceKey<ReturnType<typeof createHarnessRegistry>>("harnesses")).configurePolicy(async (context) => context.space ? readPreferences(host.spaceStorage(context.space).path("harnesses/preferences.json")) : {});
    return { routes: harnessRoutes(host), remoteAccess: localOnlyRemoteAccess(["harnesses"]) };
}
