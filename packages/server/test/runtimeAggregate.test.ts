// Cross-runtime catalog aggregation (/api/models, profile validation):
// projects fan out in parallel, one unavailable runtime never fails the rest,
// and the merged list is deduped by the caller's key.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, ModelDescriptor, Project, ProjectService } from "@polyth/contracts";
import { aggregateRuntimes } from "../src/runtimeAggregate.ts";

const projectsOf = (ids: string[]): ProjectService => ({
  list: async () => ids.map((id): Project => ({ id, path: `/${id}`, name: id, createdAt: 1 })),
  get: async () => undefined,
  add: async () => { throw new Error("unused"); },
  create: async () => { throw new Error("unused"); },
  remove: async () => {},
});

const model = (providerID: string, modelID: string): ModelDescriptor =>
  ({ providerID, modelID, name: modelID });

const runtimeOf = (models: () => Promise<ModelDescriptor[]>): AgentRuntime =>
  ({ models } as unknown as AgentRuntime);

test("aggregates projects in parallel, skips failures, dedupes by key", async () => {
  // Both fetches must have STARTED before either resolves — a sequential
  // await-in-loop regression would deadlock, so the gate is raced with a timer.
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const arrive = async () => { started += 1; if (started === 2) release(); await gate; };

  const byProject: Record<string, AgentRuntime> = {
    p1: runtimeOf(async () => { await arrive(); return [model("a", "m1"), model("b", "m2")]; }),
    p2: runtimeOf(async () => { await arrive(); return [model("a", "m1"), model("c", "m3")]; }),
    p3: runtimeOf(async () => { throw new Error("serve process died"); }),
  };
  const runtimes = { forProject: async (id: string) => byProject[id]! };

  const out = await Promise.race([
    aggregateRuntimes(
      { projects: projectsOf(["p1", "p2", "p3"]), runtimes },
      (rt) => rt.models(),
      (m) => `${m.providerID}/${m.modelID}`,
    ),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("aggregation ran sequentially (deadlocked on the gate)")), 5_000).unref()),
  ]);

  assert.deepEqual(
    out.map((m) => `${m.providerID}/${m.modelID}`),
    ["a/m1", "b/m2", "c/m3"], // deduped, stable project order
  );
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
  assert.equal(out.length, 1);
});
