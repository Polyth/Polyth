import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessRegistry, HarnessSnapshot, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { harnessRoutes, runHarnessUpdate } from "../src/serverEntry.ts";

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
