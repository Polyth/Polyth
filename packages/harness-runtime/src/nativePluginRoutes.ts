// Generic routes over a harness provider's own plugin system. Vendor argv and
// parsing stay in each backend's `plugins` manager; this file owns only the
// authority gates, input validation, serialization and the response shape.
import { randomUUID } from "node:crypto";
import type {
    HarnessContext,
    HarnessRegistry,
    SpaceContext,
} from "@polyth/contracts";
import type {
    NativePluginAction,
    NativePluginListDto,
    NativePluginMutationResponseDto,
    NativePluginScope,
} from "@polyth/contracts/capability-installations";
import { requireInstanceOwnerAuthority, type InstanceAuthorityRequest } from "@polyth/contracts/instance-authority";
import { harnessError } from "./index.ts";
import { nativePluginMutex, nativePluginRefError } from "./nativePlugins.ts";

const ACTIONS: readonly NativePluginAction[] = ["install", "uninstall", "enable", "disable", "update"];
const SCOPES: readonly NativePluginScope[] = ["user", "project", "local", "synced", "managed"];
const PATH = /^\/api\/harnesses\/([a-z][a-z0-9-]*)\/plugins$/;
/** Scopes written inside a project's own folder. */
const PROJECT_SCOPES: readonly NativePluginScope[] = ["project", "local"];
const MAX_OPTIONS_BYTES = 16 * 1024;

export type NativePluginRouteProject = NonNullable<NativePluginListDto["project"]>;

export interface NativePluginRouteRequest extends InstanceAuthorityRequest {
    method: string;
    path: string;
    space: SpaceContext;
    body(): Promise<Record<string, unknown>>;
    json(status: number, value: unknown): void;
}

export interface NativePluginRouteDeps {
    registry: Pick<HarnessRegistry, "get" | "invalidate">;
    /** The request's context. `project` is set only for a project the request
     * named explicitly; without one, project scopes cannot be changed. */
    context(): Promise<HarnessContext & { project?: NativePluginRouteProject }>;
    /** Shared across requests so two mutations of one harness never overlap. */
    mutex?: ReturnType<typeof nativePluginMutex>;
}

const isAction = (value: unknown): value is NativePluginAction =>
    typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
const isScope = (value: unknown): value is NativePluginScope =>
    typeof value === "string" && (SCOPES as readonly string[]).includes(value);

/** Native plugin scopes are host-wide (the harness's own home), never a
 * tenant's data, so a sandboxed hosted deployment exposes none of them. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
};

/** Byte size of the options as JSON, or undefined when they cannot be
 * serialized. The value itself never reaches an error message. */
const jsonBytes = (value: unknown): number | undefined => {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
    }
    catch {
        return undefined;
    }
};

const refuseSandboxed = (space: SpaceContext): void => {
    if (space.deployment === "multi-tenant-sandboxed")
        throw harnessError("forbidden", "native harness plugins are unavailable in a sandboxed deployment");
};

const withProject = (list: NativePluginListDto, project: NativePluginRouteProject | undefined): NativePluginListDto => {
    const { project: _ignored, ...rest } = list;
    return project ? { ...rest, project } : rest;
};

export function createNativePluginRoutes(): (request: NativePluginRouteRequest, deps: Omit<NativePluginRouteDeps, "mutex">) => Promise<boolean> {
    const mutex = nativePluginMutex();
    return (request, deps) => handleNativePluginRequest(request, { ...deps, mutex });
}

export async function handleNativePluginRequest(request: NativePluginRouteRequest, deps: NativePluginRouteDeps): Promise<boolean> {
    const match = request.path.match(PATH);
    if (!match || (request.method !== "GET" && request.method !== "POST"))
        return false;
    const provider = deps.registry.get(match[1]!);
    if (!provider)
        throw harnessError("not-found", "harness not found");
    const harnessId = provider.descriptor.id;
    if (request.method === "GET") {
        refuseSandboxed(request.space);
        if (!provider.plugins)
            throw harnessError("unsupported", "this harness has no plugin system Polyth can read");
        const { project, ...context } = await deps.context();
        const list: NativePluginListDto = await provider.plugins.list(context);
        request.json(200, withProject(list, project));
        return true;
    }
    requireInstanceOwnerAuthority(request, "managing harness plugins requires the instance owner");
    refuseSandboxed(request.space);
    const { project, ...context } = await deps.context();
    if (context.remote)
        throw harnessError("unsupported", "harness plugins can only be managed for local projects");
    const input = await request.body();
    if (!isAction(input.action))
        throw harnessError("invalid-input", "unknown plugin action");
    if (typeof input.plugin !== "string")
        throw harnessError("invalid-input", "plugin reference is required");
    const refError = nativePluginRefError(input.plugin);
    if (refError)
        throw harnessError("invalid-input", refError);
    if (input.scope !== undefined && !isScope(input.scope))
        throw harnessError("invalid-input", "unknown plugin scope");
    // A plugin runs third-party code on this host; the client must have shown
    // that and sent an explicit confirmation.
    if (input.confirm !== true)
        throw harnessError("invalid-input", "plugin changes require explicit confirmation");
    const plugins = provider.plugins;
    if (!plugins?.mutate)
        throw harnessError("unsupported", "this harness's plugins cannot be managed from Polyth");
    const support = plugins.support(context);
    if (!support.actions.includes(input.action))
        throw harnessError("unsupported", `this harness does not support "${input.action}" for plugins`);
    if (input.action === "install" && input.scope !== undefined && !support.installScopes.includes(input.scope))
        throw harnessError("unsupported", `this harness cannot install plugins in the "${input.scope}" scope`);
    // A project scope is written into a folder; never guess which one.
    const scope = input.scope as NativePluginScope | undefined;
    if (scope && PROJECT_SCOPES.includes(scope) && !project)
        throw harnessError("invalid-input", "Choose a project to install plugins for it.");
    // Options may hold credentials: errors describe them, never echo them.
    let options: Record<string, unknown> | undefined;
    if (input.options !== undefined) {
        if (input.action !== "install")
            throw harnessError("invalid-input", "plugin options are only accepted when installing");
        if (!support.installOptions)
            throw harnessError("unsupported", "this harness does not accept plugin options");
        if (!isPlainObject(input.options))
            throw harnessError("invalid-input", "plugin options must be a JSON object");
        const bytes = jsonBytes(input.options);
        if (bytes === undefined || bytes > MAX_OPTIONS_BYTES)
            throw harnessError("invalid-input", `plugin options must be a JSON object up to ${MAX_OPTIONS_BYTES / 1024} KB`);
        options = input.options;
    }
    const action = input.action;
    const plugin = input.plugin;
    const mutex = deps.mutex ?? nativePluginMutex();
    const response = await mutex(harnessId, async (): Promise<NativePluginMutationResponseDto> => {
        const operationId = randomUUID();
        // The native outcome travels in the body: a refused command is a
        // known result, never an unconfirmed mutation.
        const outcome = await plugins.mutate!(context, { action, plugin, ...(scope ? { scope } : {}), ...(options ? { options } : {}) }, { operationId });
        deps.registry.invalidate({ harnessId });
        let list: NativePluginListDto | undefined;
        try {
            list = withProject(await plugins.list(context), project);
        }
        catch {
            list = undefined;
        }
        if (outcome.kind === "confirmed") {
            return {
                outcome: "confirmed",
                operationId,
                pendingRestart: outcome.value.pendingRestart,
                ...(outcome.value.message ? { message: outcome.value.message } : {}),
                ...(list ? { list } : {}),
            };
        }
        if (outcome.kind === "rejected") {
            return { outcome: "rejected", operationId, code: outcome.code, message: outcome.message, pendingRestart: false, ...(list ? { list } : {}) };
        }
        return { outcome: "unknown", operationId: outcome.operationId, message: outcome.message, pendingRestart: false, ...(list ? { list } : {}) };
    });
    request.json(200, response);
    return true;
}
