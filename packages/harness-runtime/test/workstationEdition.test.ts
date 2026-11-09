// The workstation edition downloads no harness installer, no Node.js runtime
// and no harness release list (docs/security/workstation-edition.md). The
// standard edition keeps every route as it was; the edition comes from the
// environment, so each case sets and restores it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EDITION_UNAVAILABLE_CODE } from "@polyth/contracts/edition";
import type {
    HarnessDescriptor,
    HarnessInstallDto,
    HarnessRegistry,
    HarnessUpdateStatus,
    RouteRequest,
    SpaceContext,
} from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { harnessRoutes } from "../src/serverEntry.ts";
import { createHarnessUpdateChecker } from "../src/updates.ts";
import type { HarnessInstallJobs } from "../src/installJobs.ts";

const space = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir: "/tmp/polyth-space-a",
} as SpaceContext;

const descriptor: HarnessDescriptor = {
    id: "codex",
    name: "Codex",
    integration: "test",
    priority: 0,
    installCommand: "npm install -g example-cli",
    updateCommand: ["codex", "update"],
    releaseSource: { kind: "npm", package: "@openai/codex" },
};

function host(installed = true): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        providers: () => [{ descriptor }],
        get: (id: string) => (id === descriptor.id ? { descriptor, versionStore: undefined } : undefined),
        invalidate: () => undefined,
        async snapshots() {
            return [{ identity: { id: descriptor.id, version: "codex-cli 0.160.0" }, availability: { installed } }];
        },
    } as unknown as HarnessRegistry);
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/polyth-test/${value}` }),
        forSpace: () => ({
            projects: {
                async list() { return []; },
                async get(id: string) { return { id, path: `/projects/${id}` }; },
            },
        }),
    } as unknown as ServerPackageHost;
}

function fakeInstalls(started: string[]): HarnessInstallJobs {
    return {
        get: () => undefined,
        cancel: async () => null,
        start: (input: { key: string }) => {
            started.push(input.key);
            return { id: "job-1", harnessId: descriptor.id, harnessName: descriptor.name, phase: "running", startedAt: 0, output: "" } as unknown as HarnessInstallDto;
        },
    } as unknown as HarnessInstallJobs;
}

async function call(
    routes: ReturnType<typeof harnessRoutes>,
    method: string,
    path: string,
    body: Record<string, unknown> = {},
): Promise<unknown> {
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    await routes({
        path: url.pathname,
        method,
        url,
        space,
        principal: { kind: "local-user", userId: "user-a" },
        ingress: { kind: "public-http", loopback: true },
        requireCapability: () => {},
        body: async () => body,
        json(_status: number, value: unknown) { payload = value; },
        res: { writeHead: () => {}, end: () => {} },
    } as unknown as RouteRequest);
    return payload;
}

async function withEdition<T>(edition: string | undefined, run: () => Promise<T>): Promise<T> {
    const previous = process.env.POLYTH_EDITION;
    if (edition === undefined) delete process.env.POLYTH_EDITION;
    else process.env.POLYTH_EDITION = edition;
    try {
        return await run();
    }
    finally {
        if (previous === undefined) delete process.env.POLYTH_EDITION;
        else process.env.POLYTH_EDITION = previous;
    }
}

/** Fails the test when anything reaches the network while it runs. */
async function withoutNetwork<T>(run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
        calls.push(String(input));
        throw new Error("the workstation edition must not reach the network");
    }) as typeof fetch;
    try {
        const result = await run();
        assert.deepEqual(calls, [], "no network request");
        return result;
    }
    finally {
        globalThis.fetch = original;
    }
}

const isEditionRefusal = (error: Error & { code?: string; status?: number }): boolean => {
    assert.equal(error.code, EDITION_UNAVAILABLE_CODE);
    assert.equal(error.status, 403);
    return true;
};

test("workstation: POST /api/harnesses/codex/install refuses before any download", async () => {
    const started: string[] = [];
    const routes = harnessRoutes(host(), fakeInstalls(started));
    await withEdition("workstation", () => withoutNetwork(async () => {
        await assert.rejects(() => call(routes, "POST", "/api/harnesses/codex/install"), isEditionRefusal);
        assert.deepEqual(started, [], "no install job was started");
    }));
});

test("standard: the same install POST still starts the background install", async () => {
    const started: string[] = [];
    const routes = harnessRoutes(host(), fakeInstalls(started));
    const job = await withEdition(undefined, () => call(routes, "POST", "/api/harnesses/codex/install")) as { id?: string };
    assert.equal(job.id, "job-1");
    assert.deepEqual(started, ["local:codex"]);
});

test("workstation: the install preview still names the command a person runs themselves", async () => {
    const routes = harnessRoutes(host(), fakeInstalls([]));
    const preview = await withEdition("workstation", () => call(routes, "GET", "/api/harnesses/codex/install")) as {
        preview?: { command?: string; target?: string };
    };
    assert.equal(preview.preview?.command, "npm install -g example-cli");
    assert.equal(preview.preview?.target, "local");
});

test("workstation: installing through a setup terminal and the harness self-update are refused", async () => {
    const routes = harnessRoutes(host(), fakeInstalls([]));
    await withEdition("workstation", () => withoutNetwork(async () => {
        await assert.rejects(
            () => call(routes, "GET", "/api/harnesses/codex/setup-terminal?action=install"),
            isEditionRefusal,
        );
        await assert.rejects(
            () => call(routes, "POST", "/api/harnesses/codex/update"),
            isEditionRefusal,
        );
    }));
});

test("workstation: the update checker asks no registry and Settings offers no update action", async () => {
    await withEdition("workstation", () => withoutNetwork(async () => {
        const checker = createHarnessUpdateChecker();
        const answer = await checker.latest({ kind: "npm", package: "@openai/codex" });
        assert.equal(answer.version, undefined);
        assert.ok(answer.error, "reports the edition, not a release");

        const routes = harnessRoutes(host(), fakeInstalls([]));
        const rows = await call(routes, "GET", "/api/harnesses/updates?projectId=p1") as HarnessUpdateStatus[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.harnessId, "codex");
        assert.equal(rows[0]?.available, false);
        assert.equal(rows[0]?.canUpdate, false, "no update button in this edition");
        assert.equal(rows[0]?.reason, "unavailable");
    }));
});

test("standard: the update checker still reads the npm registry", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ version: "0.162.1" }), { status: 200 });
    }) as typeof fetch;
    try {
        const answer = await withEdition(undefined, () => createHarnessUpdateChecker().latest({ kind: "npm", package: "@openai/codex" }));
        assert.equal(answer.version, "0.162.1");
        assert.deepEqual(calls, ["https://registry.npmjs.org/@openai%2fcodex/latest"]);
    }
    finally {
        globalThis.fetch = original;
    }
});
