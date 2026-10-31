import test from "node:test";
import assert from "node:assert/strict";

import type { SessionProjection } from "@polyth/contracts";
import {
  autoDeleteFailedStartupPreference,
  createFailedStartupCleanupPolicy,
  type FailedStartupCleanupPolicyDeps,
} from "../src/failedStartupCleanup.ts";

const row = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "p", spaceId: "space-1", title: id, status: "failed", createdAt: 1, updatedAt: 1, ...extra,
});

const off = { product: { autoDeleteFailedStartupSessions: false } };
const on = { product: { autoDeleteFailedStartupSessions: true } };

const policy = (overrides: Partial<FailedStartupCleanupPolicyDeps> & {
  rows?: SessionProjection[];
  recipients?: Record<string, string>;
  settings?: Record<string, unknown>;
}) => createFailedStartupCleanupPolicy({
  spaceOf: (projection) => projection.spaceId,
  accountForSession: async (sessionId) => overrides.recipients?.[sessionId],
  members: () => ["usr_owner"],
  settingsFor: (userId) => overrides.settings?.[userId] ?? {},
  projection: async (sessionId) => overrides.rows?.find((candidate) => candidate.id === sessionId),
  ...overrides,
});

test("the synced preference defaults to the web default and only an explicit false opts out", () => {
  assert.equal(autoDeleteFailedStartupPreference(undefined), true);
  assert.equal(autoDeleteFailedStartupPreference({}), true);
  assert.equal(autoDeleteFailedStartupPreference(on), true);
  assert.equal(autoDeleteFailedStartupPreference(off), false);
  assert.equal(autoDeleteFailedStartupPreference({ autoDeleteFailedStartupSessions: false }), true, "only product.* is the web key");
});

test("the session's recorded account decides", async () => {
  const allowed = policy({ recipients: { s: "usr_a" }, settings: { usr_a: on, usr_owner: off } });
  assert.equal(await allowed(row("s")), true);
  const kept = policy({ recipients: { s: "usr_a" }, settings: { usr_a: off } });
  assert.equal(await kept(row("s")), false);
});

test("a delegated child without its own account inherits the nearest ancestor's choice", async () => {
  const rows = [row("root"), row("mid", { parentId: "root" }), row("child", { parentId: "mid" })];
  const kept = policy({ rows, recipients: { root: "usr_a" }, settings: { usr_a: off } });
  assert.equal(await kept(rows[2]!), false);
  const allowed = policy({ rows, recipients: { root: "usr_a" }, settings: { usr_a: on } });
  assert.equal(await allowed(rows[2]!), true);
});

test("without any recorded account every Space member must allow deletion", async () => {
  const members = () => ["usr_a", "usr_b"];
  assert.equal(await policy({ members, settings: { usr_a: on, usr_b: off } })(row("s")), false);
  assert.equal(await policy({ members, settings: { usr_a: on } })(row("s")), true);
  assert.equal(await policy({ members: () => [] })(row("s")), false, "an empty Space keeps the session");
  assert.equal(await policy({ spaceOf: () => undefined })(row("s")), false, "an unresolvable Space keeps the session");
});

test("a parent cycle terminates", async () => {
  const rows = [row("a", { parentId: "b" }), row("b", { parentId: "a" })];
  assert.equal(await policy({ rows, settings: { usr_owner: off } })(rows[0]!), false);
});
