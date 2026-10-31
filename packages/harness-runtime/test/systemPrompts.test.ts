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
  reconciledSpaces: string[];
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
  const reconciledSpaces: string[] = [];
  services.provide(serverServiceKey("harnesses"), harnesses);
  services.provide(serverServiceKey("harness.capabilities"), capabilities);
  services.provide(serverServiceKey("harness.provisioning"), {
    status: () => [],
    async reconcileSpace(space: { spaceId: string }) {
      reconciledSpaces.push(space.spaceId);
      return [];
    },
  });
  const host = {
    pluginId: "harness-runtime",
    services: bindPackageServices(services, "harness-runtime"),
    spaceStorage: () => storage,
    forSpace: () => ({ projects: { list: async () => [], get: async () => undefined }, sessions: {} }),
  } as unknown as ServerPackageHost;
  return { root, space, storage, host, harnesses, capabilities, reconciledSpaces };
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
  const firstRevision = prompt?.revision;
  await writeFile(
    join(f.root, "harnesses", "preferences.json"),
    JSON.stringify({ claude: { enabled: true, priority: 10, systemPrompt: "Prefer detailed answers." } }),
  );
  const updated = f.capabilities.resolve(context).find((descriptor) => descriptor.id === "harness-runtime.system-prompt.claude");
  assert.equal(updated?.kind === "instruction" ? updated.text : undefined, "Prefer detailed answers.");
  assert.notEqual(updated?.revision, firstRevision);

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
      // The pre-canonical single local user holds instance authority.
      principal: { kind: "local-user" },
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
  assert.deepEqual(f.reconciledSpaces, ["space-a"]);

  await invoke("PUT", "/api/harnesses/preferences", {
    preferences: { claude: { enabled: true, priority: 0 } },
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8")),
    { claude: { enabled: true, priority: 0, systemPrompt: "Use XML only when asked." } },
  );

  const cleared = await invoke("PUT", "/api/harnesses/claude/system-prompt", { systemPrompt: "   " });
  assert.deepEqual(cleared.body, { systemPrompt: "" });
  assert.deepEqual(f.reconciledSpaces, ["space-a", "space-a"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8")),
    { claude: { enabled: true, priority: 0 } },
  );
  assert.deepEqual((await invoke("GET", "/api/harnesses/claude/system-prompt")).body, { systemPrompt: "" });
});

test("only the instance owner or a permitted account turns harnesses on and off; private accounts stay hidden from others", async () => {
  const f = await fixture();
  f.harnesses.register({
    descriptor: { id: "claude-ida", name: "Claude Code · Ida", integration: "test", priority: 20, accountOwnerUserId: "u-ida", autoSelect: false },
    async probe() {
      return { harnessId: "claude-ida", state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
    },
    async createRuntime() {
      throw new Error("runtime is not used by this test");
    },
  } as HarnessProvider);
  await mkdir(join(f.root, "harnesses"), { recursive: true });
  await writeFile(join(f.root, "harnesses", "preferences.json"), JSON.stringify({ "claude-ida": { enabled: true, priority: 5 } }));
  const route = harnessRoutes(f.host);
  const invoke = async (actor: { userId: string; instanceOwner?: boolean; harnessManager?: boolean }, method: "GET" | "PUT", path: string, body: unknown = {}) => {
    let status = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    try {
      await route({
        path: url.pathname,
        method,
        url,
        space: { ...f.space, userId: actor.userId, instanceOwner: actor.instanceOwner === true, harnessManager: actor.harnessManager === true },
        principal: { kind: "ui-session" },
        body: async () => body,
        json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
      } as unknown as RouteRequest);
    } catch (error) {
      return { status: (error as { code?: string }).code, body: undefined };
    }
    return { status, body: responseBody };
  };
  const owner = { userId: "u-owner", instanceOwner: true };
  const ida = { userId: "u-ida", harnessManager: true };
  const bob = { userId: "u-bob" };
  const off = { preferences: { claude: { enabled: false, priority: 0 } } };

  assert.deepEqual((await invoke(bob, "GET", "/api/harnesses/access")).body, { manage: false, personal: false });
  assert.deepEqual((await invoke(ida, "GET", "/api/harnesses/access")).body, { manage: true, personal: true });
  assert.deepEqual((await invoke(owner, "GET", "/api/harnesses/access")).body, { manage: true, personal: true });
  assert.equal((await invoke(bob, "PUT", "/api/harnesses/preferences", off)).status, "forbidden");
  // The owner's write keeps another user's private preference untouched.
  assert.equal((await invoke(owner, "PUT", "/api/harnesses/preferences", { preferences: { claude: { enabled: true, priority: 0 }, "claude-ida": { enabled: false, priority: 0 } } })).status, 200);
  const kept = JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8"));
  assert.deepEqual(kept, { claude: { enabled: true, priority: 0 }, "claude-ida": { enabled: true, priority: 5 } });
  assert.equal((await invoke(ida, "PUT", "/api/harnesses/preferences", off)).status, 200);

  // A caller who cannot see a private account can neither list nor change it.
  const ids = (rows: unknown) => (rows as Array<{ identity: { id: string } }>).map((row) => row.identity.id);
  assert.deepEqual(ids((await invoke(bob, "GET", "/api/harnesses/roster")).body), ["claude"]);
  assert.deepEqual(ids((await invoke(owner, "GET", "/api/harnesses/roster")).body), ["claude"]);
  assert.deepEqual(ids((await invoke(ida, "GET", "/api/harnesses/roster")).body), ["claude", "claude-ida"]);
  assert.equal((await invoke(owner, "GET", "/api/harnesses/claude-ida/system-prompt")).status, "not-found");
});

test("an account limited to some harnesses lists only those and its own private logins", async () => {
  const f = await fixture();
  const register = (id: string, accountOwnerUserId?: string) => f.harnesses.register({
    descriptor: { id, name: id, integration: "test", priority: 20, ...(accountOwnerUserId ? { accountOwnerUserId, autoSelect: false } : {}) },
    async probe() {
      return { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
    },
    async createRuntime() {
      throw new Error("runtime is not used by this test");
    },
  } as HarnessProvider);
  register("codex");
  register("gemini");
  register("claude-bob", "u-bob");
  register("claude-ida", "u-ida");
  const route = harnessRoutes(f.host);
  const invoke = async (actor: { userId: string; allowedHarnesses?: string[] | null }, path: string) => {
    let status: unknown = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    try {
      await route({
        path: url.pathname,
        method: "GET",
        url,
        space: { ...f.space, userId: actor.userId, instanceOwner: false, harnessManager: false, allowedHarnesses: actor.allowedHarnesses ?? null },
        principal: { kind: "ui-session" },
        body: async () => ({}),
        json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
      } as unknown as RouteRequest);
    } catch (error) {
      status = (error as { code?: string }).code;
    }
    return { status, body: responseBody };
  };
  const bob = { userId: "u-bob", allowedHarnesses: ["codex"] };
  const ids = (rows: unknown) => (rows as Array<{ identity: { id: string } }>).map((row) => row.identity.id).toSorted();
  const descriptorIds = (rows: unknown) => (rows as Array<{ id: string }>).map((row) => row.id).toSorted();

  assert.deepEqual(descriptorIds((await invoke(bob, "/api/harnesses")).body), ["claude-bob", "codex"]);
  assert.deepEqual(ids((await invoke(bob, "/api/harnesses/roster")).body), ["claude-bob", "codex"]);
  assert.deepEqual(ids((await invoke(bob, "/api/harnesses/snapshots")).body), ["claude-bob", "codex"]);
  assert.equal((await invoke(bob, "/api/harnesses/snapshots?harnessId=gemini")).status, "not-found");
  // Without limits every shared harness is listed, still not others' private logins.
  assert.deepEqual(descriptorIds((await invoke({ userId: "u-bob" }, "/api/harnesses")).body), ["claude", "claude-bob", "codex", "gemini"]);
});

test("a shared account limited to people and Spaces is listed only for them, there", async () => {
  const f = await fixture();
  f.harnesses.register({
    descriptor: { id: "claude-team", name: "Team", integration: "test", priority: 20, accountAllowedUserIds: ["u-ida"], accountAllowedSpaceIds: [f.space.spaceId], autoSelect: false },
    async probe() {
      return { harnessId: "claude-team", state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 };
    },
    async createRuntime() {
      throw new Error("runtime is not used by this test");
    },
  } as HarnessProvider);
  const route = harnessRoutes(f.host);
  const invoke = async (actor: { userId: string; spaceId?: string; allowedHarnesses?: string[] }, path: string, method: "GET" | "POST" = "GET") => {
    let status: unknown = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    try {
      await route({
        path: url.pathname,
        method,
        url,
        space: { ...f.space, spaceId: actor.spaceId ?? f.space.spaceId, userId: actor.userId, instanceOwner: false, harnessManager: false, allowedHarnesses: actor.allowedHarnesses ?? null },
        principal: { kind: "ui-session" },
        body: async () => ({}),
        json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
      } as unknown as RouteRequest);
    } catch (error) {
      status = (error as { code?: string }).code;
    }
    return { status, body: responseBody };
  };
  const ids = (rows: unknown) => (rows as Array<{ identity: { id: string } }>).map((row) => row.identity.id).toSorted();
  const descriptorIds = (rows: unknown) => (rows as Array<{ id: string }>).map((row) => row.id).toSorted();
  const ida = { userId: "u-ida" };
  assert.deepEqual(descriptorIds((await invoke(ida, "/api/harnesses")).body), ["claude", "claude-team"]);
  assert.deepEqual(ids((await invoke(ida, "/api/harnesses/roster")).body), ["claude", "claude-team"]);
  // Foreign person, foreign Space, and account limits each hide it everywhere.
  for (const actor of [{ userId: "u-bob" }, { ...ida, spaceId: "space-b" }, { ...ida, allowedHarnesses: ["claude"] }]) {
    assert.deepEqual(descriptorIds((await invoke(actor, "/api/harnesses")).body), ["claude"]);
    assert.deepEqual(ids((await invoke(actor, "/api/harnesses/roster")).body), ["claude"]);
    assert.deepEqual(ids((await invoke(actor, "/api/harnesses/snapshots")).body), ["claude"]);
    assert.equal((await invoke(actor, "/api/harnesses/snapshots?harnessId=claude-team")).status, "not-found");
    assert.equal((await invoke(actor, "/api/harnesses/claude-team/system-prompt")).status, "not-found");
    assert.equal((await invoke(actor, "/api/harnesses/claude-team/refresh-models", "POST")).status, "not-found");
  }
});

test("only a harness manager writes the Space-wide system prompt and generic harness controls; reads stay open", async () => {
  const f = await fixture();
  const route = harnessRoutes(f.host);
  const invoke = async (actor: { userId: string; harnessManager?: boolean }, method: "GET" | "PUT" | "POST", path: string, body: unknown = {}) => {
    let status: unknown = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    try {
      await route({
        path: url.pathname,
        method,
        url,
        space: { ...f.space, userId: actor.userId, instanceOwner: false, harnessManager: actor.harnessManager === true },
        principal: { kind: "ui-session" },
        body: async () => body,
        json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
      } as unknown as RouteRequest);
    } catch (error) {
      status = (error as { code?: string }).code;
    }
    return { status, body: responseBody };
  };
  const bob = { userId: "u-bob" };
  const ida = { userId: "u-ida", harnessManager: true };
  const prompt = { systemPrompt: "Shared by everyone." };

  assert.equal((await invoke(bob, "PUT", "/api/harnesses/claude/system-prompt", prompt)).status, "forbidden");
  assert.equal((await invoke(bob, "POST", "/api/harnesses/claude/controls/model", { value: "x" })).status, "forbidden");
  await assert.rejects(readFile(join(f.root, "harnesses", "preferences.json"), "utf8"));
  assert.equal((await invoke(bob, "GET", "/api/harnesses/claude/system-prompt")).status, 200);

  assert.equal((await invoke(ida, "PUT", "/api/harnesses/claude/system-prompt", prompt)).status, 200);
  assert.equal((await invoke(bob, "GET", "/api/harnesses/claude/system-prompt")).status, 200);
  // The manager passes the gate; this test harness has no editable controls.
  assert.equal((await invoke(ida, "POST", "/api/harnesses/claude/controls/model", { value: "x" })).status, "unsupported");
});

test("a harness title and color persist per Space, survive reordering and reach roster and cached snapshots", async () => {
  const f = await fixture();
  const pkg = registerPackage(f.host);
  await pkg.onEnable?.();
  const route = harnessRoutes(f.host);
  const invoke = async (method: "GET" | "PUT", path: string, body: unknown = {}, actor: { instanceOwner?: boolean } = { instanceOwner: true }) => {
    let status: number | string = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    try {
      await route({
        path: url.pathname, method, url,
        space: { ...f.space, instanceOwner: actor.instanceOwner === true },
        principal: { kind: "ui-session" },
        body: async () => body,
        json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
      } as unknown as RouteRequest);
    } catch (error) {
      status = (error as { code?: string }).code ?? "error";
    }
    return { status, body: responseBody };
  };
  const stored = async () => JSON.parse(await readFile(join(f.root, "harnesses", "preferences.json"), "utf8"));
  const context = { space: f.space, spaceId: f.space.spaceId, projectId: "p", cwd: "/project" };
  const [before] = await f.harnesses.snapshots(context);
  assert.equal(before?.identity.name, "Claude Code");
  assert.equal(before?.identity.defaultName, undefined);

  assert.deepEqual((await invoke("PUT", "/api/harnesses/claude/appearance", { title: "  Work Claude ", color: "#3F7DE8" })).body, { title: "Work Claude", color: "#3f7de8" });
  assert.deepEqual(await stored(), { claude: { title: "Work Claude", color: "#3f7de8" } });
  const roster = await f.harnesses.roster(context);
  assert.deepEqual([roster[0]?.identity.name, roster[0]?.identity.defaultName, roster[0]?.identity.color], ["Work Claude", "Claude Code", "#3f7de8"]);
  // The cached snapshot takes the new title without a new probe.
  const [after] = await f.harnesses.snapshots(context);
  assert.equal(after?.context.revision, before?.context.revision);
  assert.deepEqual([after?.identity.name, after?.identity.defaultName, after?.identity.color], ["Work Claude", "Claude Code", "#3f7de8"]);

  await invoke("PUT", "/api/harnesses/preferences", { preferences: { claude: { enabled: false, priority: 5 } } });
  assert.deepEqual(await stored(), { claude: { enabled: false, priority: 5, title: "Work Claude", color: "#3f7de8" } });

  for (const bad of [{ title: "x".repeat(49) }, { title: "two\nlines" }, { color: "blue" }, { title: 7 }]) {
    assert.equal((await invoke("PUT", "/api/harnesses/claude/appearance", bad)).status, "invalid-input");
  }
  assert.equal((await invoke("PUT", "/api/harnesses/claude/appearance", { title: "Mine" }, {})).status, "forbidden");
  assert.equal((await invoke("PUT", "/api/harnesses/missing/appearance", { title: "Mine" })).status, "not-found");

  // Clearing both returns to the descriptor's name and keeps routing.
  await invoke("PUT", "/api/harnesses/claude/appearance", { title: "", color: "" });
  assert.deepEqual(await stored(), { claude: { enabled: false, priority: 5 } });
  const [cleared] = await f.harnesses.snapshots(context);
  assert.deepEqual([cleared?.identity.name, cleared?.identity.defaultName, cleared?.identity.color], ["Claude Code", undefined, undefined]);
  await pkg.onDisable?.();
});
