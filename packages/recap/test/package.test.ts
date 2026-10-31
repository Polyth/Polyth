import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentRuntime, RouteRequest, SessionProjection, SpaceContext } from "@polyth/contracts";
import { PROJECT_DIRECTIONS, resolveProjectComposition } from "@polyth/contracts/project-composition";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import { createPackageRegistry } from "../../server/src/packages.ts";
import { createRouteRegistry } from "../../server/src/routeRegistry.ts";
import { createPackageLifecycle } from "../../server/src/packageLifecycle.ts";
import { registerServerPackage } from "../../server/src/packageDiscovery.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/session-assist");
const temporary = (t: { after(fn: () => void): void }) => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("Session Assist starts disabled and is never selected by project recommendations", (t) => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const descriptor = { ...manifest.polyth.descriptor, id: "recap" };
  const registry = createPackageRegistry({ file: join(temporary(t), "packages.json"), descriptors: [descriptor] });
  assert.equal(registry.isEnabled("recap"), false);
  for (const directions of [[], ...PROJECT_DIRECTIONS.map((direction) => [direction]), [...PROJECT_DIRECTIONS]]) {
    const composition = { version: 1 as const, directions, packageOverrides: {} };
    assert.equal(resolveProjectComposition(composition, [registry.get("recap")!]).relevantPackageIds.includes("recap"), false);
    assert.deepEqual(resolveProjectComposition(composition, [{ ...descriptor, enabled: true }]).recommendedPackageIds, []);
  }
});

test("package lifecycle owns prompt routes, account model selection and Space validation", async (t) => {
  const space = { spaceId: "space-1", userId: "user-1" } as SpaceContext;
  const projects = new Map([
    ["p1", { id: "p1", path: "/workspace", spaceId: "space-1" }],
    ["foreign-project", { id: "foreign-project", path: "/foreign", spaceId: "space-2" }],
  ]);
  const projections = new Map<string, SessionProjection>([
    ["s1", { id: "s1", projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1, resolvedHarnessId: "session-harness", model: { providerID: "session-provider", modelID: "session-model" } }],
    ["foreign-session", { id: "foreign-session", projectId: "foreign-project", title: "T", status: "idle", createdAt: 1, updatedAt: 1 }],
  ]);
  const runtimeRoutes: Array<{ projectId: string; cwd?: string; harnessId?: string }> = [];
  const models: string[] = [];
  let subscriptions = 0;
  let historyReads = 0;
  let configured = true;
  let reply: () => Promise<string> = async () => "Improved prompt: Fix the bug.";
  const host = {
    pluginId: "recap", storageDir: temporary(t),
    forSpace: (ctx: SpaceContext) => ({
      projects: { get: async (id: string) => projects.get(id)?.spaceId === ctx.spaceId ? projects.get(id) : null },
      sessions: { snapshot: async (id: string) => {
        const projection = projections.get(id);
        if (!projection || projects.get(projection.projectId)?.spaceId !== ctx.spaceId) {
          throw Object.assign(new Error("unknown session"), { code: "not-found" });
        }
        return projection;
      } },
    }),
    projects: { get: async (id: string) => projects.get(id) },
    store: {
      latestSeq: async () => { historyReads += 1; return 7; },
      events: async () => [],
      projection: async (id: string) => projections.get(id),
    },
    services: { require: () => ({ subscribe: () => {
      subscriptions += 1;
      return { dispose() { subscriptions -= 1; } };
    } }) },
    runtimes: { forProject: async (projectId: string, cwd?: string, harnessId?: string) => {
      runtimeRoutes.push({ projectId, cwd, harnessId });
      return {} as AgentRuntime;
    } },
    smallModel: (userId: string) => {
      assert.equal(userId, "user-1");
      return configured ? { providerID: "utility-provider", modelID: "utility-model", harnessId: "utility-harness" } : undefined;
    },
    smallModelComplete: async (_runtime: AgentRuntime, opts: { maxOutputTokens: number; model?: { modelID: string } }) => {
      assert.equal(opts.maxOutputTokens, 1_024);
      models.push(opts.model?.modelID ?? "default");
      return { text: await reply() };
    },
    // Prompt generation must not attach or activate the user's native session.
    resolveSessionRuntime: async () => { throw new Error("native session must not be activated"); },
  } as unknown as ServerPackageHost;
  const routes = createRouteRegistry();
  const lifecycle = createPackageLifecycle(routes);
  registerServerPackage({ routes, lifecycle }, "recap", registerPackage(host));
  t.after(() => lifecycle.disable("recap"));
  const call = async (path: string) => {
    let status = 0;
    let payload: unknown;
    const handled = await routes.handler({
      space, path, method: "POST", url: new URL(`http://test${path}`),
      body: async () => ({ draft: "fix teh bug" }),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as RouteRequest);
    return { handled, status, payload };
  };
  const sessionPath = "/api/sessions/s1/assist/suggestion";
  const projectPath = "/api/projects/p1/assist/prompt";
  assert.equal((await call(sessionPath)).handled, false);
  assert.equal((await call(projectPath)).handled, false);
  await lifecycle.enable("recap");
  assert.equal(subscriptions, 1);
  assert.deepEqual((await call(sessionPath)).payload, { suggestion: "Fix the bug.", atSeq: 7 });
  assert.deepEqual((await call(projectPath)).payload, { suggestion: "Fix the bug.", atSeq: 0 });
  assert.equal(runtimeRoutes[0]?.harnessId, "utility-harness");
  assert.equal(models[0], "utility-model");

  const before = { calls: models.length, reads: historyReads };
  const foreign = await call("/api/sessions/foreign-session/assist/suggestion");
  assert.deepEqual(foreign, await call("/api/sessions/missing-session/assist/suggestion"));
  assert.equal(foreign.status, 404);
  assert.deepEqual(await call("/api/projects/foreign-project/assist/prompt"), await call("/api/projects/missing-project/assist/prompt"));
  assert.deepEqual({ calls: models.length, reads: historyReads }, before);

  configured = false;
  assert.equal((await call(sessionPath)).status, 200);
  assert.equal(runtimeRoutes.at(-1)?.harnessId, "session-harness");
  assert.equal(models.at(-1), "session-model");

  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  reply = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return "Too late."; };
  const pending = call(sessionPath);
  await entered;
  await lifecycle.disable("recap");
  assert.equal(subscriptions, 0);
  release();
  assert.equal((await pending).status, 409);
  assert.equal((await call(sessionPath)).handled, false);
  assert.equal((await call(projectPath)).handled, false);
  await lifecycle.enable("recap");
  assert.equal(subscriptions, 1);
  reply = async () => "Fix it.";
  assert.equal((await call(sessionPath)).status, 200);
});
