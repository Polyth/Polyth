import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import {
  SERVER_DELEGATION_POLICY,
  SERVER_MODEL_FAVORITES,
  SERVER_MODEL_ROUTING,
  SERVER_RUNTIME_CATALOG,
  type ServerDelegationPolicyService,
  type ServerModelRoutingOptions,
  type ServerPackageHost,
} from "@polyth/plugins";
import { DEFAULT_POLICY, type ModelOptionsResponse, type OrchestrationState } from "../src/contracts.ts";
import registerPackage from "../src/serverEntry.ts";

const ctx = (spaceId: string, userId: string) => ({ spaceId, userId, role: "member", spaceSlug: spaceId, storageDir: "" }) as unknown as SpaceContext;

function fixture(t: TestContext, options: { routing?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestration-routes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provided = new Map<unknown, unknown>();
  const seen: ServerModelRoutingOptions[] = [];
  const routing = {
    candidates: async (_space: SpaceContext, o: ServerModelRoutingOptions & { pairs?: readonly string[] } = {}) => {
      seen.push(o);
      const keys = o.pairs ? [...o.pairs] : ["claude::anthropic/sonnet"];
      return {
        windowDays: 30, generatedAt: 1, quotas: [], omitted: 0, unlisted: 0,
        candidates: keys.filter((k) => k !== "claude::anthropic/gone").map((k) => {
          const [harnessId, rest] = k.split("::") as [string, string];
          const [providerID, ...m] = rest.split("/");
          const modelID = m.join("/");
          const runs = modelID === "opus" || modelID === "default" ? { runs: "Claude Opus 5.5" } : {};
          return { harnessId, providerID: providerID!, modelID, ...runs, listed: true, favorite: false, turns: 3, sessions: 1, failed: 0, available: true, blocked: false };
        }),
        text: "SHORTLIST",
      };
    },
  };
  const services = new Map<unknown, unknown>([
    ...(options.routing === false ? [] : [[SERVER_MODEL_ROUTING, routing] as [unknown, unknown]]),
    [SERVER_MODEL_FAVORITES, { favorites: () => ["claude::anthropic/sonnet"] }],
    [SERVER_RUNTIME_CATALOG, { models: async () => [{ harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Claude Sonnet 5.5", capabilities: ["input:image"] }] }],
  ]);
  const host = {
    spaceStorage: (space: SpaceContext) => ({
      packageDir: (id: string) => { const dir = join(root, space.spaceId, "packages", id); mkdirSync(dir, { recursive: true }); return dir; },
    }),
    services: {
      get: (key: unknown) => services.get(key) ?? (typeof key === "object" && (key as { id?: string }).id === "polyth.service.harnesses" ? { get: (id: string) => id === "claude" ? {} : undefined } : undefined),
      provide: (key: unknown, value: unknown) => { provided.set(key, value); },
    },
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const call = async (space: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const handled = await pkg.routes!({
      method, path, url: new URL(`http://localhost${path}`), space,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    return { handled, status, body: payload as any };
  };
  return { call, provided, seen, root, pkg };
}

const alice = ctx("space", "alice");
const bob = ctx("space", "bob");
const roles = { ...DEFAULT_POLICY, mode: "roles", roles: [{ id: "explore", models: [{ harnessId: "claude", providerID: "anthropic", modelID: "sonnet" }, { harnessId: "claude", providerID: "anthropic", modelID: "gone" }] }], excluded: ["cursor::cursor/grok-4.7"] };

test("GET returns default state with the shortlist only; non-orchestration paths are not handled", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(alice, "GET", "/api/other")).handled, false);
  const { status, body } = await f.call(alice, "GET", "/api/orchestration");
  assert.equal(status, 200);
  const state = body as OrchestrationState;
  assert.equal(state.policy.revision, "default");
  assert.equal(state.agentText, "SHORTLIST");
  assert.equal(state.routingAvailable, true);
});

test("PUT saves, state carries brief + shortlist, exclude passed to routing, conflict is 409", async (t) => {
  const f = fixture(t);
  const put = await f.call(alice, "PUT", "/api/orchestration/policy", { policy: roles, expectedRevision: "default" });
  assert.equal(put.status, 200);
  const state = put.body as OrchestrationState;
  assert.match(state.agentText, /^Routing policy[\s\S]*\n\nSHORTLIST$/);
  assert.match(state.agentText, /gemini|claude anthropic\/sonnet/);
  assert.match(state.agentText, /skipped now: claude anthropic\/gone \(no longer offered\)/);
  assert.deepEqual(f.seen.at(-1)?.exclude, ["cursor::cursor/grok-4.7"]);
  const stale = await f.call(alice, "PUT", "/api/orchestration/policy", { policy: roles, expectedRevision: "default" });
  assert.equal(stale.status, 409);
  const bad = await f.call(alice, "PUT", "/api/orchestration/policy", { policy: { ...roles, mode: "x" }, expectedRevision: state.policy.revision });
  assert.equal(bad.status, 400);
});

test("preview resolves a draft but returns the saved policy; invalid draft is 400", async (t) => {
  const f = fixture(t);
  const { body, status } = await f.call(alice, "POST", "/api/orchestration/preview", { policy: roles });
  assert.equal(status, 200);
  assert.equal(body.policy.revision, "default");
  assert.match(body.agentText, /^Routing policy/);
  assert.equal((await f.call(alice, "POST", "/api/orchestration/preview", { policy: 5 })).status, 400);
});

test("policies are per person; a foreign person never sees another's; DELETE resets", async (t) => {
  const f = fixture(t);
  await f.call(alice, "PUT", "/api/orchestration/policy", { policy: roles, expectedRevision: "default" });
  assert.equal((await f.call(bob, "GET", "/api/orchestration")).body.policy.mode, "auto");
  assert.equal((await f.call(alice, "GET", "/api/orchestration")).body.policy.mode, "roles");
  // a person id in the body is never consulted
  assert.equal((await f.call(bob, "GET", "/api/orchestration", { userId: "alice" })).body.policy.mode, "auto");
  const reset = await f.call(alice, "DELETE", "/api/orchestration/policy");
  assert.equal(reset.body.policy.revision, "default");
  assert.deepEqual(readdirSync(join(f.root, "space/packages/orchestration/people")), []);
});

test("models and recommend", async (t) => {
  const f = fixture(t);
  const models = (await f.call(alice, "GET", "/api/orchestration/models")).body as ModelOptionsResponse;
  assert.equal(models.models[0]!.favorite, true);
  assert.equal(models.models[0]!.vision, true);
  assert.equal(models.models[0]!.available, true);
  const rec = await f.call(alice, "POST", "/api/orchestration/recommend");
  assert.equal(rec.body.policy.mode, "roles");
  assert.equal(rec.body.policy.roles[0].models[0].modelID, "sonnet");
});

test("without the Usage package: fallback sentence, routingAvailable false", async (t) => {
  const f = fixture(t, { routing: false });
  const { body } = await f.call(alice, "GET", "/api/orchestration");
  assert.equal(body.routingAvailable, false);
  assert.match(body.agentText, /^Model routing is unavailable: the Usage package is disabled\./);
  assert.deepEqual(body.shortlist.rows, []);
});

test("oversized body is rejected; service brief: auto → undefined, roles → text + exclude", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(alice, "POST", "/api/orchestration/preview", { policy: roles, pad: "x".repeat(70_000) })).status, 400);
  const service = f.provided.get(SERVER_DELEGATION_POLICY) as ServerDelegationPolicyService;
  await f.pkg.onEnable?.();
  assert.equal(await service.brief(alice), undefined);
  await f.call(alice, "PUT", "/api/orchestration/policy", { policy: roles, expectedRevision: "default" });
  const brief = await service.brief(alice, { harnessId: "claude" });
  assert.deepEqual(brief?.exclude, ["cursor::cursor/grok-4.7"]);
  assert.match(brief!.text, /use claude anthropic\/sonnet/);
  assert.equal(await service.brief(bob), undefined);
});

test("a disabled package gives agents no brief; an alias of an excluded model is excluded in roles too; shortlist rows carry catalog names", async (t) => {
  const f = fixture(t);
  const service = f.provided.get(SERVER_DELEGATION_POLICY) as ServerDelegationPolicyService;
  const policy = {
    ...DEFAULT_POLICY,
    mode: "roles",
    roles: [{ id: "review", models: [{ harnessId: "claude", providerID: "anthropic", modelID: "default" }, { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" }] }],
    excluded: ["claude::anthropic/opus"],
  };
  const put = await f.call(alice, "PUT", "/api/orchestration/policy", { policy, expectedRevision: "default" });
  const review = (put.body as OrchestrationState).roles.find((role) => role.id === "review")!;
  assert.equal(review.choices[0]!.status, "excluded", "default runs the excluded Opus");
  assert.equal(review.pick, 1);
  assert.equal((put.body as OrchestrationState).shortlist.rows[0]!.name, "Claude Sonnet 5.5");

  assert.equal(await service.brief(alice), undefined, "not enabled yet");
  await f.pkg.onEnable?.();
  assert.match((await service.brief(alice))!.text, /use claude anthropic\/sonnet/);
  await f.pkg.onDisable?.();
  assert.equal(await service.brief(alice), undefined, "disabled again");
});
