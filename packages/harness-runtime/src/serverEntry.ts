import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessRegistry, HarnessSelection, RouteHandler } from "@polyth/contracts";
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
            request.json(200, preferences);
            return true;
        }
        if (request.path === "/api/harnesses" && request.method === "GET") {
            const projectId = request.url.searchParams.get("projectId");
            const project = projectId ? await scoped.projects.get(projectId) : (await scoped.projects.list())[0];
            if (projectId && !project)
                throw harnessError("not-found", "project not found");
            const context = { space: request.space, spaceId: request.space.spaceId, projectId: project?.id ?? "__default__", cwd: project?.path ?? process.cwd(), remote: Boolean(project?.remote) };
            const [probes, preferences] = await Promise.all([registry.probe(context), readPreferences(preferenceFile)]);
            request.json(200, registry.providers().map((provider) => ({ ...provider.descriptor, enabled: preferences[provider.descriptor.id]?.enabled ?? true, priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority, ...probes.find((p) => p.harnessId === provider.descriptor.id) })));
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
        return false;
    };
}
export default function registerPackage(host: ServerPackageHost) {
    host.services.require(serverServiceKey<ReturnType<typeof createHarnessRegistry>>("harnesses")).configurePolicy(async (context) => context.space ? readPreferences(host.spaceStorage(context.space).path("harnesses/preferences.json")) : {});
    return { routes: harnessRoutes(host), remoteAccess: localOnlyRemoteAccess(["harnesses"]) };
}
