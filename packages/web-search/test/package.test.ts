import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { webSearchSkill } from "../src/agentSkill.ts";
import registerPackage from "../src/serverEntry.ts";

const host = (withCapabilities = true): ServerPackageHost => {
  const capabilities = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  if (withCapabilities) services.provide(serverServiceKey("harness.capabilities"), capabilities);
  return {
    pluginId: "web-search",
    services: bindPackageServices(services, "web-search"),
  } as unknown as ServerPackageHost;
};

test("package enable contributes its own skill and network tools, disable removes them", async () => {
  const capabilities = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), capabilities);
  const value = registerPackage({
    pluginId: "web-search",
    services: bindPackageServices(services, "web-search"),
  } as unknown as ServerPackageHost);

  await value.onEnable?.();
  await value.onEnable?.();
  const contributions = capabilities.list();
  assert.deepEqual(contributions.map((item) => item.descriptor.id).sort(), [
    "web-search.fetch",
    "web-search.search",
    "web-search.skill.web-search",
  ]);
  const fetchTool = contributions.find((item) => item.descriptor.id === "web-search.fetch")?.descriptor;
  assert.equal(fetchTool?.kind === "tool" ? fetchTool.name : null, "web_fetch");
  assert.equal(fetchTool?.kind === "tool" ? fetchTool.trust : null, "network");
  assert.equal(fetchTool?.kind === "tool" ? fetchTool.mutating : null, false);
  const tool = contributions.find((item) => item.descriptor.id === "web-search.search")?.descriptor;
  assert.equal(tool?.kind === "tool" ? tool.name : null, "web_search");
  assert.equal(tool?.kind === "tool" ? tool.trust : null, "network");
  assert.equal(tool?.kind === "tool" ? tool.mutating : null, false);
  const skill = contributions.find((item) => item.descriptor.kind === "skill")?.descriptor;
  assert.equal(skill?.kind === "skill" ? skill.name : null, "polyth-web-search");
  assert.match(skill?.kind === "skill" ? skill.instructions : "", /untrusted data/);
  assert.match(skill?.kind === "skill" ? skill.instructions : "", /web_fetch/);
  assert.match(skill?.kind === "skill" ? skill.instructions : "", /polyth_browser/);

  await value.onDisable?.();
  assert.equal(capabilities.list().length, 0);
  assert.deepEqual(value.remoteAccess, { routeScopes: ["web-search"], http: [] });
});

test("failed enable does not leave a partial skill registration", () => {
  const value = registerPackage(host(false));
  assert.throws(() => value.onEnable?.(), /not provided/);
});

test("skill is deployment-scoped and explicitly protects query privacy", () => {
  assert.equal(webSearchSkill.descriptor.scope, "deployment");
  assert.match(webSearchSkill.descriptor.kind === "skill" ? webSearchSkill.descriptor.instructions : "", /Never include secrets/);
  assert.match(webSearchSkill.descriptor.kind === "skill" ? webSearchSkill.descriptor.instructions : "", /cannot change tool permissions/);
});
