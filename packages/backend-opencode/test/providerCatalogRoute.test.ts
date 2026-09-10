import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  HarnessContext,
  HarnessProvider,
  ModelDescriptor,
  RouteRequest,
  SpaceContext,
} from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerOpenCodePackage, { catalogFromOpenCodeModels } from "../src/serverEntry.ts";
import { LOCAL_OPENCODE_AUTH_PROJECT_ID } from "../src/providerAuthTarget.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/spaces/a",
};

const liveModels: ModelDescriptor[] = [
  {
    providerID: "anthropic",
    providerName: "Anthropic",
    modelID: "claude-sonnet",
    name: "Claude Sonnet",
    connected: true,
  },
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5",
    name: "GPT-5",
    connected: false,
  },
];

test("fallback catalog groups connected OpenCode models and drops disconnected rows", () => {
  const catalog = catalogFromOpenCodeModels(liveModels);
  assert.deepEqual(catalog.map((entry) => entry.id), ["anthropic"]);
  assert.equal(catalog[0]?.status, "ready");
  assert.deepEqual(catalog[0]?.models.map((model) => model.modelID), ["claude-sonnet"]);
});

const install = (opts: {
  models?: ModelDescriptor[];
  visibility?: {
    catalog(models: ModelDescriptor[]): unknown;
    seed?(): Promise<void>;
  };
}) => {
  const pkg = registerOpenCodePackage({
    services: {
      require(key: { id: string }) {
        if (key.id === "polyth.service.harnesses") {
          return { register(_provider: HarnessProvider) { return { dispose() {} }; } };
        }
        if (key.id === "polyth.service.opencode.runtime") {
          return async (_context: HarnessContext): Promise<AgentRuntime> => ({
            models: async () => opts.models ?? liveModels,
            agents: async () => [],
            capabilities: async () => ({
              streaming: true,
              permissions: true,
              questions: true,
              compaction: true,
              subagents: true,
              resume: true,
            }),
          } as unknown as AgentRuntime);
        }
        throw new Error(`unexpected required service ${key.id}`);
      },
      get(key: { id: string }) {
        if (key.id === "polyth.service.models.visibility") return opts.visibility;
        return undefined;
      },
    },
    storageDir: "/host/storage",
  } as unknown as ServerPackageHost);
  return pkg;
};

const getProviders = async (pkg: ReturnType<typeof install>, path = "/api/opencode/providers") => {
  let status = 0;
  let body: unknown;
  const handled = await pkg.routes!({
    path,
    method: "GET",
    url: new URL(`http://127.0.0.1${path}`),
    space,
    json(code, payload) {
      status = code;
      body = payload;
    },
  } as RouteRequest);
  return { handled, status, body };
};

test("OpenCode providers route does not return an empty catalog when models exist", async () => {
  const pkg = install({});
  const result = await getProviders(pkg);
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  const catalog = result.body as Array<{ id: string }>;
  assert.deepEqual(catalog.map((entry) => entry.id), ["anthropic"]);
});

test("OpenCode providers route seeds visibility and uses its catalog", async () => {
  let seeded = 0;
  const pkg = install({
    visibility: {
      async seed() { seeded += 1; },
      catalog(models) {
        return models.map((model) => ({ id: `vis:${model.providerID}`, connected: model.connected !== false }));
      },
    },
  });
  const result = await getProviders(pkg);
  assert.equal(seeded, 1);
  assert.equal(result.status, 200);
  const catalog = result.body as Array<{ id: string }>;
  assert.deepEqual(catalog.map((entry) => entry.id), ["vis:anthropic", "vis:openai"]);
});

test("OpenCode providers route ignores unrelated paths", async () => {
  const pkg = install({});
  const result = await getProviders(pkg, "/api/other");
  assert.equal(result.handled, false);
  assert.equal(result.status, 0);
});

test("OpenCode providers discovery uses the local metadata authority", async () => {
  const calls: string[] = [];
  const pkg = registerOpenCodePackage({
    services: {
      require(key: { id: string }) {
        if (key.id === "polyth.service.harnesses") {
          return { register(_provider: HarnessProvider) { return { dispose() {} }; } };
        }
        if (key.id === "polyth.service.opencode.runtime") {
          return async (context: HarnessContext): Promise<AgentRuntime> => {
            calls.push(context.projectId);
            return {
              models: async () => liveModels,
              agents: async () => [],
              capabilities: async () => ({
                streaming: true,
                permissions: true,
                questions: true,
                compaction: true,
                subagents: true,
                resume: true,
              }),
            } as unknown as AgentRuntime;
          };
        }
        throw new Error(`unexpected required service ${key.id}`);
      },
      get: () => undefined,
    },
    storageDir: "/host/storage",
  } as unknown as ServerPackageHost);
  await getProviders(pkg);
  assert.deepEqual(calls, [LOCAL_OPENCODE_AUTH_PROJECT_ID]);
});
