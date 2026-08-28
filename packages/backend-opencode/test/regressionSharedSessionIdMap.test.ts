// Regression test for OC-REAL-069 (phase 6 — directory/worktree isolation).
// See artifacts/opencode-real-world/phase-6/OC-REAL-069/details.json.
//
// Production wiring shares ONE sessionIdMap across every runtime facade in
// the pool (packages/server/src/index.ts). Two `opencode serve` endpoints —
// the project root's and a worktree's — assign backend session ids from
// independent id spaces, so EQUAL backend ids across endpoints are legal.
// `removeMapping` (packages/backend-opencode/src/index.ts) deletes every
// forward entry whose backend id matches, so deleting the root session also
// removes the worktree session's canonical->backend binding (and its
// reconciliation ordinal) even though that session lives on a different
// endpoint and was never deleted.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, RuntimeEndpoint, RuntimeEndpointLease } from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "../src/index.ts";
import { createFakeOpenCode, type FakeOpenCode } from "./fakeOpenCode.ts";

const makeRuntime = async (
  fake: FakeOpenCode,
  directory: string,
  label: string,
  sessionIdMap: Map<string, string>,
): Promise<AgentRuntime> => {
  const control = { kind: "borrowed", source: "external" } as const;
  const endpoint: RuntimeEndpoint = {
    authorityId: `regression-069:${label}`,
    continuity: "verified",
    generation: 1,
    url: fake.baseUrl,
    location: { directory },
    control,
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const lease = {
    control,
    async endpoint() { return endpoint; },
    async refresh() { return endpoint; },
    async dispose() {},
  } satisfies RuntimeEndpointLease;
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 2_000,
    startupDeadlineMs: 2_000,
    probeDeadlineMs: 500,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    cwd: directory,
    lifecycle,
    sessionIdMap,
    log: () => undefined,
  });
  const disposeFacade = facade.dispose.bind(facade);
  facade.dispose = async () => {
    await disposeFacade();
    await lifecycle.dispose();
  };
  return attachRuntimeLifecycle(facade, lifecycle);
};

test("OC-REAL-069: deleting a root session must not wipe an equal-backend-id worktree binding from the shared sessionIdMap", async () => {
  const rootFake = await createFakeOpenCode();
  const worktreeFake = await createFakeOpenCode();
  const shared = new Map<string, string>();
  let rootRuntime: AgentRuntime | undefined;
  let worktreeRuntime: AgentRuntime | undefined;
  try {
    rootRuntime = await makeRuntime(rootFake, "/tmp/regress-069/root", "root", shared);
    worktreeRuntime = await makeRuntime(worktreeFake, "/tmp/regress-069/root/wt", "worktree", shared);
    // Fresh fakes both assign ses_1: a forced (but legal) backend-id collision
    // across the two endpoints.
    const rootBackend = await rootRuntime.ensureSession({
      projectId: "p", sessionId: "canon-root", cwd: "/tmp/regress-069/root", title: "root",
    });
    const worktreeBackend = await worktreeRuntime.ensureSession({
      projectId: "p", sessionId: "canon-worktree", cwd: "/tmp/regress-069/root/wt", title: "worktree",
    });
    assert.equal(rootBackend, worktreeBackend, "precondition: both endpoints assigned the same backend id");
    assert.equal(shared.get("canon-worktree"), worktreeBackend);

    assert.ok(rootRuntime.discardSession, "facade exposes discardSession");
    await rootRuntime.discardSession("canon-root");

    assert.equal(shared.get("canon-root"), undefined, "deleted session's own binding is removed");
    assert.equal(
      shared.get("canon-worktree"),
      worktreeBackend,
      "deleting the ROOT session removed the WORKTREE session's canonical->backend binding from the "
        + "shared sessionIdMap (removeMapping matches by backend id across endpoints); the worktree "
        + "session's reconciliation ordinal is wiped with it",
    );
  } finally {
    await rootRuntime?.dispose().catch(() => undefined);
    await worktreeRuntime?.dispose().catch(() => undefined);
    await rootFake.close().catch(() => undefined);
    await worktreeFake.close().catch(() => undefined);
  }
});
