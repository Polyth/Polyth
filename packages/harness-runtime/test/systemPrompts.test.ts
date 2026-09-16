import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessProvider, SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { createHarnessRegistry } from "../src/index.ts";
import registerPackage, { harnessRoutes } from "../src/serverEntry.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

type Fixture = {
  root: string;
  space: SpaceContext;
  storage: SpaceStorage;
  host: ServerPackageHost;
  harnesses: ReturnType<typeof createHarnessRegistry>;
  capabilities: ReturnType<typeof createCapabilityContributionRegistry>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-system-prompts-"));
  const space = {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    storageDir: root,
  } as SpaceContext;
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const harnesses = createHarnessRegistry();
  harnesses.register({
    descriptor: { id: "claude", name: "Claude Code", integration: "test", priority: 10 },
    async probe() {
      return { harnessId: "claude", state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
    },
    async createRuntime() {
      throw new Error("runtime is not used by this test");
    },
  } as HarnessProvider);
  const capabilities = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), harnesses);
  services.provide(serverServiceKey("harness.capabilities"), capabilities);
  const host = {
    pluginId: "harness-runtime",
    services: bindPackageServices(services, "harness-runtime"),
    spaceStorage: () => storage,
    forSpace: () => ({ projects: {}, sessions: {} }),
  } as unknown as ServerPackageHost;
  return { root, space, storage, host, harnesses, capabilities };
}

test("configured harness system prompt resolves as a harness-targeted instruction and unregisters with the package", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "harnesses"), { recursive: true });
  await writeFile(
    join(f.root, "harnesses", "preferences.json"),
    JSON.stringify({ claude: { enabled: true, priority: 10, systemPrompt: "Prefer terse answers." } }),
  );

  const pkg = registerPackage(f.host);
  await pkg.onEnable?.();
  const context = { space: f.space, spaceId: f.space.spaceId, projectId: "p", cwd: "/project" };
  const prompt = f.capabilities.resolve(context).find((descriptor) => descriptor.id === "harness-runtime.system-prompt.claude");
  assert.equal(prompt?.kind, "instruction");
  assert.equal(prompt?.kind === "instruction" ? prompt.text : undefined, "Prefer terse answers.");
  assert.equal((prompt as typeof prompt & { targetHarnessId?: string } | undefined)?.targetHarnessId, "claude");

  await pkg.onDisable?.();
  assert.equal(f.capabilities.resolve(context).length, 0);
});

test("system prompt API preserves routing preferences and routing preference updates preserve the prompt", async () => {
  const f = await fixture();
  const route = harnessRoutes(f.host);
  await mkdir(join(f.root, "harnesses"), { recursive: true });
  await writeFile(
    join(f.root, "harnesses", "preferences.json"),
    JSON.stringify({ claude: { enabled: false, priority: 42 } }),
  );

  const invoke = async (method: "GET" | "PUT", path: string, body: unknown = {}) => {
    let status = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    const request = {
      path: url.pathname,
      method,
      url,
      space: f.space,
      body: async () => body,
      json(nextStatus: number, nextBody: unknown) {
        status = nextStatus;
        responseBody = nextBody;
      },
    } as RouteRequest;
    const handled = await route(request);
    return { handled, status, body: responseBody };
  };

  const saved = await invoke("PUT", "/api/harnesses/claude/system-prompt", { systemPrompt: "Use XML only when asked." });
  assert.equal(saved.handled, true);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { systemPrompt: "Use XML only when asked." });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8")),
    { claude: { enabled: false, priority: 42, systemPrompt: "Use XML only when asked." } },
  );

  await invoke("PUT", "/api/harnesses/preferences", {
    preferences: { claude: { enabled: true, priority: 0 } },
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8")),
    { claude: { enabled: true, priority: 0, systemPrompt: "Use XML only when asked." } },
  );

  const cleared = await invoke("PUT", "/api/harnesses/claude/system-prompt", { systemPrompt: "   " });
  assert.deepEqual(cleared.body, { systemPrompt: "" });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8")),
    { claude: { enabled: true, priority: 0 } },
  );
  assert.deepEqual((await invoke("GET", "/api/harnesses/claude/system-prompt")).body, { systemPrompt: "" });
});
