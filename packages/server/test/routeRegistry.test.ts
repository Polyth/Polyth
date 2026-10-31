import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "../src/http.ts";
import { agentBetaBlocksPackageRoute, createRouteRegistry } from "../src/routeRegistry.ts";

const request = { path: "/api/test" } as RouteRequest;

test("registered routes run in insertion order until one handles", async () => {
  const registry = createRouteRegistry();
  const calls: string[] = [];
  registry.add("first", async () => {
    calls.push("first");
    return false;
  });
  registry.add("second", async () => {
    calls.push("second");
    return true;
  });
  registry.add("third", async () => {
    calls.push("third");
    return true;
  });

  assert.equal(await registry.handler(request), true);
  assert.deepEqual(calls, ["first", "second"]);
});

test("disposing a registration removes only that route", async () => {
  const registry = createRouteRegistry();
  const first = registry.add("feature", async () => true);

  assert.equal(await registry.handler(request), true);
  await first.dispose();
  assert.equal(await registry.handler(request), false);

  const replacement = registry.add("feature", async () => true);
  await first.dispose();
  assert.equal(await registry.handler(request), true);
  await replacement.dispose();
  assert.equal(await registry.handler(request), false);
});


test("agent beta route guard blocks direct filesystem writers without blocking package settings", () => {
  assert.equal(agentBetaBlocksPackageRoute("commands", { method: "POST", path: "/api/commands" }, true), true);
  assert.equal(agentBetaBlocksPackageRoute("commands", { method: "DELETE", path: "/api/snippets" }, true), true);
  assert.equal(agentBetaBlocksPackageRoute("commands", { method: "POST", path: "/api/skills" }, true), true);
  assert.equal(agentBetaBlocksPackageRoute("editor", { method: "POST", path: "/api/editor/language/rename-apply" }, true), true);

  assert.equal(agentBetaBlocksPackageRoute("files", { method: "POST", path: "/api/files/write" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("git", { method: "POST", path: "/api/git/checkout" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("terminal", { method: "POST", path: "/api/terminals" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("git", { method: "PUT", path: "/api/git/settings" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("files", { method: "PUT", path: "/api/files/settings" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("editor", { method: "POST", path: "/api/editor/language" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("browser", { method: "POST", path: "/api/browser/sessions" }, true), false);
  assert.equal(agentBetaBlocksPackageRoute("commands", { method: "POST", path: "/api/commands" }, false), false);
});
