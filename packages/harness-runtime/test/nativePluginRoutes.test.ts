import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import type { HarnessProvider, HarnessRegistry, RouteRequest, SpaceContext } from "@polyth/contracts";
import type {
    HarnessNativePluginManager,
    NativePluginListDto,
    NativePluginMutationInput,
    NativePluginMutationResponseDto,
    NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { harnessRoutes } from "../src/serverEntry.ts";

const localSpace = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;
const projects = [
    { id: "p1", name: "Alpha", path: "/work/alpha", createdAt: 1, spaceId: "space-a" },
    { id: "p2", name: "Beta", path: "/work/beta", createdAt: 2, spaceId: "space-a" },
];

type Recorded = { context: string; input?: NativePluginMutationInput };

function manager(log: Recorded[], support: Partial<NativePluginSupportDto> = {}): HarnessNativePluginManager {
    const fullSupport: NativePluginSupportDto = {
        actions: ["install", "uninstall", "enable", "disable", "update"],
        installScopes: ["user", "project", "local"],
        installHint: "name@marketplace",
        applies: "next-session",
        marketplaces: false,
        ...support,
    };
    const list = (): NativePluginListDto => ({ harnessId: "fake", support: fullSupport, plugins: [], checkedAt: 1 });
    return {
        support: () => fullSupport,
        async list(context) {
            log.push({ context: `list:${context.projectId}:${context.cwd}` });
            return list();
        },
        async mutate(context, input) {
            log.push({ context: `mutate:${context.projectId}:${context.cwd}`, input });
            return { kind: "confirmed", value: { pendingRestart: false } };
        },
    };
}

/** Projects are Space-scoped: a foreign-Space id is simply absent here. */
function host(log: Recorded[], support?: Partial<NativePluginSupportDto>): ServerPackageHost {
    const services = createServerServiceRegistry();
    const providers: Record<string, Partial<HarnessProvider>> = { fake: { plugins: manager(log, support) } };
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => providers[id] ? { descriptor: { id }, ...providers[id] } : undefined,
        providers: () => Object.keys(providers).map((id) => ({ descriptor: { id }, ...providers[id] })),
        invalidate: () => {},
    } as unknown as HarnessRegistry);
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({
            projects: {
                async list() { return projects; },
                async get(id: string) { return projects.find((project) => project.id === id); },
            },
        }),
    } as unknown as ServerPackageHost;
}

async function call(target: ServerPackageHost, method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(`http://localhost${path}`);
    let result: unknown;
    const handled = await harnessRoutes(target)({
        path: url.pathname, method, url, space: localSpace, principal: { kind: "local-user" },
        body: async () => body,
        json(_status: number, value: unknown) { result = value; },
    } as unknown as RouteRequest);
    assert.equal(handled, true);
    return result;
}

const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected;
const install = { action: "install", plugin: "lint@market", confirm: true };

test("without a projectId the plugin routes use no project: never the first project, never the server's cwd", async () => {
    const log: Recorded[] = [];
    const target = host(log);
    const list = await call(target, "GET", "/api/harnesses/fake/plugins") as NativePluginListDto;
    assert.equal(list.project, undefined);
    await call(target, "POST", "/api/harnesses/fake/plugins", { ...install, scope: "user" });
    await call(target, "POST", "/api/harnesses/fake/plugins", install);
    assert.deepEqual(log.map((entry) => entry.context), [
        `list:__default__:${homedir()}`,
        `mutate:__default__:${homedir()}`,
        `list:__default__:${homedir()}`,
        `mutate:__default__:${homedir()}`,
        `list:__default__:${homedir()}`,
    ]);
    assert.ok(!log.some((entry) => entry.context.includes("/work/")), "the first project is never used");
});

test("project and local scopes without a project are refused before the harness is asked to change anything", async () => {
    const log: Recorded[] = [];
    const target = host(log);
    for (const scope of ["project", "local"]) {
        for (const action of ["install", "uninstall", "update", "enable", "disable"]) {
            await assert.rejects(call(target, "POST", "/api/harnesses/fake/plugins", { ...install, action, scope }), (error: Error & { code?: string }) => {
                assert.equal(error.code, "invalid-input");
                assert.equal(error.message, "Choose a project to install plugins for it.");
                return true;
            });
        }
    }
    assert.deepEqual(log, [], "no mutate and no list");
});

test("an explicit project is used and named in the list; an unknown or foreign-Space id is not found", async () => {
    const log: Recorded[] = [];
    const target = host(log);
    const list = await call(target, "GET", "/api/harnesses/fake/plugins?projectId=p2") as NativePluginListDto;
    assert.deepEqual(list.project, { id: "p2", name: "Beta", path: "/work/beta" });
    const response = await call(target, "POST", "/api/harnesses/fake/plugins?projectId=p2", { ...install, scope: "project" }) as NativePluginMutationResponseDto;
    assert.equal(response.outcome, "confirmed");
    assert.deepEqual(response.list?.project, { id: "p2", name: "Beta", path: "/work/beta" });
    assert.deepEqual(log.map((entry) => entry.context), ["list:p2:/work/beta", "mutate:p2:/work/beta", "list:p2:/work/beta"]);
    assert.equal("project" in (log[1]!.input as object), false, "the project DTO is not forwarded to the harness");

    for (const id of ["missing", "foreign-space-project"]) {
        await assert.rejects(call(target, "GET", `/api/harnesses/fake/plugins?projectId=${id}`), (error: Error & { code?: string }) => {
            assert.equal(error.code, "not-found");
            assert.equal(error.message, "project not found");
            return true;
        });
        await assert.rejects(call(target, "POST", `/api/harnesses/fake/plugins?projectId=${id}`, { ...install, scope: "user" }), code("not-found"));
    }
    assert.equal(log.length, 3);
});

test("install options are validated, bounded and forwarded only when the harness accepts them", async () => {
    const log: Recorded[] = [];
    const target = host(log, { installOptions: true });
    const secret = "sk-very-secret-value";
    const options = { apiKey: secret, nested: { level: 2 } };
    const response = await call(target, "POST", "/api/harnesses/fake/plugins", { ...install, scope: "user", options }) as NativePluginMutationResponseDto;
    assert.equal(response.outcome, "confirmed");
    assert.deepEqual(log[0]!.input, { action: "install", plugin: "lint@market", scope: "user", options });
    assert.ok(!JSON.stringify(response).includes(secret), "options never come back in the response");

    const refusals: Array<[Record<string, unknown>, string]> = [
        [{ ...install, options: [secret] }, "invalid-input"],
        [{ ...install, options: secret }, "invalid-input"],
        [{ ...install, options: null }, "invalid-input"],
        [{ ...install, options: { blob: `${secret}${"x".repeat(16 * 1024)}` } }, "invalid-input"],
        [{ ...install, action: "update", options: { apiKey: secret } }, "invalid-input"],
    ];
    for (const [body, expected] of refusals) {
        await assert.rejects(call(target, "POST", "/api/harnesses/fake/plugins", body), (error: Error & { code?: string }) => {
            assert.equal(error.code, expected);
            assert.ok(!error.message.includes(secret), "the error never echoes the options");
            return true;
        });
    }
    // Just under the bound is accepted.
    await call(target, "POST", "/api/harnesses/fake/plugins", { ...install, options: { blob: "x".repeat(16 * 1024 - 20) } });
    assert.equal(log.filter((entry) => entry.context.startsWith("mutate:")).length, 2);

    const plain = host(log, { installOptions: false });
    await assert.rejects(call(plain, "POST", "/api/harnesses/fake/plugins", { ...install, options: { apiKey: secret } }), (error: Error & { code?: string }) => {
        assert.equal(error.code, "unsupported");
        assert.ok(!error.message.includes(secret));
        return true;
    });
    assert.equal(log.filter((entry) => entry.context.startsWith("mutate:")).length, 2);
});
