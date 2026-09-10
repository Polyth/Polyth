import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStdioRpc } from "../src/rpc.ts";
import {
    createProcessAuthority,
    releaseProcessExecution,
    type ProcessContainmentController,
} from "../src/authority.ts";
const script = `const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='hang')return;if(m.method==='malformed'){process.stdout.write('null\\n');return;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{child:child.pid}})+'\\n');});`;
const waitFor = async <T>(read: () => Promise<T>, timeoutMs = 2_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await read();
        }
        catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
};
const assertGone = async (pid: number) => {
    try {
        await readFile(`/proc/${pid}/stat`, "utf8");
        assert.fail(`process ${pid} still exists`);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
};

test("the real Linux supervisor needs no Python and launches only after durable ownership", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-native-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(file, false, { authorityId: "runtime-incarnation", generation: 17 });
    const probe = `const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'));process.stdout.write(JSON.stringify({pid:process.pid,authorityId:state.authorityId,generation:state.generation})+'\\n');setInterval(()=>{},1000);`;
    const child = authority.spawn(process.execPath, ["-e", probe], {
        cwd: dir,
        env: { ...process.env, PATH: join(dir, "contains-no-python") },
    });
    child.stderr!.resume();
    const launched = JSON.parse(String((await once(child.stdout!, "data"))[0])) as { pid: number; authorityId: string; generation: number };
    const state = JSON.parse(await readFile(file, "utf8")) as { receiptFile: string };
    assert.deepEqual(
        { authorityId: launched.authorityId, generation: launched.generation },
        { authorityId: authority.authorityId, generation: authority.generation },
        "the harness observed the already-persisted exact authority",
    );
    assert.deepEqual(JSON.parse(await readFile(`${state.receiptFile}.ready`, "utf8")), {
        authorityId: authority.authorityId,
        generation: authority.generation,
    });
    await assert.rejects(readFile(state.receiptFile, "utf8"), { code: "ENOENT" });
    await authority.close();
    await assertGone(launched.pid);
    assert.deepEqual(JSON.parse(await readFile(state.receiptFile, "utf8")), {
        authorityId: authority.authorityId,
        generation: authority.generation,
    });
    await rm(dir, { recursive: true, force: true });
});

test("the real supervisor adopts and cleans a setsid double-fork descendant before release", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-double-fork-"));
    const fixture = join(dir, "double-fork");
    const source = join(import.meta.dirname, "fixtures", "double-fork.c");
    const compiled = spawnSync(process.env.CC ?? "cc", ["-std=c11", "-D_GNU_SOURCE", source, "-o", fixture], { stdio: "pipe" });
    assert.equal(compiled.status, 0, String(compiled.stderr));
    const file = join(dir, "state.json");
    const pidFile = join(dir, "daemon.pid");
    const authority = await createProcessAuthority(file);
    const supervisor = authority.spawn(fixture, [pidFile], { cwd: dir });
    supervisor.stdout!.resume();
    supervisor.stderr!.resume();
    const daemonPid = await waitFor(async () => Number((await readFile(pidFile, "utf8")).trim()));
    assert.match(await readFile(`/proc/${daemonPid}/stat`, "utf8"), /^\d+ /);
    await authority.close();
    await assertGone(daemonPid);
    const state = JSON.parse(await readFile(file, "utf8")) as { receiptFile: string };
    assert.deepEqual(JSON.parse(await readFile(state.receiptFile, "utf8")), {
        authorityId: authority.authorityId,
        generation: authority.generation,
    });
    await rm(dir, { recursive: true, force: true });
});

test("spawn distinguishes a vanished runtime cwd from supervisor availability", { skip: process.platform !== "linux" }, async () => {
    const authority = await createProcessAuthority();
    assert.throws(
        () => authority.spawn(process.execPath, ["-e", ""], { cwd: join(tmpdir(), `missing-polyth-cwd-${process.pid}`) }),
        /Runtime workspace\/cwd no longer exists/,
    );
    await authority.close();
});

test("a missing bundled supervisor reports the Polyth layer instead of raw spawn ENOENT", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-missing-binary-"));
    const moduleUrl = new URL("../src/authority.ts", import.meta.url).href;
    const probe = `import {createProcessAuthority} from ${JSON.stringify(moduleUrl)};const authority=await createProcessAuthority();try{authority.spawn(process.execPath,['-e',''],{cwd:process.cwd()});process.exitCode=2}catch(error){process.stdout.write(error.message)}`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe], {
        cwd: dir,
        env: { ...process.env, POLYTH_RESOURCES_DIR: join(dir, "absent-resources") },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Polyth runtime supervisor binary is missing");
    await rm(dir, { recursive: true, force: true });
});

test("a mismatched supervisor PID identity is never signalled as prior ownership", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-pid-reuse-"));
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({
        authorityId: "stale",
        generation: 4,
        pid: process.pid,
        startTime: "not-this-process",
        receiptFile: join(dir, "missing.released"),
        receipts: {},
        releasedAuthorities: [],
    }));
    await assert.rejects(createProcessAuthority(file), /Previous executor has no verified release receipt/);
    assert.equal(process.kill(process.pid, 0), true);
    await rm(dir, { recursive: true, force: true });
});
test("durable authority release does not construct a runtime in the old workspace", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-release-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(file, false, { authorityId: "old-authority", generation: 7 });
    await authority.receipt("create", "native-session");
    const outcome = await releaseProcessExecution(file, {
        canonicalSessionId: "canonical",
        backendSessionId: "native-session",
        authorityId: "old-authority",
        generation: 7,
        continuity: "generation-only",
        location: { directory: join(dir, "now-missing") },
    }, "release-op");
    assert.deepEqual(outcome, {
        kind: "confirmed",
        value: { authorityId: "old-authority", generation: 7, backendSessionId: "native-session" },
    });
    await rm(dir, { recursive: true, force: true });
});

test("release evidence is fenced to the exact authority generation", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-generation-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(file);
    await authority.receipt("create", "native-session");
    const binding = {
        canonicalSessionId: "canonical",
        backendSessionId: "native-session",
        authorityId: authority.authorityId,
        generation: authority.generation + 1,
        continuity: "generation-only" as const,
        location: { directory: dir },
    };
    assert.deepEqual(await releaseProcessExecution(file, binding, "stale-release"), {
        kind: "rejected",
        code: "stale-evidence",
        message: "durable process authority does not match",
    });
    await authority.close();
    await rm(dir, { recursive: true, force: true });
});
test("an uncertain legacy release records the boot recovery boundary", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-legacy-release-"));
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({
        authorityId: "old-authority",
        generation: 7,
        pid: process.pid,
        startTime: "not-this-process",
        receiptFile: `${file}.old-authority.7.released`,
        receipts: {},
        releasedAuthorities: [],
    }));
    const outcome = await releaseProcessExecution(file, {
        canonicalSessionId: "canonical",
        backendSessionId: "native-session",
        authorityId: "old-authority",
        generation: 7,
        continuity: "generation-only",
        location: { directory: dir },
    }, "release-op");
    assert.equal(outcome.kind, "unknown");
    const observed = JSON.parse(await readFile(file, "utf8")) as {
        legacyRecoveryBootId?: string;
    };
    assert.equal(
        observed.legacyRecoveryBootId,
        (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    );
    await rm(dir, { recursive: true, force: true });
});
test("stdio receipts survive restart; release kills the owned worker and its detached tool child", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-"));
    const file = join(dir, "state.json");
    const options = { command: process.execPath, args: ["-e", script], cwd: dir, stateFile: file, stableAuthority: true };
    const rpc = await createStdioRpc(options);
    const result = await rpc.request<{
        child: number;
    }>("hello", {});
    await rpc.receipt("create", "native");
    await assert.rejects(rpc.request("hang", {}, 20), { code: "outcome-unknown" });
    await rpc.close();
    try {
        const stat = await readFile(`/proc/${result.child}/stat`, "utf8");
        assert.match(stat.slice(stat.lastIndexOf(")") + 2), /^[ZX] /);
    }
    catch (e) {
        if ((e as {
            code?: string;
        }).code !== "ENOENT")
            throw e;
    }
    const next = await createStdioRpc(options);
    assert.equal(next.authorityId, rpc.authorityId);
    assert.equal(next.generation, rpc.generation + 1);
    assert.equal(next.receipts.create, "native");
    await next.close();
    await rm(dir, { recursive: true, force: true });
});
test("malformed stdio frames fail closed without crashing the server", { skip: process.platform !== "linux" }, async () => {
    const rpc = await createStdioRpc({ command: process.execPath, args: ["-e", script], cwd: "/tmp" });
    await assert.rejects(rpc.request("malformed", {}), { code: "outcome-unknown" });
    await rpc.close();
});
test("owner crash closes the lease and reaps detached tools before a replacement starts", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-owner-"));
    const file = join(dir, "state.json");
    const moduleUrl = new URL("../src/rpc.ts", import.meta.url).href;
    const ownerFile = join(dir, "owner.mjs");
    await writeFile(ownerFile, `import {createStdioRpc} from ${JSON.stringify(moduleUrl)};const rpc=await createStdioRpc(${JSON.stringify({ command: process.execPath, args: ["-e", script], cwd: dir, stateFile: file })});const result=await rpc.request('hello',{});process.stdout.write(JSON.stringify(result)+'\\n');`);
    const owner = spawn(process.execPath, ["--experimental-strip-types", ownerFile], { stdio: ["ignore", "pipe", "pipe"] });
    owner.stderr.resume();
    const data = await new Promise<string>((resolve, reject) => { owner.stdout.once("data", b => resolve(String(b))); owner.once("error", reject); });
    const descendant = JSON.parse(data).child as number;
    owner.kill("SIGKILL");
    await once(owner, "close");
    const next = await createStdioRpc({ command: process.execPath, args: ["-e", script], cwd: dir, stateFile: file });
    try {
        const stat = await readFile(`/proc/${descendant}/stat`, "utf8");
        assert.match(stat.slice(stat.lastIndexOf(")") + 2), /^[ZX] /);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
            throw e;
    }
    await next.close();
    await rm(dir, { recursive: true, force: true });
});
test("a systemd scope reclaims the owned tree when the supervisor receipt is lost", { skip: process.platform !== "linux" }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-proof-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(file, false, { authorityId: "runtime-incarnation", generation: 17 });
    const child = authority.spawn(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { cwd: dir });
    child.stderr!.resume();
    const nativePid = Number(String((await once(child.stdout!, "data"))[0]).trim());
    try {
        const before = JSON.parse(await readFile(file, "utf8")) as {
            containment?: { kind?: string };
            receiptFile: string;
        };
        if (before.containment?.kind !== "systemd-user-scope") {
            t.skip("systemd user scopes are unavailable");
            await authority.close();
            return;
        }
        child.kill("SIGKILL");
        await once(child, "exit");
        await assert.rejects(readFile(before.receiptFile, "utf8"), { code: "ENOENT" });
        const next = await createProcessAuthority(file);
        await assertGone(nativePid);
        assert.deepEqual(JSON.parse(await readFile(before.receiptFile, "utf8")), {
            authorityId: authority.authorityId,
            generation: authority.generation,
        });
        await next.close();
    }
    finally {
        try {
            process.kill(nativePid, "SIGKILL");
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH")
                throw e;
        }
        await rm(dir, { recursive: true, force: true });
    }
});

test("a durable containment receipt permits recovery without trusting a reused PID", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-contained-recovery-"));
    const file = join(dir, "state.json");
    const receiptFile = `${file}.old-authority.7.released`;
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const released: string[] = [];
    const authorityHash = createHash("sha256").update("old-authority").digest("hex").slice(0, 24);
    const containment: ProcessContainmentController = {
        create(proof) {
            const proofHash = createHash("sha256").update(proof.authorityId).digest("hex").slice(0, 24);
            return {
                kind: "systemd-user-scope",
                unit: `polyth-runtime-${proofHash}-${proof.generation}.scope`,
                bootId,
            };
        },
        launch(_scope, command, args) {
            return { command, args: [...args] };
        },
        async release(scope) {
            released.push(scope.unit);
            return true;
        },
    };
    await writeFile(file, JSON.stringify({
        authorityId: "old-authority",
        generation: 7,
        pid: process.pid,
        startTime: "not-this-process",
        receiptFile,
        receipts: {},
        releasedAuthorities: [],
        containment: containment.create({ authorityId: "old-authority", generation: 7 }),
    }));
    try {
        const next = await createProcessAuthority(file, false, undefined, { containment });
        assert.deepEqual(released, [`polyth-runtime-${authorityHash}-7.scope`]);
        assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")), {
            authorityId: "old-authority",
            generation: 7,
        });
        assert.equal(next.generation, 8);
        await next.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("legacy authorities still block replacement when no containment can prove release", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-legacy-proof-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(
        file,
        false,
        { authorityId: "runtime-incarnation", generation: 17 },
        { containment: false },
    );
    const child = authority.spawn(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { cwd: dir });
    child.stderr!.resume();
    const nativePid = Number(String((await once(child.stdout!, "data"))[0]).trim());
    try {
        child.kill("SIGKILL");
        await once(child, "exit");
        const state = JSON.parse(await readFile(file, "utf8")) as { receiptFile: string };
        await assert.rejects(readFile(state.receiptFile, "utf8"), { code: "ENOENT" });
        await assert.rejects(
            createProcessAuthority(file, false, undefined, { containment: false }),
            { code: "outcome-unknown" },
        );
        const observed = JSON.parse(await readFile(file, "utf8")) as {
            legacyRecoveryBootId?: string;
        };
        assert.equal(
            observed.legacyRecoveryBootId,
            (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
        );
        await assert.rejects(
            createProcessAuthority(file, false, undefined, { containment: false }),
            { code: "outcome-unknown" },
        );
    } finally {
        try {
            process.kill(nativePid, "SIGKILL");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await rm(dir, { recursive: true, force: true });
    }
});

test("a later host boot releases a previously observed legacy authority", { skip: process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-legacy-boot-proof-"));
    const file = join(dir, "state.json");
    const receiptFile = `${file}.old-authority.7.released`;
    await writeFile(file, JSON.stringify({
        authorityId: "old-authority",
        generation: 7,
        pid: process.pid,
        startTime: "not-this-process",
        receiptFile,
        receipts: {},
        releasedAuthorities: [],
        legacyRecoveryBootId: "00000000-0000-0000-0000-000000000000",
    }));
    try {
        const next = await createProcessAuthority(file, false, undefined, { containment: false });
        assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")), {
            authorityId: "old-authority",
            generation: 7,
        });
        assert.equal(next.generation, 8);
        await next.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
