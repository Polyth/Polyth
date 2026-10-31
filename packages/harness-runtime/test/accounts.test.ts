import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, HarnessProvider, RouteRequest, SessionProjection } from "@polyth/contracts";
import { createHarnessAccountFamily, harnessCommandLine, linkAccountOverlay, type ResolvedHarnessAccount } from "../src/accounts.ts";
import { createHarnessPool, createHarnessRegistry } from "../src/index.ts";

const provider = (id: string): HarnessProvider => ({
    descriptor: { id, name: "Codex", integration: "test", priority: 10, signInCommand: "codex login" },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} } as AgentRuntime),
});

type Actor = { userId: string; spaceId?: string; instanceOwner?: boolean; harnessManager?: boolean; harnessPersonal?: boolean; allowedHarnesses?: string[] };
const OWNER: Actor = { userId: "u-owner", instanceOwner: true };
const call = async (routes: ReturnType<typeof createHarnessAccountFamily>["routes"], method: string, path: string, body: Record<string, unknown> = {}, actor: Actor = OWNER) => {
    let reply: { code: number; body: any } | undefined;
    const space = { spaceId: actor.spaceId ?? "s", userId: actor.userId, role: "owner", instanceOwner: actor.instanceOwner === true, harnessManager: actor.harnessManager === true, harnessPersonal: actor.harnessPersonal === true, allowedHarnesses: actor.allowedHarnesses ?? null };
    const handled = await routes({ method, path, space, principal: { kind: "ui-session" }, body: async () => body, json: (code: number, payload: unknown) => { reply = { code, body: payload }; } } as unknown as RouteRequest);
    return { handled, ...reply! };
};

const family = (options: { storageDir?: string; deployment?: "local-trusted" | "server-trusted"; unsupported?: string; registry?: ReturnType<typeof createHarnessRegistry> } = {}) => {
    const registry = options.registry ?? createHarnessRegistry();
    const created: Array<ResolvedHarnessAccount | undefined> = [];
    const accounts = createHarnessAccountFamily({
        family: "codex",
        label: "Codex",
        packageId: "backend-codex",
        ...(options.storageDir ? { storageDir: options.storageDir } : {}),
        deployment: options.deployment ?? "local-trusted",
        registry: () => registry,
        createProvider: (account) => { created.push(account); return provider(account?.harnessId ?? "codex"); },
        status: async (account) => ({ loggedIn: !account }),
        signInCommand: (account) => harnessCommandLine(["/opt/bin/codex", "login"], account ? { CODEX_HOME: account.dir } : {}),
        deviceSignInCommand: (account) => harnessCommandLine(["/opt/bin/codex", "login", "--device-auth"], account ? { CODEX_HOME: account.dir } : {}),
        limitsFamily: "codex",
        ...(options.unsupported ? { unsupported: options.unsupported } : {}),
    });
    return { registry, accounts, created };
};
const ids = (registry: ReturnType<typeof createHarnessRegistry>) => registry.providers().map((item) => item.descriptor.id).toSorted();

test("every account is its own harness with a private directory and live name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex"]);

    assert.equal((await call(accounts.routes, "GET", "/api/other")).handled, false);
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: " " })).code, 400);
    const created = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work  Team" });
    assert.equal(created.code, 201);
    assert.deepEqual(created.body, { id: "work-team", harnessId: "codex-work-team", name: "Work Team" });
    assert.ok(lstatSync(join(dir, "codex-accounts", "work-team")).isDirectory());
    // A non-Latin name still yields a valid harness id, and ids never collide.
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Робочий" })).body.id, "account");
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Клієнт" })).body.id, "account-2");
    assert.deepEqual(ids(registry), ["codex", "codex-account", "codex-account-2", "codex-work-team"]);

    const work = registry.get("codex-work-team")!;
    assert.equal(work.descriptor.name, "Codex · Work Team");
    assert.equal(work.descriptor.accountLabel, "Work Team");
    assert.deepEqual(work.descriptor.accounts, { family: "codex", endpoint: "/api/backend-codex/accounts" });
    assert.deepEqual(registry.get("codex")!.descriptor.accounts, { family: "codex", endpoint: "/api/backend-codex/accounts" });
    assert.equal(registry.get("codex")!.descriptor.accountLabel, undefined);
    assert.deepEqual(work.limitsAccount?.(), { family: "codex", configDir: join(dir, "codex-accounts", "work-team") });
    assert.equal(work.descriptor.signInCommand, `CODEX_HOME='${join(dir, "codex-accounts", "work-team")}' '/opt/bin/codex' 'login'`);
    assert.equal(registry.get("codex")!.descriptor.signInCommand, "'/opt/bin/codex' 'login'");
    // A browser that is not on this machine signs the same login in by device code.
    assert.equal(work.descriptor.deviceSignInCommand, `CODEX_HOME='${join(dir, "codex-accounts", "work-team")}' '/opt/bin/codex' 'login' '--device-auth'`);

    // A rename updates the registered descriptor in place, so a harness
    // holding live leases is never re-registered for it.
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/work-team", { name: "Work" })).body.name, "Work");
    assert.equal(registry.get("codex-work-team"), work);
    assert.equal(work.descriptor.name, "Codex · Work");
    const roster = await registry.roster({ spaceId: "s", projectId: "p", cwd: "/tmp" });
    assert.deepEqual(roster.find((row) => row.identity.id === "codex-work-team")?.identity, {
        id: "codex-work-team", name: "Codex · Work", integration: "test", accountLabel: "Work",
        accounts: { family: "codex", endpoint: "/api/backend-codex/accounts" },
    });

    const listed = await call(accounts.routes, "GET", "/api/backend-codex/accounts");
    assert.equal(listed.body.manageable, true);
    assert.deepEqual(listed.body.accounts.map((row: { harnessId: string; removable: boolean; status: { loggedIn: boolean } }) => [row.harnessId, row.removable, row.status.loggedIn]),
        [["codex", false, true], ["codex-work-team", true, false], ["codex-account", true, false], ["codex-account-2", true, false]]);

    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/account")).code, 200);
    assert.deepEqual(ids(registry), ["codex", "codex-account-2", "codex-work-team"]);
    // Removal keeps credentials and transcripts; the same name restores them.
    assert.ok(existsSync(join(dir, "codex-accounts", "account")));
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/account")).code, 404);
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/nope", { name: "X" })).code, 404);

    await accounts.onDisable();
    assert.deepEqual(ids(registry), []);
    // A restart registers the stored accounts again.
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex", "codex-account-2", "codex-work-team"]);
    assert.equal(registry.get("codex-work-team")!.descriptor.name, "Codex · Work");
});

test("removing an account that still holds a session lease is refused and keeps the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work" });
    const pool = createHarnessPool({
        registry,
        legacyHarnessId: "codex",
        context: async (projectId, cwd, sessionId) => ({ spaceId: "s", projectId, cwd: cwd!, sessionId }),
    });
    const projection = { id: "s1", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle", resolvedHarnessId: "codex-work" } as SessionProjection;
    await pool.forSession(projection, "/tmp");

    const refused = await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/work");
    assert.equal(refused.code, 409);
    assert.deepEqual((await accounts.store!.list()).map((row) => row.id), ["work"]);
    assert.ok(registry.get("codex-work"));

    await pool.retireSession("s1");
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/work")).code, 200);
    assert.equal(registry.get("codex-work"), undefined);
    assert.deepEqual(await accounts.store!.list(), []);
    await pool.dispose();
});

test("an account whose harness cannot register is rolled back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const registry = createHarnessRegistry();
    // Another package already owns the id this account would take.
    registry.register(provider("codex-work"));
    const { accounts } = family({ storageDir: dir, registry });
    await accounts.onEnable();
    const failed = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work" });
    assert.equal(failed.code, 409);
    assert.deepEqual(await accounts.store!.list(), []);
    assert.deepEqual(ids(registry), ["codex", "codex-work"]);
    await accounts.onDisable();
});

test("a broken account list never keeps the default harness from registering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    writeFileSync(join(dir, "codex-accounts.json"), "{not json");
    const { registry, accounts } = family({ storageDir: dir });
    accounts.onEnable();
    // Registered synchronously, like a single-provider package.
    assert.deepEqual(ids(registry), ["codex"]);
    writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify([{ id: "ok", name: "Ok" }, { id: "../x", name: "Bad" }, { id: "default", name: "Default" }, { id: "ok", name: "Dup" }]));
    await accounts.onDisable();
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex", "codex-ok"]);
    // Enable is idempotent.
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex", "codex-ok"]);
    await accounts.onDisable();
});

test("accounts are read-only outside a trusted local deployment, and off without storage or support", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const hosted = family({ storageDir: dir, deployment: "server-trusted" });
    assert.equal((await call(hosted.accounts.routes, "GET", "/api/backend-codex/accounts")).body.manageable, false);
    assert.equal((await call(hosted.accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work" })).code, 403);

    const noStorage = family();
    await noStorage.accounts.onEnable();
    assert.deepEqual(ids(noStorage.registry), ["codex"]);
    assert.equal((await call(noStorage.accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work" })).code, 400);

    const unsupported = family({ storageDir: dir, unsupported: "Needs Linux" });
    await unsupported.accounts.onEnable();
    const listed = await call(unsupported.accounts.routes, "GET", "/api/backend-codex/accounts");
    assert.equal(listed.body.unsupported, "Needs Linux");
    assert.equal(listed.body.manageable, false);
    assert.equal(listed.body.accounts.length, 1);
    assert.equal((await call(unsupported.accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Work" })).code, 400);
});

test("only the owner or a permitted account manages accounts; a permitted account's are private", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    const ida: Actor = { userId: "u-ida", harnessManager: true };
    const bob: Actor = { userId: "u-bob" };
    const max: Actor = { userId: "u-max", harnessManager: true };
    const list = async (actor: Actor) => (await call(accounts.routes, "GET", "/api/backend-codex/accounts", {}, actor)).body;

    // Without the permission: read-only, every mutation refused.
    assert.equal((await list(bob)).manageable, false);
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Bob" }, bob)).code, 403);
    assert.equal((await list(ida)).manageable, true);

    const shared = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Team" });
    assert.deepEqual(shared.body, { id: "team", harnessId: "codex-team", name: "Team" });
    const mine = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" }, ida);
    assert.deepEqual(mine.body, { id: "ida", harnessId: "codex-ida", name: "Ida", private: true });
    assert.deepEqual(await accounts.store!.list().then((rows) => rows.map((row) => [row.id, row.ownerUserId])), [["team", undefined], ["ida", "u-ida"]]);

    // The private harness names its owner and is never picked by Auto.
    const descriptor = registry.get("codex-ida")!.descriptor;
    assert.equal(descriptor.accountOwnerUserId, "u-ida");
    assert.equal(descriptor.autoSelect, false);
    assert.equal(registry.get("codex-team")!.descriptor.accountOwnerUserId, undefined);
    const resolved = await registry.resolve({ spaceId: "s", projectId: "p", cwd: "/tmp" }, { mode: "auto" }, "codex-ida");
    assert.notEqual(resolved.descriptor.id, "codex-ida");

    // Each user sees the shared accounts and only their own private ones;
    // the instance owner sees everything.
    const rows = async (actor: Actor) => (await list(actor)).accounts.map((row: { id: string; removable: boolean; private?: boolean }) => [row.id, row.removable, row.private ?? false]);
    assert.deepEqual(await rows(ida), [["default", false, false], ["team", false, false], ["ida", true, true]]);
    assert.deepEqual(await rows(max), [["default", false, false], ["team", false, false]]);
    assert.deepEqual(await rows(bob), [["default", false, false], ["team", false, false]]);
    assert.deepEqual(await rows(OWNER), [["default", false, false], ["team", true, false], ["ida", true, true]]);
    // Account limits hide shared logins off the owner's list, never the user's
    // own; a manager still sees every shared account, to choose who uses it.
    assert.deepEqual(await rows({ ...ida, allowedHarnesses: ["claude"] }), [["team", false, false], ["ida", true, true]]);
    assert.deepEqual(await rows({ ...ida, harnessManager: false, harnessPersonal: true, allowedHarnesses: ["claude"] }), [["ida", true, true]]);
    assert.deepEqual(await rows({ ...bob, allowedHarnesses: ["codex-team"] }), [["team", false, false]]);

    // A permitted account changes only its own accounts; another user's
    // private account does not exist for it.
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/team", { name: "X" }, ida)).code, 403);
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/team", {}, ida)).code, 403);
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/ida", { name: "X" }, max)).code, 404);
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/ida", {}, max)).code, 404);
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/ida", { name: "Ida home" }, ida)).body.name, "Ida home");

    // A removed private login is restored only to the same user: anyone else
    // re-adding the same name gets a fresh directory.
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/ida", {}, ida)).code, 200);
    assert.ok(existsSync(join(dir, "codex-accounts", "ida")));
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" }, max)).body.id, "ida-2");
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" })).body.id, "ida-3");
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" }, ida)).body.id, "ida");

    // A private account cap per user.
    for (const name of ["A", "B", "C"]) assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name }, ida)).code, 201);
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "D" }, ida)).code, 400);
    await accounts.onDisable();
});

test("harnesses.personal adds, renames and removes only its own private accounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    const olena: Actor = { userId: "u-olena", harnessPersonal: true };
    const ida: Actor = { userId: "u-ida", harnessPersonal: true };
    await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Team" });
    const listed = (await call(accounts.routes, "GET", "/api/backend-codex/accounts", {}, olena)).body;
    assert.equal(listed.manageable, true);
    assert.equal(listed.canAddShared, false);
    assert.equal(listed.canEditAccess, false);
    // Asking for a shared one still yields a private one.
    const mine = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Olena", private: false }, olena);
    assert.deepEqual(mine.body, { id: "olena", harnessId: "codex-olena", name: "Olena", private: true });
    assert.equal(registry.get("codex-olena")!.descriptor.accountOwnerUserId, "u-olena");
    await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" }, ida);
    const rows = (await call(accounts.routes, "GET", "/api/backend-codex/accounts", {}, olena)).body.accounts
        .map((row: { id: string; removable: boolean; mine?: boolean; usable: boolean; accessEditable?: boolean }) => [row.id, row.removable, row.mine ?? false, row.usable, row.accessEditable ?? false]);
    assert.deepEqual(rows, [["default", false, false, true, false], ["team", false, false, true, false], ["olena", true, true, true, false]]);
    // Never a shared account, never another person's private one.
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/team", { name: "X" }, olena)).code, 403);
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/team", {}, olena)).code, 403);
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/ida", { name: "X" }, olena)).code, 404);
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/ida", {}, olena)).code, 404);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: ["u-olena"] }, olena)).code, 403);
    assert.equal((await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/olena", { name: "Olena home" }, olena)).body.name, "Olena home");
    assert.equal((await call(accounts.routes, "DELETE", "/api/backend-codex/accounts/olena", {}, olena)).code, 200);
    // The per-user cap is unchanged.
    for (const name of ["A", "B", "C"]) assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name }, ida)).code, 201);
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "D" }, ida)).code, 400);
    // Without the permission nothing changes; outside local-trusted neither.
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Bob" }, { userId: "u-bob" })).code, 403);
    const hosted = family({ storageDir: mkdtempSync(join(tmpdir(), "harness-accounts-")), deployment: "server-trusted" });
    assert.equal((await call(hosted.accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Olena" }, olena)).code, 403);
    assert.equal((await call(hosted.accounts.routes, "GET", "/api/backend-codex/accounts", {}, olena)).body.manageable, false);
    await accounts.onDisable();
});

test("the instance owner may add a private account for itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    assert.equal((await call(accounts.routes, "GET", "/api/backend-codex/accounts")).body.canAddShared, true);
    assert.equal((await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Mine", private: "yes" })).code, 400);
    const mine = await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Mine", private: true });
    assert.deepEqual(mine.body, { id: "mine", harnessId: "codex-mine", name: "Mine", private: true });
    assert.equal(registry.get("codex-mine")!.descriptor.accountOwnerUserId, "u-owner");
    assert.equal(registry.get("codex-mine")!.descriptor.autoSelect, false);
    const row = (await call(accounts.routes, "GET", "/api/backend-codex/accounts")).body.accounts.find((item: { id: string }) => item.id === "mine");
    assert.equal(row.mine, true);
    assert.equal(row.private, true);
    // Nobody else sees or uses it, managers included.
    const others = (await call(accounts.routes, "GET", "/api/backend-codex/accounts", {}, { userId: "u-ida", harnessManager: true })).body.accounts;
    assert.equal(others.some((item: { id: string }) => item.id === "mine"), false);
    await accounts.onDisable();
});

test("a shared account limited to people and Spaces: live descriptor, listing, persistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Team" });
    await call(accounts.routes, "POST", "/api/backend-codex/accounts", { name: "Ida" }, { userId: "u-ida", harnessPersonal: true });
    const team = registry.get("codex-team")!.descriptor;
    assert.equal(team.autoSelect, undefined);

    const restricted = await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: ["u-ida", "u-ida"], allowedSpaceIds: ["s"] });
    assert.deepEqual(restricted.body, { id: "team", harnessId: "codex-team", name: "Team", allowedUserIds: ["u-ida"], allowedSpaceIds: ["s"] });
    // Read live from the registered descriptor; a restricted account is never picked by Auto.
    assert.equal(registry.get("codex-team")!.descriptor, team);
    assert.deepEqual(team.accountAllowedUserIds, ["u-ida"]);
    assert.deepEqual(team.accountAllowedSpaceIds, ["s"]);
    assert.equal(team.autoSelect, false);

    const seen = async (actor: Actor) => (await call(accounts.routes, "GET", "/api/backend-codex/accounts", {}, actor)).body.accounts
        .filter((row: { id: string }) => row.id === "team")
        .map((row: { usable: boolean; allowedUserIds?: string[] }) => [row.usable, row.allowedUserIds ?? null]);
    assert.deepEqual(await seen({ userId: "u-ida" }), [[true, null]], "an allowed person sees it, without the list");
    assert.deepEqual(await seen({ userId: "u-bob" }), [], "a foreign person does not");
    assert.deepEqual(await seen({ userId: "u-ida", spaceId: "other" }), [], "nor does the allowed person in a foreign Space");
    assert.deepEqual(await seen({ userId: "u-max", harnessManager: true }), [[false, ["u-ida"]]], "a manager sees it with the list, unusable");
    assert.deepEqual(await seen({ userId: "u-ida", allowedHarnesses: ["claude"] }), [], "account limits still apply");

    // Managers edit lists; the list never applies to a private account; bad ids are refused.
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: ["u-ida", "u-max"], allowedSpaceIds: null }, { userId: "u-max", harnessManager: true })).code, 200);
    assert.equal(team.accountAllowedSpaceIds, undefined);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/ida/access", { allowedUserIds: ["u-bob"] })).code, 400);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/ida/access", { allowedUserIds: ["u-bob"] }, { userId: "u-max", harnessManager: true })).code, 404);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: ["../x"] })).code, 400);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: "u-ida" })).code, 400);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/nope/access", {})).code, 404);
    assert.equal((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: ["u-bob"] }, { userId: "u-bob" })).code, 403);
    // A rename keeps the list; a restart restores it.
    await call(accounts.routes, "PATCH", "/api/backend-codex/accounts/team", { name: "Team 2" });
    await accounts.onDisable();
    await accounts.onEnable();
    assert.deepEqual(registry.get("codex-team")!.descriptor.accountAllowedUserIds, ["u-ida", "u-max"]);
    // Clearing reopens it to everyone, Auto included.
    assert.deepEqual((await call(accounts.routes, "PUT", "/api/backend-codex/accounts/team/access", { allowedUserIds: [], allowedSpaceIds: null })).body, { id: "team", harnessId: "codex-team", name: "Team 2" });
    assert.equal(registry.get("codex-team")!.descriptor.autoSelect, undefined);
    assert.deepEqual(await seen({ userId: "u-bob" }), [[true, null]]);
    await accounts.onDisable();
});

test("a malformed allowlist hides the stored account instead of sharing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify([
        { id: "ok", name: "Ok", allowedUserIds: ["u-1"] },
        { id: "bad", name: "Bad", allowedUserIds: "u-1" },
        { id: "evil", name: "Evil", allowedSpaceIds: ["../x"] },
        { id: "mine", name: "Mine", ownerUserId: "u-2", allowedUserIds: ["u-3"] },
    ]));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex", "codex-mine", "codex-ok"]);
    assert.deepEqual(registry.get("codex-ok")!.descriptor.accountAllowedUserIds, ["u-1"]);
    // A private account never carries a list.
    assert.equal(registry.get("codex-mine")!.descriptor.accountAllowedUserIds, undefined);
    await accounts.onDisable();
});

test("a malformed owner never turns a stored private account into a shared one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
    writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify([{ id: "ok", name: "Ok", ownerUserId: "u-1" }, { id: "bad", name: "Bad", ownerUserId: 7 }, { id: "evil", name: "Evil", ownerUserId: "../x" }]));
    const { registry, accounts } = family({ storageDir: dir });
    await accounts.onEnable();
    assert.deepEqual(ids(registry), ["codex", "codex-ok"]);
    assert.equal(registry.get("codex-ok")!.descriptor.accountOwnerUserId, "u-1");
    await accounts.onDisable();
});

test("an account overlay links the real directory except the account's own entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-overlay-"));
    const real = join(root, "home");
    mkdirSync(join(real, ".ssh"), { recursive: true });
    mkdirSync(join(real, ".commandcode"));
    writeFileSync(join(real, ".gitconfig"), "[user]\n");
    // The overlay itself lives below the real home (Polyth storage often does).
    const overlay = join(real, ".local", "polyth", "accounts", "work");
    mkdirSync(overlay, { recursive: true });
    // A stale link to the real credentials must not survive.
    symlinkSync(join(real, ".commandcode"), join(overlay, ".commandcode"));

    await linkAccountOverlay({ root: overlay, real, own: [".commandcode"] });
    assert.equal(readlinkSync(join(overlay, ".ssh")), join(real, ".ssh"));
    assert.equal(readlinkSync(join(overlay, ".gitconfig")), join(real, ".gitconfig"));
    // Never link an ancestor of the overlay into itself.
    assert.equal(existsSync(join(overlay, ".local")), false);
    assert.equal(existsSync(join(overlay, ".commandcode")), false);

    // Idempotent; a real private entry is never replaced.
    mkdirSync(join(overlay, ".commandcode"));
    writeFileSync(join(real, ".npmrc"), "");
    await linkAccountOverlay({ root: overlay, real, own: [".commandcode"] });
    assert.ok(lstatSync(join(overlay, ".commandcode")).isDirectory());
    assert.equal(readlinkSync(join(overlay, ".npmrc")), join(real, ".npmrc"));
    await assert.rejects(linkAccountOverlay({ root: real, real, own: [] }), { code: "invalid-path" });
});

test("terminal command lines quote every value", () => {
    assert.equal(harnessCommandLine(["/a b/agy"], { HOME: "/x/it's" }, "linux"), `HOME='/x/it'\\''s' '/a b/agy'`);
});

test("Windows sign-in lines use cmd.exe syntax, not POSIX quotes", () => {
    // POSIX `VAR='v' 'exe'` is an unknown command to cmd.exe and PowerShell.
    assert.equal(
        harnessCommandLine(["C:\\Users\\A B\\.local\\bin\\claude.exe", "auth", "login"], { CLAUDE_CONFIG_DIR: "C:\\Polyth data\\claude-accounts\\ines" }, "win32"),
        `set "CLAUDE_CONFIG_DIR=C:\\Polyth data\\claude-accounts\\ines" && "C:\\Users\\A B\\.local\\bin\\claude.exe" auth login`,
    );
    assert.equal(harnessCommandLine(["C:\\npm\\codex.cmd", "login"], {}, "win32"), "C:\\npm\\codex.cmd login");
    assert.throws(() => harnessCommandLine(['C:\\x"y.exe'], {}, "win32"), { code: "invalid-input" });
});
