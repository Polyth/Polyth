import test from "node:test";
import assert from "node:assert/strict";
import registerPackage from "../src/serverEntry.ts";
import { CHAT_BLOCKS_PACKAGE_ID, CHAT_BLOCKS_REFERENCE, CHAT_BLOCKS_RULE, CHAT_BLOCKS_SKILL_NAME } from "../src/rule.ts";

function fakeHost() {
  const sections = new Map<string, () => string>();
  const skills = new Map<string, { descriptor: { name: string; instructions: string; kind: string } }>();
  let changes = 0;
  const behavior = {
    register(id: string, section: () => string) {
      sections.set(id, section);
      return { dispose: () => { sections.delete(id); } };
    },
    changed: async () => { changes += 1; },
  };
  const capabilities = {
    register(owner: string, contribution: { descriptor: { name: string; instructions: string; kind: string } }) {
      skills.set(owner, contribution);
      return { dispose: async () => { skills.delete(owner); } };
    },
  };
  const host = {
    services: {
      get: (key: { id: string }) => key.id.endsWith("behavior.sections") ? behavior
        : key.id.endsWith("harness.capabilities") ? capabilities
          : undefined,
    },
  };
  return { host, sections, skills, changes: () => changes };
}

test("the short rule and the reference skill exist only while the package is enabled", async () => {
  const fake = fakeHost();
  const pkg = registerPackage(fake.host as never);
  assert.equal(pkg.routes, undefined, "no routes: blocks are plain assistant text");
  assert.deepEqual(pkg.remoteAccess, { routeScopes: [CHAT_BLOCKS_PACKAGE_ID], http: [] });

  await pkg.onEnable!();
  await pkg.onEnable!();
  assert.equal(fake.sections.get(CHAT_BLOCKS_PACKAGE_ID)?.(), CHAT_BLOCKS_RULE);
  const skill = fake.skills.get(CHAT_BLOCKS_PACKAGE_ID)?.descriptor;
  assert.deepEqual([skill?.kind, skill?.name, skill?.instructions], ["skill", CHAT_BLOCKS_SKILL_NAME, CHAT_BLOCKS_REFERENCE]);
  assert.equal(fake.changes(), 1, "a repeated enable does not re-project behavior");

  await pkg.onDisable!();
  assert.equal(fake.sections.has(CHAT_BLOCKS_PACKAGE_ID), false);
  assert.equal(fake.skills.has(CHAT_BLOCKS_PACKAGE_ID), false);
  assert.equal(fake.changes(), 2);
  await pkg.onDisable!();
  assert.equal(fake.changes(), 2);
});

test("without host services the package stays inert", async () => {
  const pkg = registerPackage({ services: { get: () => undefined } } as never);
  await pkg.onEnable!();
  await pkg.onDisable!();
});
