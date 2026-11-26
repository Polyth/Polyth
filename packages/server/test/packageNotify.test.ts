import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationStore } from "../src/notifications.ts";
import { createPackageNotify } from "../src/packageNotify.ts";

// An agent's run session is started by server work, so no person owns it; the
// package names the person the run acts for and the host records them.
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-package-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const members: Record<string, string[]> = { spc: ["u-ida", "u-bob"] };
  const notifications = createNotificationStore({
    file: join(dir, "notifications.json"),
    hasAccess: (account) => members[account.spaceId]?.includes(account.userId) ?? false,
  });
  const sessions: Record<string, { spaceId?: string; parentId?: string }> = {
    run: { spaceId: "spc" },
    child: { spaceId: "spc", parentId: "run" },
  };
  const reported: string[] = [];
  const warnings: string[] = [];
  const notify = createPackageNotify({
    projection: async (id) => sessions[id],
    registerSessionRecipient: (id, recipient) => notifications.registerSessionRecipient(id, recipient),
    recipientForSession: (id, account) => notifications.recipientForSession(id, account),
    report: (id, kind, statusText, key) => reported.push(`${id}:${kind}:${statusText}:${key}`),
    warn: (message) => warnings.push(message),
  });
  return { notifications, notify, reported, warnings };
}

test("the named person becomes the owner of a session nobody owns, and is told", async (t) => {
  const { notifications, notify, reported, warnings } = fixture(t);
  await notify("run", { kind: "completed", statusText: "needs you: disk at 94%", key: "r1", recipient: { userId: "u-ida" } });
  assert.deepEqual(reported, ["run:completed:needs you: disk at 94%:r1"]);
  assert.deepEqual(warnings, []);
  assert.equal((await notifications.recipientForSession("run", { spaceId: "spc" }))?.userId, "u-ida");
});

test("a recorded owner is never replaced by the named person", async (t) => {
  const { notifications, notify, reported } = fixture(t);
  await notifications.registerSessionRecipient("run", { userId: "u-bob", spaceId: "spc" });
  await notify("run", { kind: "completed", statusText: "x", key: "r1", recipient: { userId: "u-ida" } });
  assert.equal((await notifications.recipientForSession("run", { spaceId: "spc" }))?.userId, "u-bob");
  assert.equal(reported.length, 1);
});

test("a non-member, a system principal or no name leaves the session ownerless and the drop is logged", async (t) => {
  const { notifications, notify, reported, warnings } = fixture(t);
  await notify("run", { kind: "completed", statusText: "x", key: "r1", recipient: { userId: "u-stranger" } });
  await notify("run", { kind: "completed", statusText: "x", key: "r2", recipient: { userId: "system:polyth-runtime" } });
  await notify("run", { kind: "failed", statusText: "x", key: "r3" });
  assert.equal(await notifications.recipientForSession("run", { spaceId: "spc" }), undefined);
  assert.deepEqual(reported, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0]!, /"r1".*no recipient/);
});

test("a delegated child is left to the push notifier's own rules", async (t) => {
  const { notifications, notify, reported } = fixture(t);
  await notify("child", { kind: "completed", statusText: "x", key: "r1", recipient: { userId: "u-ida" } });
  assert.equal(await notifications.recipientForSession("child", { spaceId: "spc" }), undefined);
  assert.deepEqual(reported, ["child:completed:x:r1"]);
});
