import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessSnapshot, ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "../src/sessions.ts";
import { createRuntimeCatalog } from "../src/runtimeCatalog.ts";

const projects = {
  list: async () => [{ id: "one", path: "/one", name: "one", createdAt: 1 }],
} as ProjectService;

const base = (state: HarnessSnapshot["availability"]["state"]): HarnessSnapshot => ({
  identity: { id: "opencode", name: "OpenCode", integration: "test" },
  availability: {
    harnessId: "opencode",
    installed: true,
    authenticated: "unknown",
    healthy: true,
    state,
    checkedAt: 1,
  },
  policy: { enabled: true, priority: 0, autoSelect: true },
  context: {
    spaceId: "space",
    projectId: "one",
    cwd: "/one",
    revision: "1",
    fetchedAt: 1,
  },
});

test("empty degraded cold catalog is retried instead of frozen", async () => {
  let detailCalls = 0;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [base("unknown")];
      detailCalls += 1;
      if (detailCalls === 1) {
        return [{ ...base("degraded"), message: "runtime still starting" }];
      }
      return [{
        ...base("ready"),
        availability: { ...base("ready").availability, authenticated: true },
        catalog: {
          models: [{ providerID: "openai", modelID: "gpt", name: "GPT" }],
          agents: [],
        },
      }];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;

  const catalog = createRuntimeCatalog({ projects, runtimes });
  assert.deepEqual(await catalog.models(), []);
  assert.equal((await catalog.models())[0]?.modelID, "gpt");
  assert.equal(detailCalls, 2);
});
