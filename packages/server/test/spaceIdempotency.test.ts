import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createControlTenancyStore } from "../../tenancy/src/controlStore.ts";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { spaceRoutes } from "../src/routes/spaces.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-space-route-idem-"));
  const control = openControlPlane({ directory: dir });
  t.after(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = 1_700_000_000_000;
  control.transaction(() => {
    control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active'),('usr_alice','user','active')");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',?,?),('usr_alice','Alice',?,?)", now, now, now, now);
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_main','Main','org_main')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_main','usr_owner','owner'),('org_main','usr_alice','member')");
    control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES('spc_personal','org_main','Personal','spc_personal','personal',1,?,?)", now, now);
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_personal','usr_owner','owner',?)", now);
    control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  const store = createControlTenancyStore(control, { now: () => now + 1000 });
  const ctx: SpaceContext = {
    spaceId: "spc_personal",
    spaceSlug: "spc_personal",
    userId: "usr_owner",
    role: "owner",
    deployment: "server-trusted",
    storageDir: join(dir, "spaces", "spc_personal"),
  };
  const observational: string[] = [];
  const route = spaceRoutes({
    store,
    resolver: { deployment: "server-trusted", remember() {} } as never,
    audit: { record(_ctx: unknown, action: string) { observational.push(action); } } as never,
    setActiveSpaceCookie() {},
    maxSpacesPerUser: 2,
  });
  const call = async (body: Record<string, unknown>, key?: string) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: { headers: key === undefined ? {} : { "idempotency-key": key } },
      res: { setHeader() {} },
      url: new URL("http://polyth.test/api/spaces"),
      path: "/api/spaces",
      method: "POST",
      ingress: { kind: "public-http", loopback: true },
      principal: { kind: "ui-session", sessionId: "s", rememberedDeviceId: "d", userId: "usr_owner" },
      space: ctx,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest;
    assert.equal(await route(rc), true);
    return { status, payload };
  };
  return { control, store, call, observational };
}

test("route retry replays create after the first response reached the Space limit", async (t) => {
  const { control, store, call } = fixture(t);
  const key = "11111111-1111-4111-8111-111111111111";
  assert.equal((await call({ name: "Work" }, key)).status, 200);
  assert.equal(store.spacesFor("usr_owner").filter((space) => space.role === "owner").length, 2);
  assert.equal((await call({ name: "Work" }, key)).status, 200);
  assert.equal(store.spacesFor("usr_owner").filter((space) => space.role === "owner").length, 2);
  assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE action='space.created'")?.n, 1);
  assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM operation_receipts WHERE actor_id='usr_owner' AND operation_id=?", key)?.n, 1);
  await assert.rejects(() => call({ name: "Changed" }, key), { code: "conflict" });
});

test("malformed Idempotency-Key is rejected instead of silently executing without a receipt", async (t) => {
  const { call } = fixture(t);
  await assert.rejects(() => call({ name: "Work" }, "not-random"), { code: "invalid-input" });
});
