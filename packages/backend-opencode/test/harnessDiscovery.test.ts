import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  HarnessContext,
  HarnessProvider,
  ModelDescriptor,
  RuntimeCapabilities,
  SpaceContext,
} from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerOpenCodePackage from "../src/serverEntry.ts";
import { LOCAL_OPENCODE_AUTH_PROJECT_ID } from "../src/providerAuthTarget.ts";

const capabilities: RuntimeCapabilities = {
  streaming: true,
  permissions: true,
  questions: true,
  compaction: true,
  subagents: true,
  resume: true,
};

const metadataRuntime = (models: ModelDescriptor[]): AgentRuntime => ({
  models: async () => models,
  agents: async () => [],
  capabilities: async () => capabilities,
} as unknown as AgentRuntime);

test("OpenCode catalog discovery falls back to its isolated local metadata authority", async () => {
  const space: SpaceContext = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir: "/spaces/a",
  };
  const context: HarnessContext = {
    space,
    spaceId: space.spaceId,
    projectId: "project-a",
    cwd: "/workspace/a",
    remote: false,
  };
  const releaseError = Object.assign(
    new Error("Previous executor has no verified release receipt"),
    { code: "outcome-unknown" },
  );
  const calls: HarnessContext[] = [];
  const pool = async (requested: HarnessContext): Promise<AgentRuntime> => {
    calls.push(requested);
    if (requested.projectId === LOCAL_OPENCODE_AUTH_PROJECT_ID) {
      return metadataRuntime([{
        providerID: "anthropic",
        providerName: "Anthropic",
        modelID: "claude-sonnet",
        name: "Claude Sonnet",
        connected: true,
      }]);
    }
    throw releaseError;
  };
  let harness: HarnessProvider | undefined;
  const registry = {
    register(provider: HarnessProvider) {
      harness = provider;
      return { dispose() {} };
    },
  };
  const services = {
    require(key: { id: string }) {
      if (key.id === "polyth.service.harnesses") return registry;
      if (key.id === "polyth.service.opencode.runtime") return pool;
      throw new Error(`unexpected required service ${key.id}`);
    },
    get: () => undefined,
  };
  registerOpenCodePackage({
    services,
    storageDir: "/host/storage",
  } as unknown as ServerPackageHost);

  const discovery = await harness!.discover!(context);
  assert.deepEqual(discovery.catalog?.models?.map((model) => model.modelID), ["claude-sonnet"]);
  assert.equal(discovery.state, "ready");
  assert.deepEqual(calls.map((call) => ({
    projectId: call.projectId,
    cwd: call.cwd,
    sessionId: call.sessionId,
  })), [
    { projectId: "project-a", cwd: "/workspace/a", sessionId: undefined },
    {
      projectId: LOCAL_OPENCODE_AUTH_PROJECT_ID,
      cwd: "/host/storage",
      sessionId: undefined,
    },
  ]);

  await assert.rejects(() => harness!.createRuntime(context), releaseError);
  assert.equal(
    calls.filter((call) => call.projectId === LOCAL_OPENCODE_AUTH_PROJECT_ID).length,
    1,
    "execution creation must never fall back to the metadata authority",
  );
});

test("OpenCode discovery does not mask remote or ordinary project failures", async () => {
  const space: SpaceContext = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir: "/spaces/a",
  };
  const releaseError = Object.assign(new Error("remote runtime unavailable"), { code: "unavailable" });
  const calls: HarnessContext[] = [];
  let harness: HarnessProvider | undefined;
  registerOpenCodePackage({
    services: {
      require(key: { id: string }) {
        if (key.id === "polyth.service.harnesses") {
          return {
            register(provider: HarnessProvider) {
              harness = provider;
              return { dispose() {} };
            },
          };
        }
        if (key.id === "polyth.service.opencode.runtime") {
          return async (context: HarnessContext) => {
            calls.push(context);
            throw releaseError;
          };
        }
        throw new Error(`unexpected required service ${key.id}`);
      },
      get: () => undefined,
    },
    storageDir: "/host/storage",
  } as unknown as ServerPackageHost);

  await assert.rejects(() => harness!.discover!({
    space,
    spaceId: space.spaceId,
    projectId: "remote-project",
    cwd: "/srv/project",
    remote: true,
  }), releaseError);
  await assert.rejects(() => harness!.discover!({
    space,
    spaceId: space.spaceId,
    projectId: "local-project",
    cwd: "/workspace/local",
    remote: false,
  }), releaseError);
  assert.deepEqual(calls.map((context) => context.projectId), ["remote-project", "local-project"]);
});
