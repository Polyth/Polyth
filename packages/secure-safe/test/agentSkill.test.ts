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
import { secureSafeBehaviorSection, vaultRunApprovalMetadata } from "../src/index.ts";
import { createCredentialVaultListAgentTool, createCredentialVaultRequestAgentTool, createCredentialVaultRunAgentTool } from "../src/agentTool.ts";
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
  const runTool = registry.contribution("secure-safe.credential-vault-run");
  assert.ok(runTool, "Credential Vault run tool must be registered");
  assert.equal(runTool?.descriptor.kind, "tool");
  assert.equal(runTool?.descriptor.scope, "project");
  assert.equal(runTool?.descriptor.kind === "tool" ? runTool.descriptor.trust : undefined, "credentialed");
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

test("Credential Vault run tool refuses commands without an env ref and never runs them", async () => {
  const tool = createCredentialVaultRunAgentTool(() => ({
    run: async () => {
      throw new Error("must not run");
    },
  }));
  await assert.rejects(
    tool.execute!({ command: "echo hello", purpose: "read something" }, toolContext),
    (error: { code?: string; message?: string }) =>
      error.code === "invalid-input" && /no Vault env refs/.test(error.message ?? ""),
  );
  await assert.rejects(
    tool.execute!({ command: "echo $POLYTH_SAFE_KEY", purpose: "x", timeoutSeconds: 5 }, toolContext),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  await assert.rejects(
    tool.execute!({ command: "echo $POLYTH_SAFE_KEY\0", purpose: "x" }, toolContext),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  await assert.rejects(
    tool.execute!({ command: "echo $POLYTH_SAFE_KEY" }, toolContext),
    (error: { code?: string }) => error.code === "invalid-input",
  );
});

test("Credential Vault run tool returns only redacted output, status flags and handle names", async () => {
  const asked: Array<Record<string, unknown>> = [];
  const tool = createCredentialVaultRunAgentTool(() => ({
    run: async (input) => {
      asked.push(input as unknown as Record<string, unknown>);
      return {
        output: "deploy [redacted]\n",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        handles: ["DEPLOY_KEY"],
      };
    },
  }));
  const result = await tool.execute!(
    { command: "deploy --token $POLYTH_SAFE_DEPLOY_KEY", purpose: "Publish", timeoutSeconds: 30 },
    { ...toolContext, actorUserId: "alice" },
  );
  assert.deepEqual(asked, [{
    sessionId: "session-a",
    projectId: "project-a",
    command: "deploy --token $POLYTH_SAFE_DEPLOY_KEY",
    purpose: "Publish",
    actorUserId: "alice",
    timeoutMs: 30_000,
  }]);
  assert.deepEqual(JSON.parse(result!.output), {
    output: "deploy [redacted]\n",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  });
  assert.doesNotMatch(result!.output, /DEPLOY_KEY|secret|value/);
  assert.equal(tool.descriptor.kind === "tool" ? tool.descriptor.trust : undefined, "credentialed");
  assert.equal(tool.descriptor.kind === "tool" ? tool.descriptor.mutating : undefined, true);
});

test("Credential Vault run approval metadata carries the command, refs, purpose and cwd", () => {
  assert.deepEqual(
    vaultRunApprovalMetadata(
      { command: "deploy $POLYTH_SAFE_A $POLYTH_SAFE_B", purpose: "Ship" },
      "/work/project",
    ),
    {
      command: "deploy $POLYTH_SAFE_A $POLYTH_SAFE_B",
      handles: ["POLYTH_SAFE_A", "POLYTH_SAFE_B"],
      purpose: "Ship",
      cwd: "/work/project",
    },
  );
});

test("Credential Vault run tool fails closed without a runner or a canonical session", async () => {
  const tool = createCredentialVaultRunAgentTool(() => undefined);
  await assert.rejects(
    tool.execute!({ command: "echo $POLYTH_SAFE_KEY", purpose: "x" }, toolContext),
    (error: { code?: string }) => error.code === "unavailable",
  );
  const missingSession = createCredentialVaultRunAgentTool(() => ({
    run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false, handles: [] }),
  }));
  await assert.rejects(
    missingSession.execute!({ command: "echo $POLYTH_SAFE_KEY", purpose: "x" }, { ...toolContext, sessionId: "" }),
    (error: { code?: string }) => error.code === "unavailable",
  );
});
