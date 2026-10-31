import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler, SecureSafeService, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, SPACE_SECURE_SAFE, type ServerPackageHost } from "@polyth/plugins";
import registerJudgment from "../../judgment/src/serverEntry.ts";
import registerAdapter from "../src/serverEntry.ts";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { noul } from "@polyth/judgment";
import type { JudgmentCheckResult, JudgmentSettingsSnapshot } from "@polyth/judgment/settings";

test("adapter integration scopes handles/catalogs, fences credential changes and survives re-enable", async (t) => {
  const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "adapter-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const a = { spaceId: "space-a" } as SpaceContext, b = { spaceId: "space-b" } as SpaceContext;
  const services = createServerServiceRegistry();
  const resolutions: string[] = [];
  services.provide(SPACE_SECURE_SAFE, {
    forSpace(space) { return {
      list: () => [{ handle: "ACCOUNT", label: "Account", scope: "global" }, { handle: "OTHER", label: "Other project", scope: "project", projectId: "foreign-project" }],
      async useCredential(input, use) {
        assert.equal(input.projectId, `project-${space.spaceId}`);
        assert.equal(input.handle, "ACCOUNT");
        resolutions.push(space.spaceId);
        await use(`fixture-${space.spaceId}`);
      },
    } as SecureSafeService; }, forSpaceId: () => undefined,
  });
  const host = { services,
    spaceStorage(space: SpaceContext) { return { packageDir(id: string) { const path = join(root, space.spaceId, id); mkdirSync(path, { recursive: true }); return path; } }; },
    forSpace(space: SpaceContext) { return { projects: { async get(id: string) { return id === `project-${space.spaceId}` ? { id } : undefined; } } }; },
  } as unknown as ServerPackageHost;
  const judgment = registerJudgment(host), adapter = registerAdapter(host);
  await judgment.onEnable?.(); await adapter.onEnable?.();
  t.after(async () => { await adapter.onDisable?.(); await judgment.onDisable?.(); });
  const request = async (space: SpaceContext, path: string, method = "GET", body: unknown = {}) => {
    let snapshot: JudgmentSettingsSnapshot | undefined;
    await judgment.routes!({ path, method, space, url: new URL(`http://localhost${path}?projectId=project-${space.spaceId}`), body: async () => body,
      json: (_status: number, value: JudgmentSettingsSnapshot) => { snapshot = value; } } as unknown as Parameters<RouteHandler>[0]);
    return snapshot!;
  };
  const before = await request(a, "/api/judgment/settings");
  assert.equal(before.providers[0]!.status, "authentication-required");
  assert.deepEqual(before.engineSettings!.handles, [{ handle: "ACCOUNT", label: "Account" }]);
  await assert.rejects(request(a, "/api/judgment/credential", "PUT", { secretHandle: "OTHER" }), /provider-unavailable/);
  await assert.rejects(request(a, "/api/judgment/credential", "PUT", { apiKey: "no plaintext" }), /Credential Vault handle/);
  await request(a, "/api/judgment/credential", "PUT", { secretHandle: "ACCOUNT" });
  assert.equal((await request(b, "/api/judgment/settings")).providers[0]!.status, "authentication-required");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let sentModel: string | undefined, judgmentCalls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-space-a");
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ models: [{ name: "jev-1.13.0" }] }));
    sentModel = JSON.parse(init!.body as string).model;
    if (++judgmentCalls === 1) return new Response(JSON.stringify({ message: "fixture-space-a" }), { status: 503 });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 4, output_tokens: 2 } }));
  };
  await request(a, "/api/judgment/models/refresh", "POST");
  await adapter.onDisable?.(); await adapter.onEnable?.();
  assert.equal((await request(a, "/api/judgment/settings")).providers[0]!.models[0]!.modelID, "jev-1.13.0");
  const service = services.require(JUDGMENT_SERVICE);
  const run = await service.createRun({ space: a, projectId: "project-space-a" });
  const result = await run.judge({ scope: "smoke.v1", state: "private evidence", questions: { q: noul("Done?") }, target: { modelId: "jev-1.13.0" } });
  assert.ok(result.ok); assert.equal(result.attempts, 2); assert.equal(sentModel, "jev-1.13.0");
  assert.ok(resolutions.every((spaceId) => spaceId === "space-a"));
  assert.doesNotMatch(JSON.stringify(result), /fixture-space-a|private evidence/);
  const disk = readFileSync(join(root, "space-a", "judgment-jev", "project-space-a.json"), "utf8");
  assert.doesNotMatch(disk, /fixture-space-a|private evidence/); assert.match(disk, /ACCOUNT/);
  let completeRefresh!: (value: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async () => { started(); return new Promise((resolve) => { completeRefresh = resolve; }); };
  const refreshing = request(a, "/api/judgment/models/refresh", "POST");
  await ready;
  await request(a, "/api/judgment/credential", "PUT", {});
  completeRefresh(new Response(JSON.stringify({ models: [{ name: "jev-stale" }] })));
  const refreshed = await refreshing;
  assert.equal(refreshed.providers[0]!.status, "authentication-required");
  assert.equal(refreshed.providers[0]!.models.some((model) => model.modelID === "jev-stale"), false);
  const oldRun = await run.judge({ scope: "smoke.v1", state: null, questions: { q: noul("Q?") } });
  assert.ok(!oldRun.ok); assert.equal(oldRun.reason, "cancelled");
});

test("routes keep one Vault key each, Automatic never picks the keyless route, and Check proves the effective route", async (t) => {
  const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "routes-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const space = { spaceId: "space-r" } as SpaceContext, projectId = "project-r";
  const services = createServerServiceRegistry();
  services.provide(SPACE_SECURE_SAFE, { forSpace() { return {
    list: () => [{ handle: "TYPESAFE", label: "TypeSafe", scope: "global" }, { handle: "ROUTER", label: "OpenRouter", scope: "global" }],
    async useCredential(input, use) { await use(`secret-${input.handle}`); },
  } as SecureSafeService; }, forSpaceId: () => undefined });
  const host = { services,
    spaceStorage(owner: SpaceContext) { return { packageDir(id: string) { const path = join(root, owner.spaceId, id); mkdirSync(path, { recursive: true }); return path; } }; },
    forSpace() { return { projects: { async get(id: string) { return id === projectId ? { id } : undefined; } } }; },
  } as unknown as ServerPackageHost;
  // A version-1 file from before routes: its single handle is the TypeSafe route's key.
  const file = join(root, space.spaceId, "judgment-jev", `${projectId}.json`);
  mkdirSync(join(root, space.spaceId, "judgment-jev"), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, secretHandle: "TYPESAFE" }));
  const judgment = registerJudgment(host), adapter = registerAdapter(host);
  await judgment.onEnable?.(); await adapter.onEnable?.();
  t.after(async () => { await adapter.onDisable?.(); await judgment.onDisable?.(); });
  const call = async <T = JudgmentSettingsSnapshot>(path: string, method = "GET", body: unknown = {}) => {
    let value: T | undefined;
    await judgment.routes!({ path, method, space, url: new URL(`http://localhost${path}?projectId=${projectId}`), body: async () => body,
      json: (_status: number, next: T) => { value = next; } } as unknown as Parameters<RouteHandler>[0]);
    return value!;
  };
  const status = (snapshot: JudgmentSettingsSnapshot, id: string) => snapshot.providers.find((entry) => entry.provider.id === id)!.status;
  let snapshot = await call("/api/judgment/settings");
  assert.deepEqual(snapshot.engineSettings!.credentials, { typesafe: "TYPESAFE" });
  assert.equal(status(snapshot, "typesafe"), "available"); assert.equal(status(snapshot, "openrouter"), "authentication-required");
  assert.equal(snapshot.providers.find((entry) => entry.provider.id === "openrouter")!.endpoint, "openrouter.ai");
  assert.equal(snapshot.defaultTarget!.providerId, "typesafe");

  snapshot = await call("/api/judgment/credential", "PUT", { providerId: "openrouter", secretHandle: "ROUTER" });
  snapshot = await call("/api/judgment/credential", "PUT", { providerId: "typesafe" });
  assert.deepEqual(snapshot.engineSettings!.credentials, { openrouter: "ROUTER" });
  assert.equal(snapshot.defaultTarget!.providerId, "openrouter", "Automatic moves to the first connected route");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 2, credentials: { openrouter: "ROUTER" } });
  await assert.rejects(call("/api/judgment/credential", "PUT", { providerId: "opencode-zen-free", secretHandle: "ROUTER" }), /provider-unavailable/);
  await assert.rejects(call("/api/judgment/credential", "PUT", { providerId: "elsewhere", secretHandle: "ROUTER" }), /provider-unavailable/);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    sent.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-ROUTER");
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { reachable: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } }));
  };
  const check = await call<JudgmentCheckResult>("/api/judgment/check", "POST");
  assert.equal(check.ok, true); assert.equal(check.providerId, "openrouter"); assert.equal(check.modelId, "jev-1.13.0");
  assert.deepEqual(sent, ["https://openrouter.ai/api/v1/systemone"]);
  assert.doesNotMatch(JSON.stringify(check), /secret|connectivity/);

  // Nothing connected: Automatic stays on the account route and reports it needs setup; it never falls to the free route.
  snapshot = await call("/api/judgment/credential", "PUT", { providerId: "openrouter" });
  assert.equal(snapshot.defaultTarget!.providerId, "typesafe");
  assert.equal(status(snapshot, "opencode-zen-free"), "available");
  globalThis.fetch = async () => { throw new Error("must not send without a connected route"); };
  const refused = await call<JudgmentCheckResult>("/api/judgment/check", "POST");
  assert.equal(refused.ok, false); assert.equal(refused.reason, "provider-unavailable");
});
