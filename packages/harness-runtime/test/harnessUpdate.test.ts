import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessRegistry, HarnessSnapshot, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { freeHarnessExecutable, harnessRoutes, runHarnessUpdate, updateCrashName } from "../src/serverEntry.ts";

test("runHarnessUpdate runs the argv without a shell and reports the exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-update-"));
    const bin = join(dir, "fake-cli");
    writeFileSync(bin, "#!/bin/sh\necho \"updating $1 $2\"\n[ \"$2\" = ok ] || exit 3\n");
    chmodSync(bin, 0o755);
    assert.deepEqual(await runHarnessUpdate([bin, "update", "ok"]), { ok: true, exitCode: 0, output: "updating update ok" });
    const failed = await runHarnessUpdate([bin, "update", "$(echo injected)"]);
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.output, "updating update $(echo injected)", "arguments are not shell-interpreted");
    await assert.rejects(runHarnessUpdate([join(dir, "missing")]), /not installed/);
    // Node throws before spawning (here a NUL byte; on Windows a `.cmd` without
    // a shell): a failed run, never an unhandled 500.
    const refused = await runHarnessUpdate([bin, "update\0"]);
    assert.equal(refused.ok, false);
    assert.equal(refused.exitCode, null);
    assert.ok(refused.output);
});

test("runHarnessUpdate names the signal of an updater that crashed", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-update-crash-"));
    const bin = join(dir, "crashing-cli");
    writeFileSync(bin, "#!/bin/sh\nkill -ILL $$\n");
    chmodSync(bin, 0o755);
    const crashed = await runHarnessUpdate([bin, "update"]);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.exitCode, null);
    assert.equal(crashed.output, `${bin} stopped with SIGILL`);
});

const space = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

function maintenanceHost(log: string[]): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => id === "codex" ? { descriptor: { id } } : undefined,
        invalidate: (scope: { harnessId?: string }) => { log.push(`invalidate:${scope.harnessId}`); },
        async snapshots(context: { projectId: string }, options: { harnessId?: string; force?: boolean }) {
            log.push(`snapshots:${context.projectId}:${options.harnessId}:${options.force}`);
            return [{ identity: { id: "codex" }, catalog: { models: [{ providerID: "openai", modelID: "gpt" }] } }];
        },
    } as unknown as HarnessRegistry);
    services.provide(serverServiceKey("runtime.catalog"), { invalidateModels: () => { log.push("catalog"); } });
    services.provide(serverServiceKey("harness.runtime.restart"), async () => { log.push("restart"); return { restarted: 1, failed: 0 }; });
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return []; }, async get(id: string) { return { id, path: `/projects/${id}` }; } } }),
    } as unknown as ServerPackageHost;
}

async function post(path: string, principal: string, log: string[]): Promise<unknown> {
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    await harnessRoutes(maintenanceHost(log))({
        path: url.pathname, method: "POST", url, space, principal: { kind: principal },
        json(_status: number, body: unknown) { payload = body; },
    } as unknown as RouteRequest);
    return payload;
}

test("refresh-models drops both model caches and force-probes the harness for any member", async () => {
    const log: string[] = [];
    const snapshot = await post("/api/harnesses/codex/refresh-models?projectId=p1", "paired-device", log) as HarnessSnapshot;
    assert.equal(snapshot.catalog?.models?.length, 1);
    assert.deepEqual(log, ["invalidate:codex", "catalog", "snapshots:p1:codex:true", "catalog"]);
});

test("restart stays owner-only and invalidates the model catalog after the restart", async () => {
    const log: string[] = [];
    await assert.rejects(post("/api/harnesses/codex/restart", "paired-device", log), (error: unknown) => (error as { code?: string }).code === "forbidden");
    assert.deepEqual(log, []);
    assert.deepEqual(await post("/api/harnesses/codex/restart", "local-user", log), { restarted: 1, failed: 0 });
    assert.deepEqual(log, ["restart", "invalidate:codex", "catalog"]);
});

test("a Windows updater crash is named by its NTSTATUS exit code", () => {
    assert.equal(updateCrashName(null, 0xC000001D), "STATUS_ILLEGAL_INSTRUCTION (0xC000001D)");
    // Node can surface the same status as a negative 32-bit integer.
    assert.equal(updateCrashName(null, 0xC000001D | 0), "STATUS_ILLEGAL_INSTRUCTION (0xC000001D)");
    assert.equal(updateCrashName("SIGILL", null), "SIGILL");
    assert.equal(updateCrashName(null, 1), undefined);
    assert.equal(updateCrashName(null, null), undefined);
});

test("Windows frees a harness's idle chats before replacing its program and refuses while one works", async () => {
    const asked: string[] = [];
    const hostWith = (answer: { released: number; busy: number } | undefined) => ({
        services: {
            get: (key: unknown) => answer && String((key as { id?: string }).id ?? key).includes("harness.runtime.releaseIdle")
                ? async (harnessId: string) => { asked.push(harnessId); return answer; }
                : undefined,
        },
    }) as unknown as Parameters<typeof freeHarnessExecutable>[0];
    const grok = { id: "grok", name: "Grok Build" };
    // Other systems replace a running file safely: nothing is released.
    assert.deepEqual(await freeHarnessExecutable(hostWith({ released: 2, busy: 1 }), grok, "linux"), { released: 0 });
    assert.deepEqual(asked, []);
    assert.deepEqual(await freeHarnessExecutable(hostWith({ released: 2, busy: 0 }), grok, "win32"), { released: 2 });
    await assert.rejects(freeHarnessExecutable(hostWith({ released: 0, busy: 1 }), grok, "win32"),
        (error: Error & { code?: string }) => error.code === "conflict" && /Grok Build is still working in a chat/.test(error.message));
    assert.deepEqual(asked, ["grok", "grok"]);
    // A host without the release service (an older server) is not blocked.
    assert.deepEqual(await freeHarnessExecutable(hostWith(undefined), grok, "win32"), { released: 0 });
});
