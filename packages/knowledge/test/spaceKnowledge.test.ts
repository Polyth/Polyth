import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Project, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createSpaceKnowledgeRouter } from "../src/spaceKnowledge.ts";

test("same project ids across Spaces never select an ambiguous knowledge store", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-space-knowledge-"));
  const spaces: SpaceContext[] = [
    { spaceId: "space-a", spaceSlug: "a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: join(root, "a") },
    { spaceId: "space-b", spaceSlug: "b", userId: "user-b", role: "owner", deployment: "local-trusted", storageDir: join(root, "b") },
  ];
  const host = {
    spaceStorage: (space: SpaceContext) => ({ packageDir: (name: string) => join(root, space.spaceId, name) }),
    forSpace: (space: SpaceContext) => ({
      projects: {
        get: async (id: string) => id === "same-project"
          ? ({ id, path: "/tmp/project", name: space.spaceSlug, createdAt: 1, spaceId: space.spaceId } satisfies Project)
          : undefined,
      },
    }),
  } as unknown as Pick<ServerPackageHost, "spaceStorage" | "forSpace">;
  const router = createSpaceKnowledgeRouter(host);
  const [aStore, bStore] = await Promise.all(spaces.map((space) => router.prepareProject(space, "same-project")));
  const aItem = await aStore.create({ projectId: "same-project", kind: "memory", title: "A", body: "A" });
  const bItem = await bStore.create({ projectId: "same-project", kind: "memory", title: "B", body: "B" });

  assert.equal((await router.run(spaces[0]!, () => router.routed.list({ projectId: "same-project" }))).items[0]?.title, "A");
  assert.equal((await router.run(spaces[1]!, () => router.routed.list({ projectId: "same-project" }))).items[0]?.title, "B");
  assert.throws(() => router.routed.list({ projectId: "same-project" }), { code: "not-found" });
  assert.equal((await router.routed.get(aItem.id))?.title, "A", "a unique item id may resolve without a request Space");
  assert.equal((await router.run(spaces[1]!, () => router.routed.get(bItem.id)))?.title, "B");
  router.close();
});
