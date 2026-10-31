import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessDescriptor, HarnessRegistry, HarnessUpdateStatus, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { harnessRoutes } from "../src/serverEntry.ts";
import { compareHarnessVersions, createHarnessUpdateChecker, parseHarnessVersion } from "../src/updates.ts";

const version = (text: string) => {
    const parsed = parseHarnessVersion(text);
    assert.ok(parsed, `parses ${text}`);
    return parsed;
};

test("parseHarnessVersion reads the first version token of each CLI's --version", () => {
    for (const [text, expected] of [
        ["codex-cli 0.160.0", "0.160.0"],
        ["opencode v2.0.29", "2.0.29"],
        ["2.1.300 (Claude Code)", "2.1.300"],
        ["2026.09.15-d2fe57e", "2026.09.15-d2fe57e"],
        ["grok 1.0.30 (04b7ffed98c6)", "1.0.30"],
        ["omp/18.1.20", "18.1.20"],
        ["1.82.3", "1.82.3"],
        ["0.85.1", "0.85.1"],
    ] as const)
        assert.equal(version(text).text, expected, text);
    assert.deepEqual(version("2026.09.15-d2fe57e").core, [2026, 9, 15]);
    assert.equal(version("2026.09.15-d2fe57e").suffix, "d2fe57e");
    assert.equal(parseHarnessVersion("no version here"), undefined);
    assert.equal(parseHarnessVersion("build 42"), undefined);
    assert.equal(parseHarnessVersion(undefined), undefined);
});

test("compareHarnessVersions orders cores numerically and only prereleases by suffix", () => {
    const cmp = (left: string, right: string) => Math.sign(compareHarnessVersions(version(left), version(right)));
    assert.equal(cmp("0.160.0", "0.162.1"), -1);
    assert.equal(cmp("0.85.1", "1.2.0"), -1, "major jump");
    assert.equal(cmp("2026.09.15-d2fe57e", "2026.10.14-941492e"), -1, "CalVer");
    assert.equal(cmp("2026.10.14-941492e", "2026.10.14-aaaaaaa"), 0, "build hashes do not order");
    assert.equal(cmp("1.2", "1.2.0"), 0, "missing parts are zero");
    assert.equal(cmp("1.2.0", "1.2.0-beta.1"), 1, "release beats prerelease");
    assert.equal(cmp("1.2.0-rc.1", "1.2.0"), -1);
    assert.equal(cmp("1.2.0-beta.2", "1.2.0-beta.10"), -1);
    assert.equal(cmp("1.2.0-alpha", "1.2.0-beta"), -1);
    assert.equal(cmp("2.1.300", "2.1.300"), 0);
});

type Call = { url: string; init?: RequestInit };
function fakeFetch(answers: Array<() => Response | Promise<Response>>, calls: Call[]): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const answer = answers.shift();
        if (!answer) throw new Error("unexpected fetch");
        return answer();
    }) as typeof fetch;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

test("npm lookups hit the per-tag manifest, cache for hours and floor force at 60 s", async () => {
    const calls: Call[] = [];
    let clock = 1_000_000;
    const checker = createHarnessUpdateChecker({
        fetch: fakeFetch([json({ version: "0.162.1" }), json({ version: "0.163.0" }), json({ version: "0.164.0" })], calls),
        now: () => clock,
    });
    const source = { kind: "npm", package: "@openai/codex" } as const;
    assert.deepEqual(await checker.latest(source), { version: "0.162.1", checkedAt: clock });
    assert.equal(calls[0]!.url, "https://registry.npmjs.org/@openai%2fcodex/latest");
    assert.equal(calls[0]!.init?.credentials, "omit");
    assert.equal(calls[0]!.init?.redirect, "follow");
    assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
    clock += 30_000;
    assert.equal((await checker.latest(source, { force: true })).version, "0.162.1", "force within 60 s is served from cache");
    clock += 31_000;
    assert.equal((await checker.latest(source)).version, "0.162.1", "cached for six hours");
    assert.equal((await checker.latest(source, { force: true })).version, "0.163.0", "force after 60 s re-fetches");
    clock += 6 * 60 * 60_000;
    assert.equal((await checker.latest(source)).version, "0.164.0", "expires after six hours");
    assert.equal(calls.length, 3);
    await checker.latest({ kind: "npm", package: "command-code", distTag: "next" }).catch(() => undefined);
    assert.equal(calls[3]?.url, "https://registry.npmjs.org/command-code/next");
});

test("npm lookup failures are unavailable answers, cached for 15 minutes", async () => {
    for (const answer of [
        json({}, 404),
        () => new Response("<html>not json"),
        json({ version: 12 }),
        json({ version: "not a version" }),
        () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ]) {
        const calls: Call[] = [];
        let clock = 0;
        const checker = createHarnessUpdateChecker({ fetch: fakeFetch([answer, json({ version: "1.0.0" })], calls), now: () => clock });
        const source = { kind: "npm", package: "command-code" } as const;
        const failed = await checker.latest(source);
        assert.equal(failed.version, undefined);
        assert.ok(failed.error);
        clock += 14 * 60_000;
        assert.ok((await checker.latest(source)).error, "failure stays cached");
        clock += 2 * 60_000;
        assert.equal((await checker.latest(source)).version, "1.0.0", "retried after 15 minutes");
    }
    const calls: Call[] = [];
    const checker = createHarnessUpdateChecker({ fetch: fakeFetch([], calls) });
    for (const source of [
        { kind: "npm", package: "../evil" },
        { kind: "npm", package: "Upper" },
        { kind: "npm", package: "ok", distTag: "a/b" },
        { kind: "page", url: "http://cursor.com/install", pattern: "(x)" },
    ] as const)
        assert.ok((await checker.latest(source)).error);
    assert.equal(calls.length, 0, "invalid sources never reach the network");
});

test("concurrent lookups share one request and forget drops the cached answer", async () => {
    const calls: Call[] = [];
    let release!: (response: Response) => void;
    const checker = createHarnessUpdateChecker({
        fetch: fakeFetch([() => new Promise<Response>((resolve) => { release = resolve; }), json({ version: "2.0.0" })], calls),
    });
    const source = { kind: "npm", package: "@opencode/cli" } as const;
    const first = checker.latest(source);
    const second = checker.latest(source);
    release(new Response(JSON.stringify({ version: "1.0.0" })));
    assert.deepEqual((await first).version, "1.0.0");
    assert.deepEqual((await second).version, "1.0.0");
    assert.equal(calls.length, 1);
    checker.forget(source);
    assert.equal((await checker.latest(source)).version, "2.0.0");
});

const CURSOR_INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.14-941492e/\${OS}/\${ARCH}/agent-cli-package.tar.gz"
`;

test("page lookups take the first capture group of the vendor page", async () => {
    const calls: Call[] = [];
    const checker = createHarnessUpdateChecker({ fetch: fakeFetch([() => new Response(CURSOR_INSTALLER), () => new Response("no marker")], calls) });
    const cursor = { kind: "page", url: "https://cursor.com/install", pattern: "downloads\\.cursor\\.com/lab/([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[0-9a-f]+)/" } as const;
    const answer = await checker.latest(cursor);
    assert.equal(answer.version, "2026.10.14-941492e");
    assert.ok(compareHarnessVersions(version(answer.version!), version("2026.09.15-d2fe57e")) > 0);
    assert.ok((await checker.latest({ ...cursor, url: "https://example.com/other" })).error, "a page without the marker is unavailable");
});

const space = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

type FakeProvider = { descriptor: HarnessDescriptor; installed: boolean; version?: string };
function updatesHost(providers: FakeProvider[], log: string[], remote = false): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        providers: () => providers.map(({ descriptor }) => ({ descriptor })),
        get: (id: string) => providers.find((provider) => provider.descriptor.id === id),
        invalidate: () => undefined,
        async snapshots(_context: unknown, options: { harnessId?: string; force?: boolean; detail?: boolean }) {
            log.push(`snapshots:${options.harnessId ?? "*"}:${Boolean(options.force)}:${Boolean(options.detail)}`);
            return providers
                .filter((provider) => !options.harnessId || provider.descriptor.id === options.harnessId)
                .map((provider) => ({ identity: { id: provider.descriptor.id, version: provider.version }, availability: { installed: provider.installed } }));
        },
    } as unknown as HarnessRegistry);
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return []; }, async get(id: string) { return { id, path: `/projects/${id}`, remote }; } } }),
    } as unknown as ServerPackageHost;
}

async function call(routes: ReturnType<typeof harnessRoutes>, method: string, path: string, principal: string, extra: Partial<SpaceContext> = {}): Promise<unknown> {
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    await routes({
        path: url.pathname, method, url, space: { ...space, ...extra }, principal: { kind: principal },
        json(_status: number, body: unknown) { payload = body; },
    } as unknown as RouteRequest);
    return payload;
}

async function withRegistryFetch<T>(versions: string[], calls: string[], run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
        calls.push(String(url));
        const next = versions.shift();
        return next === undefined ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ version: next }));
    }) as typeof fetch;
    try {
        return await run();
    }
    finally {
        globalThis.fetch = original;
    }
}

test("GET /api/harnesses/updates answers every visible harness and never fails them together", async () => {
    const log: string[] = [];
    const routes = harnessRoutes(updatesHost([
        { descriptor: { id: "codex", name: "Codex", integration: "x", priority: 0, updateCommand: ["codex", "update"], releaseSource: { kind: "npm", package: "@openai/codex" } }, installed: true, version: "codex-cli 0.160.0" },
        { descriptor: { id: "pi", name: "Pi", integration: "x", priority: 0, updateCommand: ["pi", "update"], releaseSource: { kind: "npm", package: "@earendil-works/pi-coding-agent" } }, installed: true, version: "1.2.0" },
        { descriptor: { id: "cc", name: "CC", integration: "x", priority: 0, updateCommand: ["cc", "update"], releaseSource: { kind: "npm", package: "command-code" } }, installed: true, version: "1.82.3" },
        { descriptor: { id: "agy", name: "Antigravity", integration: "x", priority: 0, updateCommand: ["agy", "update"] }, installed: true, version: "1.0.0" },
        { descriptor: { id: "grok", name: "Grok", integration: "x", priority: 0, updateCommand: ["grok", "update"], releaseSource: { kind: "npm", package: "grok" } }, installed: false },
        { descriptor: { id: "odd", name: "Odd", integration: "x", priority: 0, releaseSource: { kind: "npm", package: "odd" } }, installed: true, version: "unknown build" },
        { descriptor: { id: "private", name: "Private", integration: "x", priority: 0, accountOwnerUserId: "user-b", releaseSource: { kind: "npm", package: "private" } }, installed: true, version: "1.0.0" },
        { descriptor: { id: "opencode", name: "OpenCode", integration: "x", priority: 0, bundled: true, releaseSource: { kind: "npm", package: "@opencode/cli" } }, installed: true, version: "1.0.0" },
    ], log));
    const calls: string[] = [];
    // Lookups run concurrently in provider order: codex, pi, cc (fails), odd.
    const rows = await withRegistryFetch(["0.162.1", "1.2.0", "garbage", "1.0.0"], calls, () => call(routes, "GET", "/api/harnesses/updates?projectId=p1", "local-user")) as HarnessUpdateStatus[];
    const byId = new Map(rows.map((row) => [row.harnessId, row]));
    assert.deepEqual(rows.map((row) => row.harnessId), ["codex", "pi", "cc", "agy", "grok", "odd", "opencode"], "another user's private harness is invisible");
    assert.deepEqual(log, ["snapshots:*:false:false"], "summary snapshots only");
    assert.ok(!calls.some((url) => url.includes("private") || url.includes("/grok/") || url.includes("opencode")), "no lookup for invisible, uninstalled or bundled harnesses");
    assert.deepEqual(byId.get("opencode"), { harnessId: "opencode", installed: "1.0.0", current: "1.0.0", available: false, canUpdate: false, reason: "bundled" });
    assert.deepEqual(byId.get("codex"), { harnessId: "codex", installed: "codex-cli 0.160.0", current: "0.160.0", latest: "0.162.1", available: true, checkedAt: byId.get("codex")!.checkedAt, canUpdate: true });
    assert.equal(byId.get("pi")!.available, false);
    assert.equal(byId.get("pi")!.reason, undefined);
    assert.equal(byId.get("cc")!.reason, "unavailable");
    assert.equal(byId.get("agy")!.reason, "unsupported");
    assert.equal(byId.get("grok")!.reason, "not-installed");
    assert.equal(byId.get("grok")!.canUpdate, false);
    assert.equal(byId.get("odd")!.reason, "unparsed");
    assert.equal(byId.get("odd")!.canUpdate, false, "no update command");
    const paired = await call(routes, "GET", "/api/harnesses/updates?projectId=p1&harnessId=codex", "paired-device") as HarnessUpdateStatus[];
    assert.equal(paired.length, 1);
    assert.equal(paired[0]!.canUpdate, false, "only the instance owner may run an update");
    assert.equal(paired[0]!.latest, "0.162.1", "served from the cache");
    await assert.rejects(call(routes, "GET", "/api/harnesses/updates?harnessId=private", "local-user"), (error: unknown) => (error as { code?: string }).code === "not-found");
    await assert.rejects(call(routes, "GET", "/api/harnesses/updates?harnessId=nope", "local-user"), (error: unknown) => (error as { code?: string }).code === "not-found");
});

test("a remote project never looks up a release and cannot update", async () => {
    const routes = harnessRoutes(updatesHost([
        { descriptor: { id: "codex", name: "Codex", integration: "x", priority: 0, updateCommand: ["codex", "update"], releaseSource: { kind: "npm", package: "@openai/codex" } }, installed: true, version: "0.160.0" },
    ], [], true));
    const calls: string[] = [];
    const rows = await withRegistryFetch([], calls, () => call(routes, "GET", "/api/harnesses/updates?projectId=p1", "local-user")) as HarnessUpdateStatus[];
    assert.deepEqual(rows, [{ harnessId: "codex", installed: "0.160.0", current: "0.160.0", available: false, canUpdate: false, reason: "remote" }]);
    assert.equal(calls.length, 0);
});

test("a successful update run drops the cached release answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-updates-"));
    const bin = join(dir, "fake-cli");
    writeFileSync(bin, "#!/bin/sh\necho updated\n");
    chmodSync(bin, 0o755);
    const provider: FakeProvider = { descriptor: { id: "codex", name: "Codex", integration: "x", priority: 0, updateCommand: [bin, "update"], releaseSource: { kind: "npm", package: "@openai/codex" } }, installed: true, version: "0.160.0" };
    const routes = harnessRoutes(updatesHost([provider], []));
    const calls: string[] = [];
    await withRegistryFetch(["0.162.1", "0.162.1"], calls, async () => {
        const before = await call(routes, "GET", "/api/harnesses/updates", "local-user") as HarnessUpdateStatus[];
        assert.equal(before[0]!.available, true);
        await call(routes, "GET", "/api/harnesses/updates", "local-user");
        assert.equal(calls.length, 1, "cached");
        await assert.rejects(call(routes, "POST", "/api/harnesses/codex/update", "paired-device"), (error: unknown) => (error as { code?: string }).code === "forbidden");
        assert.deepEqual(await call(routes, "POST", "/api/harnesses/codex/update", "local-user"), { ok: true, exitCode: 0, output: "updated" });
        provider.version = "0.162.1";
        const after = await call(routes, "GET", "/api/harnesses/updates", "local-user") as HarnessUpdateStatus[];
        assert.equal(calls.length, 2, "looked up again after the update");
        assert.equal(after[0]!.available, false);
        assert.equal(after[0]!.current, "0.162.1");
    });
});
