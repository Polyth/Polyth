import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, HarnessContext, HarnessProvider, SessionProjection, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { bindPackageServices, createServerServiceRegistry, serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createHarnessPool, createHarnessRegistry, type HarnessPreferences } from "../src/index.ts";
import { harnessRoutes } from "../src/serverEntry.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp" };
const session = (over: Partial<SessionProjection> = {}): SessionProjection =>
    ({ id: "session", projectId: "p", title: "t", createdAt: 0, updatedAt: 0, status: "idle", ...over }) as SessionProjection;

/** A provider that records the context each runtime was created with. */
const provider = (id: string, priority: number, supportsPrivate: boolean, launched: HarnessContext[]): HarnessProvider => ({
    descriptor: { id, name: id === "local" ? "Local" : id, priority, integration: "test", ...(supportsPrivate ? { privateSessions: true as const } : {}) },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    createRuntime: async (launch) => {
        launched.push(launch);
        return { dispose: async () => {} } as AgentRuntime;
    },
});

const setup = (preferences: HarnessPreferences) => {
    const launched: HarnessContext[] = [];
    const registry = createHarnessRegistry();
    registry.register(provider("claude", 0, true, launched));
    registry.register(provider("local", 10, false, launched));
    let current = preferences;
    registry.configurePolicy(async () => current);
    const pool = createHarnessPool({
        registry,
        legacyHarnessId: "claude",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, ...(sessionId ? { sessionId } : {}) }),
    });
    return { registry, pool, launched, setPreferences: (next: HarnessPreferences) => { current = next; } };
};

test("a snapshot reports the private-sessions preference only for a harness that supports it, without a new probe", async () => {
    const { registry, setPreferences } = setup({ claude: { privateSessions: false }, local: { privateSessions: true } });
    const before = await registry.snapshots(context);
    assert.equal(before.find((row) => row.identity.id === "claude")?.policy.privateSessions, false);
    assert.equal("privateSessions" in before.find((row) => row.identity.id === "local")!.policy, false);
    setPreferences({ claude: { privateSessions: true } });
    const after = await registry.snapshots(context);
    assert.equal(after.find((row) => row.identity.id === "claude")?.policy.privateSessions, true);
    // Same cached probe revision: only the preference overlay changed.
    assert.equal(after[0]?.context.revision, before[0]?.context.revision);
    assert.equal(await registry.privateSessions(context, "claude"), true);
    assert.equal(await registry.privateSessions(context, "local"), false, "no support, no private session");
});

test("a new conversation on a harness with private sessions on runs private and is marked", async () => {
    const { pool, launched } = setup({ claude: { privateSessions: true } });
    const runtime = await pool.forSession(session(), "/tmp");
    assert.equal(launched.at(-1)?.privateSession, true);
    assert.equal(runtime.privateSession, true);
    assert.equal(runtime.harnessId, "claude");
    await pool.dispose();
});

test("private sessions off, or a harness without support, keeps the ordinary launch", async () => {
    const off = setup({});
    assert.equal((await off.pool.forSession(session(), "/tmp")).privateSession, undefined);
    assert.equal(off.launched.at(-1)?.privateSession, undefined);
    await off.pool.dispose();

    const unsupported = setup({ local: { privateSessions: true } });
    const runtime = await unsupported.pool.forSession(session({ harness: { mode: "pinned", harnessId: "local" } }), "/tmp");
    assert.equal(runtime.harnessId, "local");
    assert.equal(runtime.privateSession, undefined);
    await unsupported.pool.dispose();
});

test("turning private sessions on never changes a conversation that already has a native leg", async () => {
    const { pool, launched } = setup({ claude: { privateSessions: true } });
    await pool.forSession(session({ resolvedHarnessId: "claude", backendSessionId: "native-1" }), "/tmp");
    assert.equal(launched.at(-1)?.privateSession, undefined);
    await pool.dispose();
});

test("a private session stays private with the preference off and never reaches a harness that would save it", async () => {
    const { pool, launched } = setup({});
    const sticky = session({ privateSession: true, resolvedHarnessId: "claude", backendSessionId: "native-1" });
    assert.equal((await pool.forSession(sticky, "/tmp")).privateSession, true);
    assert.equal(launched.at(-1)?.privateSession, true);

    await assert.rejects(pool.forSession(sticky, "/tmp", "local"), (error: Error & { code?: string }) =>
        error.code === "unsupported" && /Local can't run a private session/.test(error.message));
    await assert.rejects(pool.resolve(sticky, "/tmp", { mode: "pinned", harnessId: "local" }), { code: "unsupported" });
    // Auto passes over the harness that cannot honour it.
    assert.equal(await pool.resolve({ ...sticky, resolvedHarnessId: undefined }, "/tmp", { mode: "auto" }), "claude");
    await pool.dispose();
});

test("Auto for a private session with no supporting harness says why", async () => {
    const launched: HarnessContext[] = [];
    const registry = createHarnessRegistry();
    registry.register(provider("local", 0, false, launched));
    await assert.rejects(registry.resolve({ ...context, privateSession: true }, { mode: "auto" }),
        /No harness that can run a private session is ready/);
});

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

const roots: string[] = [];
test.after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function routeFixture() {
    const root = await mkdtemp(join(tmpdir(), "polyth-harness-private-sessions-"));
    roots.push(root);
    const space = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", storageDir: root } as SpaceContext;
    const storage: SpaceStorage = { root, packageDir: (packageId) => join(root, "packages", packageId), path: (relative) => join(root, relative) };
    const registry = createHarnessRegistry();
    registry.register(provider("claude", 0, true, []));
    registry.register(provider("local", 10, false, []));
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey("harnesses"), registry);
    const host = {
        pluginId: "harness-runtime",
        services: bindPackageServices(services, "harness-runtime"),
        spaceStorage: () => storage,
        forSpace: () => ({ projects: { list: async () => [], get: async () => undefined }, sessions: {} }),
    } as unknown as ServerPackageHost;
    const route = harnessRoutes(host);
    const invoke = async (path: string, body: unknown, principal: unknown = { kind: "local-user" }) => {
        let status = 0;
        let responseBody: unknown;
        const url = new URL(path, "http://localhost");
        const request = {
            path: url.pathname, method: "PUT", url, space, principal,
            body: async () => body,
            json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
        } as RouteRequest;
        await route(request);
        return { status, body: responseBody };
    };
    const stored = async () => JSON.parse(await readFile(join(root, "harnesses", "preferences.json"), "utf8")) as unknown;
    return { root, invoke, stored };
}

test("the private-sessions route saves the preference and routing updates keep it", async () => {
    const f = await routeFixture();
    await mkdir(join(f.root, "harnesses"), { recursive: true });
    await writeFile(join(f.root, "harnesses", "preferences.json"), JSON.stringify({ claude: { enabled: true, priority: 5, title: "Work" } }));

    const saved = await f.invoke("/api/harnesses/claude/private-sessions", { enabled: true });
    assert.deepEqual(saved, { status: 200, body: { enabled: true } });
    assert.deepEqual(await f.stored(), { claude: { enabled: true, priority: 5, title: "Work", privateSessions: true } });

    await f.invoke("/api/harnesses/preferences", { preferences: { claude: { enabled: true, priority: 0 }, local: { enabled: true, priority: 10 } } });
    assert.deepEqual(await f.stored(), {
        claude: { enabled: true, priority: 0, title: "Work", privateSessions: true },
        local: { enabled: true, priority: 10 },
    });

    await f.invoke("/api/harnesses/claude/private-sessions", { enabled: false });
    assert.deepEqual(await f.stored(), {
        claude: { enabled: true, priority: 0, title: "Work" },
        local: { enabled: true, priority: 10 },
    });
});

test("the private-sessions route refuses a harness without support, a bad value and a non-manager", async () => {
    const f = await routeFixture();
    await assert.rejects(f.invoke("/api/harnesses/local/private-sessions", { enabled: true }), { code: "unsupported" });
    await assert.rejects(f.invoke("/api/harnesses/claude/private-sessions", { enabled: "yes" }), { code: "invalid-input" });
    await assert.rejects(f.invoke("/api/harnesses/missing/private-sessions", { enabled: true }), { code: "not-found" });
    await assert.rejects(f.invoke("/api/harnesses/claude/private-sessions", { enabled: true }, { kind: "user", userId: "member" }), { code: "forbidden" });
});
