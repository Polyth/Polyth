// Global runtime catalog reads are bounded by distinct harness selections, not
// by project count. Scoped session/project routes own project-specific metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, ModelDescriptor, Project, ProjectService } from "@polyth/contracts";
import { aggregateRuntimes } from "../src/runtimeAggregate.ts";

const projectsFrom = (projects: Project[]): ProjectService => ({
  list: async () => projects,
  get: async () => undefined,
  add: async () => { throw new Error("unused"); },
  create: async () => { throw new Error("unused"); },
  remove: async () => {},
});
const projectsOf = (ids: string[]): ProjectService => projectsFrom(
  ids.map((id): Project => ({ id, path: `/${id}`, name: id, createdAt: 1 })),
);

const model = (providerID: string, modelID: string): ModelDescriptor =>
  ({ providerID, modelID, name: modelID });

const runtimeOf = (models: () => Promise<ModelDescriptor[]>): AgentRuntime =>
  ({ models } as unknown as AgentRuntime);

test("many Auto projects use one representative runtime", async () => {
  const asked: string[] = [];
  const runtimes = {
    forProject: async (id: string) => {
      asked.push(id);
      return runtimeOf(async () => [
        model("a", "m1"),
        model("a", "m1"),
        model("b", "m2"),
      ]);
    },
  };

  const out = await aggregateRuntimes(
    { projects: projectsOf(["p1", "p2", "p3", "p4"]), runtimes },
    (rt) => rt.models(),
    (m) => `${m.providerID}/${m.modelID}`,
  );

  assert.deepEqual(asked, ["p1"], "unrelated Auto projects must not be started for global metadata");
  assert.deepEqual(out.items.map((m) => `${m.providerID}/${m.modelID}`), ["a/m1", "b/m2"]);
  assert.equal(out.complete, true);
});

test("one representative is retained for each distinct pinned harness", async () => {
  const asked: string[] = [];
  const projects: Project[] = [
    { id: "auto-a", path: "/a", name: "a", createdAt: 1 },
    { id: "auto-b", path: "/b", name: "b", createdAt: 1 },
    { id: "codex-a", path: "/c", name: "c", createdAt: 1, defaults: { harness: { mode: "pinned", harnessId: "codex" } } },
    { id: "codex-b", path: "/d", name: "d", createdAt: 1, defaults: { harness: { mode: "pinned", harnessId: "codex" } } },
    { id: "claude", path: "/e", name: "e", createdAt: 1, defaults: { harness: { mode: "pinned", harnessId: "claude" } } },
  ];
  const runtimes = {
    forProject: async (id: string) => {
      asked.push(id);
      return runtimeOf(async () => [model(id, "m")]);
    },
  };
  const out = await aggregateRuntimes(
    { projects: projectsFrom(projects), runtimes },
    (rt) => rt.models(),
    (m) => `${m.providerID}/${m.modelID}`,
  );
  assert.deepEqual(asked, ["auto-a", "codex-a", "claude"]);
  assert.equal(out.items.length, 3);
  assert.equal(out.complete, true);
});

test("local representatives are preferred without dropping remote-only selections", async () => {
  const asked: string[] = [];
  const projects: Project[] = [
    {
      id: "remote-auto",
      path: "/remote-auto",
      name: "remote-auto",
      createdAt: 1,
      remote: { kind: "ssh", connectionId: "r1" },
    },
    { id: "local-auto", path: "/local-auto", name: "local-auto", createdAt: 1 },
    {
      id: "remote-codex",
      path: "/remote-codex",
      name: "remote-codex",
      createdAt: 1,
      remote: { kind: "ssh", connectionId: "r2" },
      defaults: { harness: { mode: "pinned", harnessId: "codex" } },
    },
  ];
  const runtimes = {
    forProject: async (id: string) => {
      asked.push(id);
      return runtimeOf(async () => [model(id, "m")]);
    },
  };

  const out = await aggregateRuntimes(
    { projects: projectsFrom(projects), runtimes },
    (rt) => rt.models(),
    (m) => `${m.providerID}/${m.modelID}`,
  );

  assert.deepEqual(asked, ["local-auto", "remote-codex"]);
  assert.equal(out.items.length, 2);
  assert.equal(out.complete, true);
});

test("representative runtime failure marks the bounded aggregate incomplete", async () => {
  const asked: string[] = [];
  const runtimes = {
    forProject: async (id: string) => {
      asked.push(id);
      return runtimeOf(async () => { throw new Error("runtime unavailable"); });
    },
  };
  const out = await aggregateRuntimes(
    { projects: projectsOf(["p1", "p2", "p3"]), runtimes },
    (rt) => rt.models(),
  );
  assert.deepEqual(asked, ["p1"]);
  assert.deepEqual(out.items, []);
  assert.equal(out.complete, false);
});

test("no projects falls back to the __default__ pool", async () => {
  const asked: string[] = [];
  const runtimes = {
    forProject: async (id: string) => {
      asked.push(id);
      return runtimeOf(async () => [model("a", "m1")]);
    },
  };
  const out = await aggregateRuntimes({ projects: projectsOf([]), runtimes }, (rt) => rt.models());
  assert.deepEqual(asked, ["__default__"]);
  assert.equal(out.items.length, 1);
  assert.equal(out.complete, true);
});
