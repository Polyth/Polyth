import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStdioRpc } from "../src/rpc.ts";
import { createProcessAuthority, releaseProcessExecution } from "../src/authority.ts";
const script = `const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='hang')return;if(m.method==='malformed'){process.stdout.write('null\\n');return;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{child:child.pid}})+'\\n');});`;
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
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { writeFile } = await import("node:fs/promises");
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
test("a missing supervisor receipt never authorizes replacement even after its process exits", { skip: process.platform !== "linux" }, async () => {
    const { createProcessAuthority } = await import("../src/authority.ts");
    const { once } = await import("node:events");
    const dir = await mkdtemp(join(tmpdir(), "rpc-proof-"));
    const file = join(dir, "state.json");
    const authority = await createProcessAuthority(file, false, { authorityId: "runtime-incarnation", generation: 17 });
    const child = authority.spawn(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { cwd: dir });
    child.stderr!.resume();
    const nativePid = Number(String((await once(child.stdout!, "data"))[0]).trim());
    try {
        child.kill("SIGKILL");
        await once(child, "exit");
        await assert.rejects(createProcessAuthority(file), { code: "outcome-unknown" });
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
