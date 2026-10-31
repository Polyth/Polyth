import test from "node:test";
import assert from "node:assert/strict";
import { REMOTE_CAPABILITY, type AuthPrincipal, type SessionEvent, type SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { assertPairedHttpAllowed, validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";
import { conversationRoutes, CONVERSATION_REMOTE_ACCESS } from "../src/serverEntry.ts";

const fixtures = new Map([
  ["home-session", { spaceId: "home", text: "home needle" }],
  ["work-session", { spaceId: "work", text: "work needle" }],
]);

function fixture() {
  let reads = 0;
  const host = {
    sessions: { events() { throw new Error("unscoped session history accessed"); } },
    forSpace(ctx: SpaceContext) {
      return { sessions: {
        async snapshot(id: string) {
          if (fixtures.get(id)?.spaceId !== ctx.spaceId) throw new Error("not found");
          return { id };
        },
        async events(id: string) {
          reads += 1;
          const record = fixtures.get(id)!;
          return [{ id: "1", sessionId: id, seq: 1, time: 1, type: "user/message", data: { text: record.text }, v: 1 } satisfies SessionEvent];
        },
      } };
    },
  } as unknown as ServerPackageHost;
  const route = conversationRoutes(host);
  const request = async (spaceId: string, id: string, params = "q=needle") => {
    let response: unknown;
    const path = `/api/conversation/${id}/find`;
    await route({ path, method: "GET", url: new URL(`http://fixture.test${path}?${params}`),
      space: { spaceId } as SpaceContext, json(_status: number, value: unknown) { response = value; },
    } as Parameters<typeof route>[0]);
    return response as { matches: { before: string }[]; total: number };
  };
  return { request, reads: () => reads };
}

test("scoped route rejects a known-valid foreign-Space session without reading history", async () => {
  const h = fixture();
  assert.equal((await h.request("work", "work-session")).total, 1);
  assert.equal(h.reads(), 1);
  await assert.rejects(h.request("home", "work-session"), { code: "not-found", message: "Session unavailable" });
  await assert.rejects(h.request("home", "absent-session"), { code: "not-found", message: "Session unavailable" });
  assert.equal(h.reads(), 1);
  assert.equal((await h.request("home", "home-session")).matches[0]?.before, "home ");
});

test("query validation precedes history access and empty queries skip it", async () => {
  const h = fixture();
  await assert.rejects(h.request("home", "home-session", "q=x&offset=-1"), { code: "invalid-input" });
  await assert.rejects(h.request("home", "home-session", "q=x&offset=1.5"), { code: "invalid-input" });
  await assert.rejects(h.request("home", "home-session", `q=${"x".repeat(257)}`), { code: "invalid-input" });
  assert.equal((await h.request("home", "home-session", "q=")).total, 0);
  assert.equal(h.reads(), 0);
});

test("paired read policy is default-deny and respects grant removal", () => {
  validateRemoteAccessPolicy("conversation", CONVERSATION_REMOTE_ACCESS);
  const policies = [{ owner: "conversation", policy: CONVERSATION_REMOTE_ACCESS }];
  const device = (grants: string[]): AuthPrincipal => ({ kind: "paired-device", deviceId: "device", deviceEndpointId: "endpoint", connectionId: "connection", transport: "direct", grantRevision: 1, grants });
  const path = "/api/conversation/home-session/find";
  assert.throws(() => assertPairedHttpAllowed(device([]), "GET", path, policies), { code: "forbidden" });
  assert.ok(assertPairedHttpAllowed(device([REMOTE_CAPABILITY.coreSessionsRead]), "GET", path, policies));
  assert.throws(() => assertPairedHttpAllowed(device([]), "GET", path, policies), { code: "forbidden" });
  assert.throws(() => assertPairedHttpAllowed(device([REMOTE_CAPABILITY.coreSessionsRead]), "POST", path, policies), { code: "forbidden" });
});
