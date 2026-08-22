import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "../src/http.ts";
import { createRouteRegistry } from "../src/routeRegistry.ts";

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
