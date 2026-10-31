import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import {
  catalogFromSnapshots,
  effectiveRoute,
  findCatalogModel,
  overriddenRoles,
  routeIsAvailable,
  summarizeModels,
  toStudioModelRef,
} from "../widgets/modelCatalog.ts";

const model = (over: Partial<ModelDescriptor> = {}): ModelDescriptor =>
  ({ providerID: "anthropic", modelID: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", ...over });

const snapshot = (id: string, models: ModelDescriptor[]): HarnessSnapshot =>
  ({ identity: { id, name: id, integration: "test" }, catalog: { models } } as unknown as HarnessSnapshot);

test("the catalog flattens every harness and stamps its identity", () => {
  const rows = catalogFromSnapshots([
    snapshot("opencode", [model()]),
    // A model that already names its harness keeps it instead of being relabelled.
    snapshot("claude", [model({ harnessId: "claude", modelID: "opus", name: "Opus" })]),
  ]);
  assert.deepEqual(rows.map((row) => `${row.harnessId}:${row.modelID}`), ["opencode:claude-sonnet-4-5", "claude:opus"]);
});

test("picker selections become routes and keep only advertised variants", () => {
  const withVariants = model({ harnessId: "claude", variants: ["low", "high"] });
  assert.deepEqual(toStudioModelRef(withVariants, "high", withVariants.variants), {
    harnessId: "claude", providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high",
  });
  // An unadvertised variant is dropped rather than stored as a broken route.
  assert.deepEqual(toStudioModelRef(withVariants, "max", withVariants.variants), {
    harnessId: "claude", providerID: "anthropic", modelID: "claude-sonnet-4-5",
  });
  // With no advertised list the picker's own selection is trusted as given.
  assert.equal(toStudioModelRef(withVariants, "max")?.variant, "max");
  assert.equal(toStudioModelRef(model(), undefined)?.harnessId, undefined, "no harness id means no route");
  assert.equal(toStudioModelRef(undefined), undefined);
});

test("routes resolve against the live catalog and unavailable ones are flagged", () => {
  const catalog = [model({ harnessId: "opencode" })];
  const route = { harnessId: "opencode", providerID: "anthropic", modelID: "claude-sonnet-4-5" };
  assert.equal(findCatalogModel(catalog, route)?.name, "Claude Sonnet 4.5");
  assert.equal(routeIsAvailable(catalog, route), true);
  assert.equal(routeIsAvailable(catalog, { ...route, modelID: "gone" }), false);
  assert.equal(routeIsAvailable(catalog, undefined), true, "no route is always fine");
});

test("summary marks inherited parts and effective routes fall back to the session", () => {
  const route = { harnessId: "opencode", providerID: "anthropic", modelID: "claude-sonnet-4-5" };
  const summary = summarizeModels({ default: route, roles: { code: route } }, [model({ harnessId: "opencode" })]);
  assert.equal(summary.fallbackAvailable, true);
  assert.deepEqual(summary.roles.map((row) => [row.role, row.inherited]), [
    ["plan", true], ["descriptions", true], ["code", false], ["review", true], ["report", true],
  ]);
  assert.deepEqual(effectiveRoute({ default: route }, "plan"), route, "an unrouted part follows the session");
  assert.equal(effectiveRoute({}, "plan"), undefined);
  assert.deepEqual(effectiveRoute(undefined, "code"), undefined);
});

test("only parts that differ from the session count as overrides", () => {
  const route = { harnessId: "opencode", providerID: "anthropic", modelID: "claude-sonnet-4-5" };
  assert.deepEqual(overriddenRoles({ default: route, roles: { code: { ...route, modelID: "opus" }, plan: route } }), ["code"]);
  assert.deepEqual(overriddenRoles({}), []);
  assert.deepEqual(overriddenRoles(undefined), []);
});
