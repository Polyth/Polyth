import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createStore } from "@polyth/session";
import { snapshotRequestId, snapshotSessionId } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/data/space-a",
};
const project = { id: "p1", name: "Project", path: "/workspace", spaceId: space.spaceId, createdAt: 0 };
const nativeRef = "native-1";

const sourceProvider = (read: () => AsyncIterable<{ role: "user" | "assistant"; text: string }>) => ({
  descriptor: { id: "fake", name: "Fake Harness", integration: "test", priority: 1 },
  source: {
    list: async () => [{ ref: nativeRef, title: "Native one", updatedAt: 100 }],
    read: () => read(),
  },
});

test("source listing hides imported sessions and deterministic identity makes re-import idempotent", async () => {
  const store = createStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "session-import-routes-"));
  let reads = 0;
  const registry = {
    providers: () => [
      sourceProvider(async function* () { reads += 1; yield { role: "user", text: "hello" }; yield { role: "assistant", text: "hi" }; }),
      // A provider without a source must never appear in the picker.
      { descriptor: { id: "other", name: "No Source", integration: "test", priority: 2 } },
      {
        descriptor: { id: "broken", name: "Broken", integration: "test", priority: 3 },
        source: { list: async () => { throw new Error("offline"); }, async *read() {} },
      },
    ],
  };
  const host = {
    forSpace: () => ({ projects: { get: async (id: string) => (id === project.id ? project : undefined) } }),
    services: { require: () => registry, get: () => undefined },
    spaceStorage: () => ({ path: (relative: string) => join(dir, relative) }),
    store,
    broadcast: { projection: () => {} },
  } as unknown as ServerPackageHost;
  const { routes } = registerPackage(host);

  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    let response: { code: number; value: unknown } | undefined;
    const handled = await routes({
      path,
      method,
      url: new URL(`http://polyth.test${path}?projectId=${project.id}`),
      space,
      body: async () => ({ projectId: project.id, ...(body ?? {}) }),
      json: (code: number, value: unknown) => { response = { code, value }; },
    } as unknown as RouteRequest);
    return { handled, response };
  };

  const first = await call("GET", "/api/session-import/sources");
  const listed = first.response!.value as Array<{
    id: string; items: Array<{ ref: string }>; total: number; imported: number; unavailable?: boolean; unsupported?: boolean;
  }>;
  assert.equal(listed.length, 3, "every registered harness is listed");
  const fake = listed.find((source) => source.id === "fake")!;
  assert.equal(fake.total, 1);
  assert.equal(fake.imported, 0);
  assert.equal(fake.items.length, 1);
  // A harness without a native source is surfaced as unsupported instead of
  // disappearing from the picker, and never contributes selectable items.
  const other = listed.find((source) => source.id === "other")!;
  assert.equal(other.unsupported, true);
  assert.equal(other.items.length, 0);
  assert.equal(listed.find((source) => source.id === "broken")?.unavailable, true);

  const ref = fake.items[0]!.ref;
  const imported = await call("POST", "/api/session-import/snapshot", { ref });
  const projection = imported.response!.value as { id: string };
  assert.equal(
    projection.id,
    snapshotSessionId(space.spaceId, project.id, snapshotRequestId(space.spaceId, project.id, "fake", nativeRef)),
  );
  assert.equal(reads, 1);

  const second = await call("GET", "/api/session-import/sources");
  const relisted = second.response!.value as typeof listed;
  assert.equal(relisted.find((source) => source.id === "fake")?.imported, 1);
  assert.equal(relisted.find((source) => source.id === "fake")?.items.length, 0);

  // Re-importing the same native conversation resolves to the same canonical
  // session and never reads the source again.
  const again = await call("POST", "/api/session-import/snapshot", { ref });
  assert.equal((again.response!.value as { id: string }).id, projection.id);
  assert.equal(reads, 1);
  assert.equal((await store.projections()).length, 1);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test("snapshot publication rejects a project that is not in the caller's Space", async () => {
  const store = createStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "session-import-routes-"));
  const registry = { providers: () => [sourceProvider(async function* () { yield { role: "user", text: "x" }; })] };
  const host = {
    forSpace: () => ({ projects: { get: async () => ({ ...project, spaceId: "other-space" }) } }),
    services: { require: () => registry, get: () => undefined },
    spaceStorage: () => ({ path: (relative: string) => join(dir, relative) }),
    store,
    broadcast: { projection: () => {} },
  } as unknown as ServerPackageHost;
  const { routes } = registerPackage(host);

  let listed: Array<{ items: Array<{ ref: string }> }> | undefined;
  await routes({
    path: "/api/session-import/sources",
    method: "GET",
    url: new URL("http://polyth.test/api/session-import/sources?projectId=p1"),
    space,
    body: async () => ({}),
    json: (_code: number, value: unknown) => { listed = value as typeof listed; },
  } as unknown as RouteRequest);
  const ref = listed!.find((source) => source.items.length > 0)!.items[0]!.ref;

  let error: unknown;
  await routes({
    path: "/api/session-import/snapshot",
    method: "POST",
    url: new URL("http://polyth.test/api/session-import/snapshot"),
    space,
    body: async () => ({ projectId: project.id, ref }),
    json: () => {},
  } as unknown as RouteRequest).catch((cause) => { error = cause; });
  assert.equal((error as { code?: string })?.code, "not-found");
  assert.equal((await store.projections()).length, 0);

  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test("native transcripts are the machine owner's to browse, and never one behind a chat they can't open", async () => {
  const store = createStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "session-import-owner-"));
  try {
    const provider = {
      descriptor: { id: "fake", name: "Fake Harness", integration: "test", priority: 1 },
      source: {
        list: async () => [
          { ref: "native-theirs", title: "Someone else's private chat", updatedAt: 200 },
          { ref: nativeRef, title: "Native one", updatedAt: 100 },
        ],
        async *read() { yield { role: "user" as const, text: "hello" }; },
      },
    };
    const everyChat = [{ id: "theirs", backendSessionId: "native-theirs" }, { id: "mine", backendSessionId: "native-mine" }];
    const host = {
      forSpace: (context: SpaceContext) => ({
        projects: { get: async (id: string) => (id === project.id ? project : undefined) },
        sessions: { list: async () => context.userId === "system" ? everyChat : everyChat.filter((chat) => chat.id === "mine") },
      }),
      systemSpaceContext: () => ({ ...space, userId: "system" }),
      personSpaceContext: (userId: string) => ({ ...space, userId }),
      services: { require: () => ({ providers: () => [provider] }), get: () => undefined },
      spaceStorage: () => ({ path: (relative: string) => join(dir, relative) }),
      store,
      broadcast: { projection: () => {} },
    } as unknown as ServerPackageHost;
    const { routes } = registerPackage(host);
    const call = async (who: Partial<SpaceContext> & { instanceOwner?: boolean }, method: string, path: string, body?: Record<string, unknown>) => {
      let response: { code: number; value: unknown } | undefined;
      await routes({
        path, method,
        url: new URL(`http://polyth.test${path}?projectId=${project.id}`),
        space: { ...space, ...who },
        body: async () => ({ projectId: project.id, ...(body ?? {}) }),
        json: (code: number, value: unknown) => { response = { code, value }; },
      } as unknown as RouteRequest);
      return response;
    };

    const member = await call({ userId: "user-b", role: "member", instanceOwner: false }, "GET", "/api/session-import/sources");
    const [forMember] = member!.value as Array<{ items: unknown[]; ownerOnly?: boolean }>;
    assert.equal(forMember!.ownerOnly, true);
    assert.deepEqual(forMember!.items, [], "a member sees no transcript at all");
    await assert.rejects(
      call({ userId: "user-b", role: "member", instanceOwner: false }, "POST", "/api/session-import/snapshot", { ref: "anything" }),
      { code: "forbidden" },
    );

    const owner = await call({ userId: "user-a", instanceOwner: true }, "GET", "/api/session-import/sources");
    const [forOwner] = owner!.value as Array<{ items: Array<{ ref: string; title: string }>; ownerOnly?: boolean }>;
    assert.equal(forOwner!.ownerOnly, undefined);
    assert.deepEqual(forOwner!.items.map((item) => item.title), ["Native one"], "someone's private chat stays out of the owner's list");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
