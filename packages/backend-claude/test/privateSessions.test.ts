import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { createClaudeRuntime } from "../src/index.ts";

/** A fake Agent SDK that records each launch and every transcript lookup. */
function fakeSdk() {
    const launches: Array<Record<string, unknown>> = [];
    const sessionInfoReads: string[] = [];
    const sdk = {
        query(args: any) {
            launches.push(args.options);
            return {
                async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}); },
                initializationResult: async () => ({}),
                supportedModels: async () => [],
                interrupt: async () => {},
                close() {},
            } as any;
        },
        getSessionInfo: async (id: string) => { sessionInfoReads.push(id); return undefined as any; },
    };
    const receipts: Record<string, string> = {};
    const authority = {
        authorityId: "owned",
        generation: 1,
        receipts,
        releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
        close: async () => {},
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    return { sdk, authority, launches, sessionInfoReads };
}

const base: HarnessContext = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

test("a private session launches Claude Code without session persistence", async () => {
    const f = fakeSdk();
    const runtime = await createClaudeRuntime({ ...base, privateSession: true }, f.sdk, f.authority);
    const created = await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.equal(created.kind, "confirmed");
    assert.equal(f.launches[0]?.persistSession, false);
    // There is no transcript to title or resume from: nothing reads one.
    await runtime.sessions();
    assert.deepEqual(f.sessionInfoReads, []);
});

test("a private session reattached on a new runtime starts fresh without looking for a transcript", async () => {
    const f = fakeSdk();
    const runtime = await createClaudeRuntime({ ...base, privateSession: true }, f.sdk, f.authority);
    await runtime.ensureSession({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp", backendSessionId: "native-1" });
    assert.deepEqual(f.sessionInfoReads, []);
    assert.equal(f.launches[0]?.persistSession, false);
    assert.equal(f.launches[0]?.sessionId, "native-1");
    assert.equal(f.launches[0]?.resume, undefined);
});

test("an ordinary session keeps Claude Code's own transcript", async () => {
    const f = fakeSdk();
    const runtime = await createClaudeRuntime(base, f.sdk, f.authority);
    await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.equal("persistSession" in f.launches[0]!, false);
});
