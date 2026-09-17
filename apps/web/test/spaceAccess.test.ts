import test from "node:test";
import assert from "node:assert/strict";
import { grantSpaceMember, loadCurrentSpaceAccess } from "../src/spaceAccess.ts";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

test("current Space access exposes membership authority without inferring it from accounts", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/spaces") return json({
      user: { id: "usr_owner", name: "Owner", createdAt: 1 },
      spaces: [{
        id: "spc_personal", name: "Personal", slug: "spc_personal",
        createdAt: 1, updatedAt: 1, isDefault: true, role: "owner", memberCount: 1,
      }],
      activeSpaceId: "spc_personal",
      deployment: "local",
      canCreate: true,
    });
    if (path === "/api/spaces/spc_personal/members") return json([
      { userId: "usr_owner", spaceId: "spc_personal", role: "owner", createdAt: 1 },
    ]);
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    const access = await loadCurrentSpaceAccess();
    assert.equal(access?.id, "spc_personal");
    assert.equal(access?.role, "owner");
    assert.equal(access?.canManageMembers, true);
    assert.deepEqual(access?.members.map((member) => member.userId), ["usr_owner"]);
    assert.deepEqual(calls, ["/api/spaces", "/api/spaces/spc_personal/members"]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("uncertain Space grant retries keep one idempotency key", async () => {
  const previous = globalThis.fetch;
  const operationIds: string[] = [];
  let attempt = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/spaces/spc_personal/members");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    operationIds.push(headers.get("Idempotency-Key") ?? "");
    assert.deepEqual(JSON.parse(String(init?.body)), { userId: "usr_alice", role: "member" });
    attempt++;
    if (attempt === 1) return json({ error: "unavailable" }, 503);
    return json({ userId: "usr_alice", spaceId: "spc_personal", role: "member", createdAt: 2 });
  };
  try {
    await assert.rejects(
      grantSpaceMember("spc_personal", "usr_alice", "member"),
      (error: unknown) => (error as { uncertain?: unknown; status?: unknown }).uncertain === true
        && (error as { status?: unknown }).status === 503,
    );
    const membership = await grantSpaceMember("spc_personal", "usr_alice", "member");
    assert.equal(membership.userId, "usr_alice");
    assert.equal(operationIds.length, 2);
    assert.match(operationIds[0]!, /^[0-9a-f-]{36}$/i);
    assert.equal(operationIds[1], operationIds[0]);
  } finally {
    globalThis.fetch = previous;
  }
});
