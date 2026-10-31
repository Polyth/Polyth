// Moved from packages/server/test/inputValidation.test.ts: the goal-limit
// validation case belongs with the goals package's own route.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createGoalService } from "../src/index.ts";
import { goalRoutes } from "../src/serverEntry.ts";
import { createHttpServer } from "../../server/src/http.ts";
import { testTenancy } from "../../server/test/support/spaces.ts";

const DIAGNOSTIC_KEYS = ["code", "component", "operation", "requestId", "retryability", "recovery", "mutationOutcome"] as const;

async function errorEnvelope(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  for (const key of DIAGNOSTIC_KEYS) delete body[key];
  return body;
}

test("goal limit errors are 400 responses with a field", async () => {
  const tenancy = await testTenancy();
  const goals = createGoalService({
    append: async () => {},
    send: async () => {},
    complete: async () => '{"verdict":"done"}',
  });
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-goal-validation-")),
    version: "test",
    routes: [goalRoutes(goals)],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const goal = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/goal`, {
      method: "POST",
      body: JSON.stringify({ objective: "ship", maxContinuations: -2 }),
    });
    assert.equal(goal.status, 400);
    assert.deepEqual(await errorEnvelope(goal), {
      error: "invalid-input",
      message: "maxContinuations must be a finite positive integer",
      field: "maxContinuations",
    });
  } finally {
    server.close();
  }
});
