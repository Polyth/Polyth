import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { createSmallModelService } from "../src/smallModel.ts";

test("a direct-provider failure does not wait then replay as a session turn", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let submitted = 0;
  const runtime = {
    completeSmallModel: async () => {
      throw Object.assign(new Error("provider timed out"), { code: "timeout" });
    },
    startTurnOperation: async () => {
      submitted += 1;
      throw new Error("must not submit a duplicate turn");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo", prompt: "next action", maxOutputTokens: 64,
    }),
    /provider timed out/,
  );
  assert.equal(submitted, 0);
  await store.close();
});
