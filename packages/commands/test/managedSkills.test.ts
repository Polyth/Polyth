import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import type { Project, ProjectService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createCommandService } from "../src/index.ts";
import { createSkillService } from "../src/skills.ts";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const code = (error: unknown): string | undefined =>
  error && typeof error === "object" ? (error as { code?: string }).code : undefined;

const makeSpace = (base: string, id: string, userId: string, role: SpaceContext["role"] = "owner"): SpaceContext => {
  const storageDir = join(base, "spaces", id);
  mkdirSync(join(storageDir, "packages", "commands"), { recursive: true });
  return {
    spaceId: id,
    spaceSlug: id,
    userId,
    role,
    deployment: "server-trusted",
    storageDir,
  };
};

const storage = (space: SpaceContext): SpaceStorage => ({
  root: space.storageDir,
  packageDir(packageId) {
    const target = join(space.storageDir, "packages", packageId);
    mkdirSync(target, { recursive: true });
    return target;
  },
  path(relative) {
    const target = resolve(space.storageDir, relative);
    if (target !== space.storageDir && !target.startsWith(space.storageDir + sep)) {
      throw Object.assign(new Error("invalid path"), { code: "invalid-path" });
    }
    return target;
  },
});

const project = (id: string, path: string, spaceId: string): Project => ({
  id,
  path,
  name: id,
  spaceId,
  createdAt: 1,
});

const scopedProjects = (rows: Map<string, Project>, space: SpaceContext): ProjectService => ({
  list: async () => [...rows.values()].filter((row) => row.spaceId === space.spaceId),
  get: async (id) => {
    const row = rows.get(id);
    return row?.spaceId === space.spaceId ? row : undefined;
  },
  add: async () => { throw new Error("unused"); },
  create: async () => { throw new Error("unused"); },
  remove: async () => { throw new Error("unused"); },
});

const input = (name: string, instructions = `${name} instructions`) => ({
  name,
  description: `${name} description`,
  instructions,
  expectedRevision: 0,
});

test("managed skills isolate projects, resolve deterministically, persist, and clean up", async () => {
  const base = temp("polyth-managed-skills-");
  const home = temp("polyth-managed-skills-home-");
  const rootA = join(base, "project-a");
  const rootB = join(base, "project-b");
  const rootForeign = join(base, "project-foreign");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  mkdirSync(rootForeign, { recursive: true });
  const spaceA = makeSpace(base, "space-a", "user-a");
  const spaceB = makeSpace(base, "space-b", "user-b");
  const projects = new Map<string, Project>([
    ["project-a", project("project-a", rootA, "space-a")],
    ["project-b", project("project-b", rootB, "space-a")],
    ["project-foreign", project("project-foreign", rootForeign, "space-b")],
  ]);
  const legacy = createCommandService({ home });
  const makeService = () => createSkillService({
    storage,
    projects: (ctx) => scopedProjects(projects, ctx),
    allowUserSkills: () => false,
    legacy,
  });
  const skills = makeService();

  await skills.save(spaceA, "space", input("shared"));
  await skills.save(spaceA, "project", input("a-only"), "project-a");
  await skills.save(spaceA, "project", input("b-only"), "project-b");
  await skills.save(spaceA, "project", input("same", "A instructions"), "project-a");
  await skills.save(spaceA, "project", input("same", "B instructions"), "project-b");

  const rowsA = await skills.list(spaceA, "project-a");
  const rowsB = await skills.list(spaceA, "project-b");
  assert.deepEqual(rowsA.map((row) => row.name), ["a-only", "same", "shared"]);
  assert.deepEqual(rowsB.map((row) => row.name), ["b-only", "same", "shared"]);
  assert.equal(rowsA.find((row) => row.name === "same")?.instructions, "A instructions");
  assert.equal(rowsB.find((row) => row.name === "same")?.instructions, "B instructions");
  assert.equal(rowsA.find((row) => row.name === "shared")?.scope, "space");

  const nativeDir = join(rootA, ".opencode", "skills", "shared");
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, "SKILL.md"), "---\nname: shared\ndescription: Project native override\n---\n\nNative instructions.\n");
  const nativeShared = (await skills.list(spaceA, "project-a")).find((row) => row.name === "shared")!;
  assert.equal(nativeShared.scope, "project-opencode");
  assert.equal(nativeShared.readOnly, true);

  await skills.save(spaceA, "project", input("shared", "Managed A override"), "project-a");
  const managedShared = (await skills.list(spaceA, "project-a")).find((row) => row.name === "shared")!;
  assert.equal(managedShared.scope, "project");
  assert.equal(managedShared.instructions, "Managed A override");
  assert.equal(managedShared.readOnly, undefined);
  assert.equal((await skills.list(spaceA, "project-b")).find((row) => row.name === "shared")?.scope, "space");

  const reloaded = makeService();
  assert.equal((await reloaded.list(spaceA, "project-a")).find((row) => row.name === "same")?.instructions, "A instructions");
  assert.equal((await reloaded.list(spaceA, "project-b")).find((row) => row.name === "same")?.instructions, "B instructions");
  assert.deepEqual(await reloaded.list(spaceB), [], "another user's Space must not see Space A skills");
  await assert.rejects(() => reloaded.list(spaceA, "project-foreign"), (error) => code(error) === "not-found");
  await assert.rejects(
    () => reloaded.save(spaceA, "project", input("foreign"), "project-foreign"),
    (error) => code(error) === "not-found",
  );

  const contextA = { space: spaceA, spaceId: "space-a", projectId: "project-a", cwd: rootA };
  const contextB = { space: spaceA, spaceId: "space-a", projectId: "project-b", cwd: rootB };
  const capsA = reloaded.managedCapabilities(contextA);
  const capsB = reloaded.managedCapabilities(contextB);
  assert.deepEqual(capsA.filter((row) => row.kind === "skill").map((row) => row.name).sort(), ["a-only", "same", "shared"]);
  assert.deepEqual(capsB.filter((row) => row.kind === "skill").map((row) => row.name).sort(), ["b-only", "same", "shared"]);
  assert.equal(capsA.some((row) => row.kind === "skill" && row.name === "same" && row.instructions === "B instructions"), false);

  const sameA = (await reloaded.list(spaceA, "project-a")).find((row) => row.name === "same")!;
  assert.equal(await reloaded.remove(spaceA, "project", "same", "project-a", sameA.revision), true);
  assert.equal((await reloaded.list(spaceA, "project-a")).some((row) => row.name === "same"), false);
  assert.equal((await reloaded.list(spaceA, "project-b")).find((row) => row.name === "same")?.instructions, "B instructions");

  reloaded.removeProject(spaceA, "project-a");
  const afterCleanupA = await reloaded.list(spaceA, "project-a");
  assert.equal(afterCleanupA.some((row) => row.scope === "project"), false);
  assert.equal(afterCleanupA.find((row) => row.name === "shared")?.scope, "project-opencode", "cleanup reveals existing read-only native discovery");
  assert.deepEqual((await reloaded.list(spaceA, "project-b")).filter((row) => row.scope === "project").map((row) => row.name), ["b-only", "same"]);
  assert.deepEqual((await reloaded.list(spaceA)).map((row) => row.name), ["shared"]);
});

test("managed skill writes enforce role and optimistic revision gates", async () => {
  const base = temp("polyth-managed-skills-role-");
  const rootA = join(base, "project-a");
  mkdirSync(rootA, { recursive: true });
  const projects = new Map<string, Project>([["project-a", project("project-a", rootA, "space-a")]]);
  const makeSpaceFor = (role: SpaceContext["role"]) => makeSpace(base, "space-a", `user-${role}`, role);
  const skills = createSkillService({
    storage,
    projects: (ctx) => scopedProjects(projects, ctx),
    allowUserSkills: () => false,
    legacy: createCommandService({ home: temp("polyth-managed-skills-role-home-") }),
  });

  await assert.rejects(
    () => skills.save(makeSpaceFor("viewer"), "project", input("viewer-no"), "project-a"),
    (error) => code(error) === "forbidden",
  );
  await assert.rejects(
    () => skills.save(makeSpaceFor("member"), "space", input("member-space-no")),
    (error) => code(error) === "forbidden",
  );
  const created = await skills.save(makeSpaceFor("member"), "project", input("member-project-ok"), "project-a");
  await assert.rejects(
    () => skills.save(makeSpaceFor("member"), "project", {
      ...input("member-project-ok", "stale edit"),
      expectedRevision: 0,
    }, "project-a"),
    (error) => code(error) === "conflict",
  );
  const updated = await skills.save(makeSpaceFor("member"), "project", {
    ...input("member-project-ok", "updated"),
    expectedRevision: created.revision,
  }, "project-a");
  assert.equal(updated.revision, 2);
});
