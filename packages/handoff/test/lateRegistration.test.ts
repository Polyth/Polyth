import test from "node:test";
import assert from "node:assert/strict";
import {
  createContextSourceRegistry,
  type ContextSourceProvider,
  type ContextSourceRegistry,
} from "../src/index.ts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackage,
} from "@polyth/plugins";

const HANDOFF_SOURCES = serverServiceKey<ContextSourceRegistry>("handoff.sources");

function source(id: string): ContextSourceProvider {
  return {
    id,
    label: id,
    description: `${id} handoff source`,
    async collect() {
      return { sections: [], status: "ok" };
    },
  };
}

test("provider registered after handoff.sources is provided is listed by the registry", () => {
  const services = createServerServiceRegistry();
  const registry = createContextSourceRegistry();
  services.provide(HANDOFF_SOURCES, registry);
  registry.register(source("builtin"));
  registry.register(source("late-provider"));
  const ids = registry.list().map((p) => p.id);
  assert.deepEqual(ids.sort(), ["builtin", "late-provider"]);
});

test("all registerPackage hooks run before onEnable so late providers can attach", async () => {
  const services = createServerServiceRegistry();
  const log: string[] = [];
  let registryAtGitRegister: ContextSourceRegistry | undefined;

  const gitLike: ServerPackage = {
    onEnable() {
      log.push("git:onEnable");
      const registry = services.get(HANDOFF_SOURCES);
      assert.ok(registry, "handoff.sources must exist by git onEnable");
      registry!.register(source("git-diff"));
    },
  };

  const handoffLike = {
    register(host: { services: ReturnType<typeof createServerServiceRegistry> }): ServerPackage {
      log.push("handoff:register");
      const registry = createContextSourceRegistry();
      host.services.provide(HANDOFF_SOURCES, registry);
      registry.register(source("handoff-builtin"));
      return { onEnable() { log.push("handoff:onEnable"); } };
    },
  };

  log.push("git:register");
  registryAtGitRegister = services.get(HANDOFF_SOURCES);
  assert.equal(registryAtGitRegister, undefined, "registry not provided until handoff registerPackage");

  const handoffPkg = handoffLike.register({ services });
  await gitLike.onEnable?.();
  await handoffPkg.onEnable?.();

  const registry = services.require(HANDOFF_SOURCES);
  assert.ok(registry.get("handoff-builtin"));
  assert.ok(registry.get("git-diff"));
  assert.deepEqual(log, ["git:register", "handoff:register", "git:onEnable", "handoff:onEnable"]);
});
