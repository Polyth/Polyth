import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { SECURE_SAFE_PACKAGE_ID, secureSafeSkill } from "../src/agentSkill.ts";
import { secureSafeBehaviorSection } from "../src/index.ts";
import { createCredentialVaultListAgentTool, createCredentialVaultRequestAgentTool } from "../src/agentTool.ts";
import registerPackage from "../src/serverEntry.ts";

const SKILL_ID = `${SECURE_SAFE_PACKAGE_ID}.skill.polyth-secure-safe`;

const context = (overrides: Partial<HarnessContext> = {}): HarnessContext => ({
  spaceId: "spc_a",
  projectId: "project-a",
  cwd: "/tmp/project-a",
  remote: false,
  ...overrides,
} as HarnessContext);

function fixture() {
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const host = {
    pluginId: SECURE_SAFE_PACKAGE_ID,
    services: bindPackageServices(services, SECURE_SAFE_PACKAGE_ID),
  } as unknown as ServerPackageHost;
  return { registry, host };
}

test("Credential Vault package contributes an inherited deployment skill", async () => {
  const { registry, host } = fixture();
  const pkg = registerPackage(host);
  await pkg.onEnable?.();

  const skill = registry.contribution(SKILL_ID);
  assert.ok(skill, "Credential Vault skill must be registered");
  const descriptor = skill.descriptor;
  assert.equal(descriptor.id, SKILL_ID);
  assert.equal(descriptor.kind, "skill");
  assert.equal(descriptor.owner, SECURE_SAFE_PACKAGE_ID);
  assert.equal(descriptor.scope, "deployment");
  if (descriptor.kind !== "skill") throw new Error("Credential Vault contribution must be a skill");
  assert.equal(descriptor.name, "polyth-secure-safe");
  assert.match(descriptor.description, /never handle secret values in chat/i);
  assert.match(descriptor.instructions, /Sensitive data: yes/);
  assert.match(descriptor.instructions, /secureSafe/);
  assert.match(descriptor.instructions, /polyth_credential_vault_request/);
  assert.match(descriptor.instructions, /Do not refuse/);
  assert.match(descriptor.instructions, /POLYTH_SAFE_/);
  assert.match(descriptor.instructions, /composer-shell|runShell/);
  assert.match(descriptor.instructions, /never ask for it in chat/);

  assert.equal(registry.resolve(context()).some((row) => row.id === SKILL_ID), true);
  const listTool = registry.contribution("secure-safe.credential-vault-list");
  assert.ok(listTool, "Credential Vault list tool must be registered");
  assert.equal(listTool?.descriptor.kind, "tool");
  assert.equal(listTool?.descriptor.scope, "project");
  assert.match(listTool?.descriptor.description ?? "", /current task needs a stored credential or handle/i);
  const requestTool = registry.contribution("secure-safe.credential-vault-request");
  assert.ok(requestTool, "Credential Vault request tool must be registered");
  assert.equal(requestTool?.descriptor.kind, "tool");
  assert.equal(requestTool?.descriptor.scope, "project");
  assert.equal(registry.resolve(context({ spaceId: "spc_b", projectId: "project-b" }))
    .some((row) => row.id === SKILL_ID), true);

  await pkg.onDisable?.();
  assert.equal(registry.contribution(SKILL_ID), undefined);
});

test("re-enabling Credential Vault never registers a duplicate skill", async () => {
  const { registry, host } = fixture();
  const pkg = registerPackage(host);
  await pkg.onEnable?.();
  await pkg.onEnable?.();
  assert.equal(registry.list().filter((row) => row.descriptor.id === SKILL_ID).length, 1);
  await pkg.onDisable?.();
  await pkg.onDisable?.();
  assert.equal(registry.contribution(SKILL_ID), undefined);
});

test("secureSafeSkill is a namespaced deployment-scoped skill descriptor", () => {
  assert.equal(secureSafeSkill.descriptor.kind, "skill");
  assert.equal(secureSafeSkill.descriptor.scope, "deployment");
  assert.equal(secureSafeSkill.descriptor.id.startsWith(`${SECURE_SAFE_PACKAGE_ID}.`), true);
});

test("Credential Vault behavior is conditional and does not enumerate handles by default", () => {
  const section = secureSafeBehaviorSection("/private/forbidden-config.json", {
    version: 1,
    handles: [],
  });

  assert.match(section, /only when the current task needs/i);
  assert.match(section, /For unrelated tasks, do not call Credential Vault tools/i);
  assert.doesNotMatch(section, /polyth_credential_vault_list/);
  // Agents learn the form exists before they load the skill, so they offer
  // it instead of refusing the credential.
  assert.match(section, /polyth_credential_vault_request/);
  assert.doesNotMatch(section, /forbidden-config\.json/);
});

test("Credential Vault list tool returns only current-project metadata", async () => {
  const tool = createCredentialVaultListAgentTool(() => ({
    list: () => [
      { handle: "GLOBAL_TOKEN", label: "Global", purpose: "all", kind: "token", scope: "global" },
      { handle: "PROJECT_PASSWORD", label: "Project", purpose: "local", kind: "password", scope: "project", projectId: "project-a" },
      { handle: "FOREIGN_PASSWORD", label: "Foreign", purpose: "other", kind: "password", scope: "project", projectId: "project-b" },
    ],
  } as never));
  const result = await tool.execute?.({}, {
    sessionId: "session-a",
    projectId: "project-a",
    cwd: "/tmp/project-a",
    spaceId: "space-a",
  });
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.output), {
    handles: [
      { handle: "GLOBAL_TOKEN", label: "Global", purpose: "all", kind: "token", scope: "global", partition: "space", envRef: "POLYTH_SAFE_GLOBAL_TOKEN" },
      { handle: "PROJECT_PASSWORD", label: "Project", purpose: "local", kind: "password", scope: "project", partition: "space", envRef: "POLYTH_SAFE_PROJECT_PASSWORD" },
    ],
  });
  assert.doesNotMatch(result.output, /FOREIGN|secret|value/i);
});

const toolContext = {
  sessionId: "session-a",
  projectId: "project-a",
  cwd: "/tmp/project-a",
  spaceId: "space-a",
};

test("Credential Vault request tool opens the form and returns only the handle and outcome", async () => {
  const tool = createCredentialVaultRequestAgentTool();
  const asked: unknown[] = [];
  const saved = await tool.execute?.({ handle: "STRIPE_KEY", label: "Stripe key", purpose: "Billing", kind: "env" }, {
    ...toolContext,
    requestSecret: async (request) => {
      asked.push(request);
      return { requestId: "vault_1", action: "saved", handle: request.handle };
    },
  });
  assert.deepEqual(asked, [{ handle: "STRIPE_KEY", label: "Stripe key", purpose: "Billing", kind: "env" }]);
  const output = JSON.parse(saved?.output ?? "{}");
  assert.equal(output.status, "saved");
  assert.equal(output.envRef, "POLYTH_SAFE_STRIPE_KEY");
  assert.equal(output.value, undefined);

  const dismissed = await tool.execute?.({ handle: "STRIPE_KEY", label: "Stripe key" }, {
    ...toolContext,
    requestSecret: async (request) => ({ requestId: "vault_2", action: "dismissed", handle: request.handle }),
  });
  assert.equal(JSON.parse(dismissed?.output ?? "{}").status, "dismissed");
});

test("Credential Vault request tool validates input and never falls back without the form", async () => {
  const tool = createCredentialVaultRequestAgentTool();
  const never = async (): Promise<never> => { throw new Error("must not open the form"); };
  await assert.rejects(tool.execute!({ handle: "1bad", label: "x" }, { ...toolContext, requestSecret: never }),
    (error: { code?: string }) => error.code === "invalid-input");
  await assert.rejects(tool.execute!({ handle: "OK" }, { ...toolContext, requestSecret: never }),
    (error: { code?: string }) => error.code === "invalid-input");
  await assert.rejects(tool.execute!({ handle: "OK", label: "x", kind: "secret" }, { ...toolContext, requestSecret: never }),
    (error: { code?: string }) => error.code === "invalid-input");
  await assert.rejects(tool.execute!({ handle: "OK", label: "x" }, toolContext),
    (error: { code?: string }) => error.code === "unavailable");
});
