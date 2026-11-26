import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessDescriptor, HarnessRegistry, HarnessUpdateStatus, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createHarnessAutoUpdater, type AutoUpdateHarness, type AutoUpdateRun } from "../src/autoUpdate.ts";
import { harnessRoutes } from "../src/serverEntry.ts";

import { after } from "node:test";
import { rmSync } from "node:fs";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const descriptor = (id: string, extra: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({ id, name: id, integration: "test", priority: 0, updateCommand: ["codex", "update"], ...extra }) as HarnessDescriptor;

type Rig = {
    calls: string[];
    busy: Map<string, number>;
    versions: { installed: string; latest: string };
    runs: AutoUpdateRun[];
    clock: { now: number };
    updater: ReturnType<typeof createHarnessAutoUpdater>;
    file: string;
};

function rig(harnesses: AutoUpdateHarness[], options: { release?: boolean; update?: () => Promise<AutoUpdateRun>; moves?: boolean } = {}): Rig {
    const calls: string[] = [];
    const busy = new Map<string, number>();
    const versions = { installed: "1.0.0", latest: "1.1.0" };
    const runs: AutoUpdateRun[] = [];
    const clock = { now: 1_000_000 };
    const file = join(tempDir(join(tmpdir(), "harness-auto-update-")), "auto-update.json");
    const updater = createHarnessAutoUpdater({
        file,
        harnesses: () => harnesses,
        async status(harness): Promise<HarnessUpdateStatus> {
            calls.push(`status:${harness.descriptor.id}`);
            const available = versions.latest !== versions.installed;
            return { harnessId: harness.descriptor.id, current: versions.installed, latest: versions.latest, available, canUpdate: true, checkedAt: clock.now };
        },
        async update(harness, group) {
            calls.push(`update:${harness.descriptor.id}:${group.map((member) => member.descriptor.id).join("+")}`);
            const run = options.update ? await options.update() : { ok: true, exitCode: 0, output: "updated" };
            if (run.ok && options.moves !== false) versions.installed = versions.latest;
            runs.push(run);
            clock.now += 30_000;
            return run;
        },
        release: () => options.release === false ? undefined : async (harnessId, request = {}) => {
            calls.push(`release:${harnessId}:${request.checkOnly ? "check" : `before=${request.createdBefore}`}`);
            return { released: 0, busy: busy.get(harnessId) ?? 0 };
        },
        now: () => clock.now,
        log: () => undefined,
    });
    return { calls, busy, versions, runs, clock, updater, file };
}

test("an update waits while a chat works, then restarts only runtimes still on the old build once idle", async () => {
    const codex = { descriptor: descriptor("codex") };
    const r = rig([codex]);
    await r.updater.set(codex, true);
    r.busy.set("codex", 1);
    await r.updater.tick();
    assert.deepEqual(r.calls, ["status:codex", "release:codex:check"], "a working chat holds the update back");
    assert.deepEqual(await r.updater.state(codex, true), { enabled: true, canChange: true, pending: { kind: "update", version: "1.1.0" } });

    // The chat finished, but the update leaves another one still working.
    r.calls.length = 0;
    r.busy.set("codex", 0);
    r.clock.now += 60_000;
    const updateStartedAt = r.clock.now;
    await r.updater.tick();
    const finishedAt = updateStartedAt + 30_000;
    assert.deepEqual(r.calls, ["status:codex", "release:codex:check", "update:codex:codex", "status:codex", `release:codex:before=${finishedAt}`]);
    const state = await r.updater.state(codex, true);
    assert.deepEqual(state.last, { at: finishedAt, ok: true, latest: "1.1.0", from: "1.0.0", to: "1.1.0" });
    assert.equal(state.pending, undefined, "the restart found no chat still working");
    assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")).harnesses.codex.last.to, "1.1.0", "the outcome survives a restart");
});

test("chats still on the old build are restarted on later passes, and never before they are idle", async () => {
    const codex = { descriptor: descriptor("codex") };
    let releaseBusy = 0;
    const calls: string[] = [];
    const clock = { now: 5_000_000 };
    const versions = { installed: "1.0.0" };
    const updater = createHarnessAutoUpdater({
        file: join(tempDir(join(tmpdir(), "harness-auto-restart-")), "auto-update.json"),
        harnesses: () => [codex],
        async status() {
            return { harnessId: "codex", current: versions.installed, latest: "2.0.0", available: versions.installed !== "2.0.0", canUpdate: true };
        },
        async update() {
            versions.installed = "2.0.0";
            releaseBusy = 2;
            return { ok: true, exitCode: 0, output: "" };
        },
        release: () => async (_id, request = {}) => {
            calls.push(request.checkOnly ? "check" : `restart:${request.createdBefore}`);
            return { released: 0, busy: request.checkOnly ? 0 : releaseBusy };
        },
        now: () => clock.now,
        log: () => undefined,
    });
    await updater.set(codex, true);
    await updater.tick();
    assert.deepEqual(calls, ["check", `restart:${clock.now}`]);
    assert.deepEqual((await updater.state(codex, true)).pending, { kind: "restart" });
    const before = clock.now;
    clock.now += 60_000;
    releaseBusy = 1;
    await updater.tick();
    assert.deepEqual(calls.slice(2), [`restart:${before}`], "the same cut-off: runtimes created after the update are on the new build");
    releaseBusy = 0;
    clock.now += 60_000;
    await updater.tick();
    assert.equal((await updater.state(codex, true)).pending, undefined);
    calls.length = 0;
    clock.now += 60_000;
    await updater.tick();
    assert.deepEqual(calls, [], "up to date and nothing left to restart");
});

test("a failed release is not retried for a day, and an unchanged version restarts nothing", async () => {
    const codex = { descriptor: descriptor("codex") };
    const failing = rig([codex], { update: async () => ({ ok: false, exitCode: 1, output: "network down\n" }) });
    await failing.updater.set(codex, true);
    await failing.updater.tick();
    const last = (await failing.updater.state(codex, true)).last;
    assert.equal(last?.ok, false);
    assert.equal(last?.message, "network down");
    failing.calls.length = 0;
    failing.clock.now += 31 * 60_000;
    await failing.updater.tick();
    assert.deepEqual(failing.calls, ["status:codex"], "checked again, but the same release is not rerun");
    failing.clock.now += 24 * 60 * 60_000;
    failing.calls.length = 0;
    await failing.updater.tick();
    assert.ok(failing.calls.includes("update:codex:codex"), "a day later it is tried again");

    // An updater whose channel lags the registry reports success and leaves
    // the version as it was: nothing to restart, and not rerun every check.
    const lagging = rig([codex], { update: async () => ({ ok: true, exitCode: 0, output: "already up to date" }), moves: false });
    await lagging.updater.set(codex, true);
    await lagging.updater.tick();
    assert.deepEqual(lagging.calls, ["status:codex", "release:codex:check", "update:codex:codex", "status:codex"], "no restart");
    assert.deepEqual((await lagging.updater.state(codex, true)).last?.to, "1.0.0");
    lagging.calls.length = 0;
    lagging.clock.now += 31 * 60_000;
    await lagging.updater.tick();
    assert.deepEqual(lagging.calls, ["status:codex"]);
});

test("nothing is updated without the host's idle gate, when switched off, or for a CLI with no updater", async () => {
    const codex = { descriptor: descriptor("codex") };
    const ungated = rig([codex], { release: false });
    await ungated.updater.set(codex, true);
    await ungated.updater.tick();
    assert.deepEqual(ungated.calls, ["status:codex"], "no proof the CLI is idle, so no update");

    const off = rig([codex]);
    await off.updater.tick();
    assert.deepEqual(off.calls, [], "switched off: not even checked");
    await off.updater.set(codex, true);
    await off.updater.set(codex, false);
    await off.updater.tick();
    assert.deepEqual(off.calls, []);

    const bundled = { descriptor: descriptor("opencode", { bundled: { version: "1" } as HarnessDescriptor["bundled"] }) };
    const plain = { descriptor: descriptor("fx", { updateCommand: undefined }) };
    const r = rig([bundled, plain]);
    await assert.rejects(r.updater.set(bundled, true), (error: unknown) => (error as { code?: string }).code === "unsupported");
    await assert.rejects(r.updater.set(plain, true), (error: unknown) => (error as { code?: string }).code === "unsupported");
    assert.equal((await r.updater.state(bundled, true)).canChange, false);
});

test("harnesses on one CLI are checked, updated and restarted together", async () => {
    const codex = { descriptor: descriptor("codex") };
    const work = { descriptor: descriptor("codex-work") };
    const other = { descriptor: descriptor("pi", { updateCommand: ["pi", "update"] }) };
    const r = rig([codex, work, other]);
    await r.updater.set(codex, true);
    r.busy.set("codex-work", 1);
    await r.updater.tick();
    assert.deepEqual(r.calls, ["status:codex", "release:codex:check", "release:codex-work:check"], "another account's working chat runs the same program");
    r.busy.set("codex-work", 0);
    r.clock.now += 60_000;
    r.calls.length = 0;
    await r.updater.tick();
    assert.ok(r.calls.includes("update:codex:codex+codex-work"));
    assert.ok(r.calls.some((call) => call.startsWith("release:codex-work:before=")));
    assert.ok(!r.calls.some((call) => call.startsWith("release:pi")));
});

test("a chat that starts before the file swap defers the update instead of failing it", async () => {
    const codex = { descriptor: descriptor("codex") };
    let refuse = true;
    const r = rig([codex], {
        update: async () => {
            if (refuse) throw Object.assign(new Error("still working"), { code: "conflict" });
            return { ok: true, exitCode: 0, output: "" };
        },
    });
    await r.updater.set(codex, true);
    await r.updater.tick();
    const state = await r.updater.state(codex, true);
    assert.equal(state.last, undefined, "not recorded as a failed update");
    assert.deepEqual(state.pending, { kind: "update", version: "1.1.0" });
    refuse = false;
    r.clock.now += 60_000;
    await r.updater.tick();
    assert.equal((await r.updater.state(codex, true)).last?.ok, true);
});

test("only the owner sees what it waits for and did; one update of a CLI runs at a time", async () => {
    const codex = { descriptor: descriptor("codex") };
    const r = rig([codex], { update: async () => ({ ok: false, exitCode: 1, output: "/home/someone/.npm: denied" }) });
    await r.updater.set(codex, true);
    await r.updater.tick();
    assert.deepEqual(await r.updater.state(codex, false), { enabled: true, canChange: false });
    assert.equal((await r.updater.state(codex, true)).last?.message, "/home/someone/.npm: denied");

    let finish!: () => void;
    const running = r.updater.exclusive(codex.descriptor, () => new Promise<void>((resolve) => { finish = resolve; }));
    await assert.rejects(r.updater.exclusive(descriptor("codex-work"), async () => undefined), (error: unknown) => (error as { code?: string }).code === "conflict");
    finish();
    await running;
    await r.updater.exclusive(codex.descriptor, async () => undefined);
});

const space = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

function routeHost(): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => id === "codex" ? { descriptor: descriptor("codex") } : undefined,
        providers: () => [{ descriptor: descriptor("codex") }],
        invalidate: () => undefined,
        async snapshots() {
            return [{ identity: { id: "codex", version: "1.0.0" }, availability: { installed: true } }];
        },
    } as unknown as HarnessRegistry);
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return []; }, async get(id: string) { return { id, path: `/projects/${id}` }; } } }),
    } as unknown as ServerPackageHost;
}

async function call(routes: ReturnType<typeof harnessRoutes>, method: string, path: string, principal: string, body: Record<string, unknown> = {}): Promise<unknown> {
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    await routes({
        path: url.pathname, method, url, space, principal: { kind: principal },
        async body() { return body; },
        json(_status: number, value: unknown) { payload = value; },
    } as unknown as RouteRequest);
    return payload;
}

test("only the instance owner switches automatic updates; everyone who sees the harness sees whether it is on", async () => {
    const host = routeHost();
    const autoUpdates = createHarnessAutoUpdater({
        file: join(tempDir(join(tmpdir(), "harness-auto-route-")), "auto-update.json"),
        harnesses: () => [{ descriptor: descriptor("codex") }],
        async status() { return { harnessId: "codex", available: false, canUpdate: true }; },
        async update() { return { ok: true, exitCode: 0, output: "" }; },
        release: () => undefined,
    });
    const checker = { async latest() { return { version: "1.0.0", checkedAt: 1 }; }, forget() {} };
    const routes = harnessRoutes(host, undefined, { autoUpdates, updateChecker: checker });
    await assert.rejects(call(routes, "PUT", "/api/harnesses/codex/auto-update", "paired-device", { enabled: true }),
        (error: unknown) => (error as { code?: string }).code === "forbidden");
    await assert.rejects(call(routes, "PUT", "/api/harnesses/codex/auto-update", "local-user", { enabled: "yes" }),
        (error: unknown) => (error as { code?: string }).code === "invalid-input");
    await assert.rejects(call(routes, "PUT", "/api/harnesses/missing/auto-update", "local-user", { enabled: true }),
        (error: unknown) => (error as { code?: string }).code === "not-found");
    assert.deepEqual(await call(routes, "PUT", "/api/harnesses/codex/auto-update", "local-user", { enabled: true }), { enabled: true, canChange: true });
    const [owner] = await call(routes, "GET", "/api/harnesses/updates", "local-user") as HarnessUpdateStatus[];
    assert.deepEqual(owner?.autoUpdate, { enabled: true, canChange: true });
    const [member] = await call(routes, "GET", "/api/harnesses/updates", "paired-device") as HarnessUpdateStatus[];
    assert.deepEqual(member?.autoUpdate, { enabled: true, canChange: false });
    autoUpdates.stop();
});
