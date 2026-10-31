import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConnectionOwner, type ResolveConnectionOwnerInput } from "../src/personConnections.ts";

const SPACE = "spc_work";
const FOREIGN = "spc_hobby";
const members = new Set([`usr_alice:${SPACE}`, `usr_bob:${SPACE}`, `usr_alice:${FOREIGN}`]);
const base: ResolveConnectionOwnerInput = {
  actorUserId: "usr_alice",
  spaceId: SPACE,
  isMember: (userId, spaceId) => members.has(`${userId}:${spaceId}`),
  personalEnabled: [],
  hasService: false,
  policy: { agentsMayUseService: false },
  origin: "agent",
};
const resolve = (patch: Partial<ResolveConnectionOwnerInput>) => resolveConnectionOwner({ ...base, ...patch });
const personal = (userId: string) => ({ kind: "personal", userId });
const service = { kind: "service" };
const refused = (reason: string) => ({ kind: "refused", reason });

test("truth table for person-ui and agent with an actor", () => {
  const rows: Array<[Partial<ResolveConnectionOwnerInput>, unknown]> = [
    // enabled personal connection always wins, whatever the service/policy
    [{ origin: "person-ui", personalEnabled: ["gh"] }, personal("usr_alice")],
    [{ origin: "agent", personalEnabled: ["gh"] }, personal("usr_alice")],
    [{ origin: "agent", personalEnabled: ["gh"], hasService: true, policy: { agentsMayUseService: true } }, personal("usr_alice")],
    // person-ui falls back to the service account whenever it exists
    [{ origin: "person-ui", hasService: true }, service],
    [{ origin: "person-ui", hasService: false, policy: { agentsMayUseService: true } }, refused("connect-your-account")],
    // agents need the Space policy
    [{ origin: "agent", hasService: true }, refused("connect-your-account")],
    [{ origin: "agent", hasService: true, policy: { agentsMayUseService: true } }, service],
    [{ origin: "agent", hasService: false, policy: { agentsMayUseService: true } }, refused("connect-your-account")],
    [{ origin: "agent" }, refused("connect-your-account")],
  ];
  for (const [patch, expected] of rows) assert.deepEqual(resolve(patch), expected, JSON.stringify(patch));
});

test("non-members and foreign Spaces are refused before any account is chosen", () => {
  for (const origin of ["person-ui", "agent"] as const) {
    assert.deepEqual(
      resolve({ origin, actorUserId: "usr_bob", spaceId: FOREIGN, personalEnabled: ["gh"], hasService: true, policy: { agentsMayUseService: true } }),
      refused("not-a-member"),
    );
    assert.deepEqual(
      resolve({ origin, actorUserId: "usr_carol", hasService: true, policy: { agentsMayUseService: true } }),
      refused("not-a-member"),
    );
  }
  // Alice is a member of both; each Space is judged on its own.
  assert.deepEqual(resolve({ spaceId: FOREIGN, personalEnabled: ["gh"] }), personal("usr_alice"));
});

test("work with no person uses only the service account under policy", () => {
  for (const origin of ["system", "agent"] as const) {
    assert.deepEqual(resolve({ origin, actorUserId: undefined }), refused("service-not-allowed"));
    assert.deepEqual(resolve({ origin, actorUserId: undefined, hasService: true }), refused("service-not-allowed"));
    assert.deepEqual(
      resolve({ origin, actorUserId: undefined, hasService: false, policy: { agentsMayUseService: true } }),
      refused("service-not-allowed"),
    );
    assert.deepEqual(
      resolve({ origin, actorUserId: undefined, hasService: true, policy: { agentsMayUseService: true } }),
      service,
    );
  }
  // System work never borrows a person's account, even if handed an actor.
  assert.deepEqual(resolve({ origin: "system", personalEnabled: ["gh"] }), refused("service-not-allowed"));
  assert.deepEqual(resolve({ origin: "person-ui", actorUserId: "" }), refused("not-a-member"));
});

test("the result never names anyone but the actor", () => {
  const owner = resolve({ actorUserId: "usr_bob", personalEnabled: ["alice-connection"] });
  assert.deepEqual(owner, personal("usr_bob"));
});
