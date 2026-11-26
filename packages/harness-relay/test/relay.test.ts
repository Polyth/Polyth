import assert from "node:assert/strict";
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, HarnessContext, HarnessProvider, RouteRequest } from "@polyth/contracts";
import { createHarnessAccountFamily, harnessCommandLine } from "@polyth/harness-runtime/accounts";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage, { HARNESS_RELAY_REMOTE_ACCESS } from "../src/serverEntry.ts";
import { chooseRelayMembers, relayHost, type RelayChooserInput, type RelayHeadroom, type RelayLimitsSource } from "../src/chooser.ts";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_000_000;
const H = (windows: [number, number, number?][], known = true): RelayHeadroom => ({ known, windows: windows.map(([used, limit, resetsAt]) => ({ used, limit, ...(resetsAt !== undefined ? { resetsAt } : {}) })) });
const choose = (over: Partial<RelayChooserInput> & { headroom?: Record<string, RelayHeadroom> }) => chooseRelayMembers({
    members: ["a", "b", "c"], headroom: {}, refusedUntil: new Map(), usable: new Set(["a", "b", "c"]), order: "expire-first", handoverAt: 0.05, now: NOW, ...over,
});

test("chooser: sticky stays first while eligible", () => {
    assert.deepEqual(choose({ sticky: "c", headroom: { a: H([[10, 100, NOW + 5]]) } }).candidates, ["c", "a", "b"]);
    assert.deepEqual(choose({ sticky: "c", headroom: { c: H([[99, 100, NOW + 5]]) } }).candidates, ["a", "b"]);
});
test("chooser: expire-first orders by earliest running reset, unstarted last", () => {
    const plan = choose({ headroom: { a: H([[1, 100]]), b: H([[10, 100, NOW + 900]]), c: H([[10, 100, NOW + 100], [1, 100, NOW + 50_000]]) } });
    assert.deepEqual(plan.candidates, ["c", "b", "a"]);
    assert.deepEqual(choose({ headroom: { b: H([[1, 100, NOW - 5]]) } }).candidates, ["a", "b", "c"]);
});
test("chooser: manual keeps member order", () => {
    assert.deepEqual(choose({ order: "manual", headroom: { c: H([[10, 100, NOW + 1]]) } }).candidates, ["a", "b", "c"]);
});
test("chooser: threshold is strict and per window", () => {
    assert.deepEqual(choose({ handoverAt: 0.05, headroom: { a: H([[95, 100]]) } }).candidates, ["b", "c"]);
    assert.deepEqual(choose({ handoverAt: 0.05, headroom: { a: H([[94, 100], [99, 100]]) } }).candidates, ["b", "c"]);
    assert.deepEqual(choose({ handoverAt: 0.02, headroom: { a: H([[95, 100]]) } }).candidates, ["a", "b", "c"]);
});
test("chooser: refused, unusable and unknown readings", () => {
    assert.deepEqual(choose({ refusedUntil: new Map([["a", NOW + 1], ["b", NOW - 1]]) }).candidates, ["b", "c"]);
    assert.deepEqual(choose({ usable: new Set(["c"]) }).candidates, ["c"]);
    assert.deepEqual(choose({ headroom: { a: H([[100, 100]], false) } }).candidates, ["a", "b", "c"]);
});
test("chooser: exhaustedUntil is the earliest refill", () => {
    const plan = choose({ headroom: { a: H([[99, 100, NOW + 500]]), b: H([[100, 100, NOW + 300]]) }, refusedUntil: new Map([["c", NOW + 700]]) });
    assert.deepEqual(plan, { candidates: [], exhaustedUntil: NOW + 300 });
    assert.deepEqual(choose({ usable: new Set() }), { candidates: [] });
});
test("chooser: a member returns only when every blocking window has refilled", () => {
    // a: 5h spent until +300 and 7d spent until +9000 → back at +9000, not +300.
    const plan = choose({
        headroom: { a: H([[100, 100, NOW + 300], [100, 100, NOW + 9000]]), b: H([[100, 100, NOW + 4000]]) },
        usable: new Set(["a", "b"]), members: ["a", "b"],
    });
    assert.deepEqual(plan, { candidates: [], exhaustedUntil: NOW + 4000 });
    // A blocking window without a reset time leaves that member's return unknown.
    assert.deepEqual(choose({ headroom: { a: H([[100, 100]]) }, usable: new Set(["a"]), members: ["a"] }), { candidates: [] });
});

const provider = (id: string, ready = true): HarnessProvider => ({
    descriptor: { id, name: id, integration: "test", priority: 10 },
    probe: async () => ({ harnessId: id, installed: true, authenticated: ready, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} } as AgentRuntime),
});
/** A family the vendor tolerates several accounts of, so its Relay is on by
 *  default; `policy` picks the vendor's terms the package reads. */
const setup = (policy: "tolerated" | "unsupported" | "prohibited" = "tolerated") => {
    const dir = tempDir(join(tmpdir(), "relay-"));
    const registry = createHarnessRegistry();
    const signedOut = new Set<string>();
    const accounts = createHarnessAccountFamily({
        family: "codex", label: "Codex", packageId: "backend-codex", storageDir: dir, deployment: "local-trusted",
        registry: () => registry,
        createProvider: (account) => {
            const p = provider(account?.harnessId ?? "codex");
            p.probe = async () => ({ harnessId: p.descriptor.id, installed: true, authenticated: !signedOut.has(p.descriptor.id), healthy: true });
            return p;
        },
        status: async () => ({ loggedIn: true }),
        signInCommand: () => harnessCommandLine(["codex", "login"]),
        relay: { policy },
    });
    return { dir, registry, accounts, signedOut };
};
const ctx = (userId = "u1"): HarnessContext => ({ space: { spaceId: "s", userId } as never, spaceId: "s", projectId: "p", cwd: "/tmp", actorUserId: userId });
const request = (method: string, path: string, body: Record<string, unknown>, userId: string, extra: Record<string, unknown> = {}) => {
    let reply: { code: number; body: any } | undefined;
    const space = { spaceId: "s", userId, role: "owner", instanceOwner: true, harnessManager: false, harnessPersonal: false, allowedHarnesses: null, ...extra };
    return {
        req: {
            method, path, url: new URL(`http://polyth.test${path}`), space, principal: { kind: "ui-session" },
            body: async () => body, json: (code: number, payload: unknown) => { reply = { code, body: payload }; },
        } as unknown as RouteRequest,
        get reply() { return reply!; },
    };
};
const packageHost = (dir: string, limits: () => RelayLimitsSource | undefined = () => undefined) => ({
    pluginId: "harness-relay",
    storageDir: dir,
    services: {
        get: () => limits(),
        require: () => { throw new Error("unexpected service"); },
    },
    forSpace: () => ({
        projects: { get: async (id: string) => ({ id, path: dir }), list: async () => [{ id: "p", path: dir }] },
        sessions: {},
    }),
}) as unknown as ServerPackageHost;

test("the package registers a Relay per family, never for Auto, and probes setup-required without members", async () => {
    const { dir, registry, accounts } = setup();
    await accounts.onEnable();
    const pkg = registerPackage(packageHost(dir));
    await pkg.onEnable!();
    const relay = registry.get("codex-relay")!;
    assert.equal(relay.descriptor.name, "Codex · Relay");
    assert.equal(relay.descriptor.autoSelect, false);
    assert.deepEqual(relay.descriptor.relay, { family: "codex", policy: "tolerated" });
    assert.deepEqual(relay.descriptor.accounts, { family: "codex", endpoint: "/api/backend-codex/accounts" });
    const probe = await relay.probe!(ctx());
    assert.equal(probe.state, "setup-required");
    assert.equal(probe.message, "Add accounts to Relay in Settings");
    assert.equal((await registry.resolve(ctx(), { mode: "auto" })).descriptor.id, "codex");
    await assert.rejects(relay.createRuntime!(ctx()));
    await pkg.onDisable!();
    assert.equal(registry.get("codex-relay"), undefined);
    await accounts.onDisable();
});

test("a Relay's model catalog is its member's, owned by the Relay so the picker lists it", async () => {
    const { dir, registry, accounts } = setup();
    await accounts.onEnable();
    const codex = registry.get("codex")!;
    codex.discover = async () => ({ state: "ready", catalog: { models: [{ harnessId: "codex", providerID: "openai", modelID: "gpt", name: "GPT" }] } });
    const pkg = registerPackage(packageHost(dir));
    await pkg.onEnable!();
    await accounts.store!.setRelay("u1", { members: ["codex"], order: "manual", handoverAt: 0.05 });
    const discovery = await registry.get("codex-relay")!.discover!(ctx());
    assert.equal(discovery.state, "ready");
    assert.deepEqual(discovery.catalog?.models?.map((model) => [model.harnessId, model.modelID]), [["codex-relay", "gpt"]]);
    await pkg.onDisable!();
    await accounts.onDisable();
});

test("limits come from the usage service lazily; missing service means unknown", async () => {
    const { dir, registry, accounts } = setup();
    await accounts.onEnable();
    await accounts.store!.setRelay("u1", { members: ["codex"], order: "manual", handoverAt: 0.1 });
    let limits: RelayLimitsSource | undefined;
    const pkg = registerPackage(packageHost(dir, () => limits));
    await pkg.onEnable!();
    const pinned = { mode: "pinned" as const, harnessId: "codex-relay" };
    try {
        assert.equal((await registry.resolve(ctx(), pinned)).descriptor.id, "codex", "no usage service: known nothing, still eligible");
        limits = { snapshots: async () => [{ providerId: "codex", windows: [{ used: 95, limit: 100, unit: "percent", resetsAt: Date.now() + 60_000 }] }] };
        await assert.rejects(registry.resolve(ctx(), pinned), /out of limits/);
    } finally {
        await pkg.onDisable!();
        await accounts.onDisable();
    }
});

test("routes: view, save, validation and private-account non-disclosure", async () => {
    const { dir, accounts } = setup();
    // Stored before the family comes up, so each login has a provider.
    const mine = await accounts.store!.add("Mine", async () => {}, "u1");
    const theirs = await accounts.store!.add("Theirs", async () => {}, "u2");
    await accounts.onEnable();
    const pkg = registerPackage(packageHost(dir));
    await pkg.onEnable!();
    const call = async (method: string, path: string, userId: string, body: Record<string, unknown> = {}) => {
        const r = request(method, path, body, userId);
        assert.equal(await pkg.routes!(r.req), true);
        return r.reply;
    };
    try {
        const listed = await call("GET", "/api/harness-relay/relays", "u1");
        assert.equal(listed.code, 200);
        assert.equal(listed.body.relays.length, 1);
        assert.deepEqual(listed.body.families.map((family: { family: string; enabled: boolean }) => [family.family, family.enabled]), [["codex", true]]);
        const view = listed.body.relays[0];
        assert.deepEqual(view.members.map((m: { harnessId: string }) => m.harnessId).toSorted(), ["codex", mine.harnessId].toSorted());
        assert.equal(view.members.find((m: { harnessId: string }) => m.harnessId === mine.harnessId).owner, "mine");
        assert.equal(view.members.some((m: { harnessId: string }) => m.harnessId === theirs.harnessId), false, "another person's private login is invisible");

        const save = (body: Record<string, unknown>) => call("PUT", "/api/harness-relay/relays/codex-relay", "u1", body);
        const ok = await save({ members: [mine.harnessId, "codex"], order: "manual", handoverAt: 0.02 });
        assert.equal(ok.code, 200);
        assert.deepEqual(ok.body.settings.members, [mine.harnessId, "codex"]);
        assert.equal(ok.body.members.find((m: { harnessId: string }) => m.harnessId === mine.harnessId).state, "now");
        assert.equal(ok.body.members.find((m: { harnessId: string }) => m.harnessId === "codex").state, "next");
        const foreign = await save({ members: [theirs.harnessId], order: "manual", handoverAt: 0.05 });
        const unknown = await save({ members: ["codex-nope"], order: "manual", handoverAt: 0.05 });
        assert.equal(foreign.code, 400);
        assert.equal(foreign.body.error, unknown.body.error);
        for (const body of [
            { members: ["codex", "codex"], order: "manual", handoverAt: 0.05 },
            { members: Array.from({ length: 17 }, (_, i) => `codex-${i}`), order: "manual", handoverAt: 0.05 },
            { members: ["codex"], order: "random", handoverAt: 0.05 },
            { members: ["codex"], order: "manual", handoverAt: 0.5 },
        ]) assert.equal((await save(body)).code, 400);
        assert.equal((await call("PUT", "/api/harness-relay/relays/nope", "u1", { members: [], order: "manual", handoverAt: 0.05 })).code, 404);
        assert.equal((await call("GET", "/api/harness-relay/relays", "u2")).body.relays[0].settings.members.length, 0);
    } finally {
        await pkg.onDisable!();
        await accounts.onDisable();
    }
});

test("a paired device may read Relays but never save them", async () => {
    const { matchRemotePath } = await import("@polyth/contracts");
    const { CORE_REMOTE_ACCESS, findRemotePolicyOverlaps, validateRemoteAccessPolicy } = await import("../../server/src/remotePolicy.ts");
    const core = { owner: "core", policy: CORE_REMOTE_ACCESS };
    validateRemoteAccessPolicy("harness-relay", HARNESS_RELAY_REMOTE_ACCESS, [core]);
    assert.deepEqual(findRemotePolicyOverlaps([core, { owner: "harness-relay", policy: HARNESS_RELAY_REMOTE_ACCESS }]), []);
    const allowed = (method: string, path: string) => HARNESS_RELAY_REMOTE_ACCESS.http.some((rule) =>
        (rule.methods as readonly string[]).includes(method) && matchRemotePath(rule.path, path));
    assert.equal(allowed("GET", "/api/harness-relay/relays"), true);
    assert.equal(allowed("PUT", "/api/harness-relay/relays/claude-relay"), false);
    assert.equal(allowed("GET", "/api/harness-relay/families"), false);
    assert.equal(allowed("PUT", "/api/harness-relay/families/claude"), false);
    assert.ok(HARNESS_RELAY_REMOTE_ACCESS.http.every((rule) => !rule.mutation));
});

test("a Relay's cached readiness is per person, never shared inside a Space", async () => {
    const { dir, registry, accounts } = setup();
    await accounts.onEnable();
    const pkg = registerPackage(packageHost(dir));
    await pkg.onEnable!();
    try {
        await accounts.store!.setRelay("u1", { members: ["codex"], order: "manual", handoverAt: 0.05 });
        // u1 has a member and is ready; u2's Relay is empty and needs setup.
        const first = await registry.snapshots(ctx("u1"), { harnessId: "codex-relay" });
        assert.equal(first[0]!.availability.state, "ready");
        const second = await registry.snapshots(ctx("u2"), { harnessId: "codex-relay" });
        assert.equal(second[0]!.availability.state, "setup-required");
        // Reading u1 again still answers for u1 (no poisoned entry from u2).
        const again = await registry.snapshots(ctx("u1"), { harnessId: "codex-relay" });
        assert.equal(again[0]!.availability.state, "ready");
    } finally {
        await pkg.onDisable!();
        await accounts.onDisable();
    }
});
