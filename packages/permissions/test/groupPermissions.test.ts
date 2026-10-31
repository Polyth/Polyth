import test from "node:test";
import assert from "node:assert/strict";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";
import { groupPermissions } from "../widgets/groupPermissions.ts";

const permission = (requestId: string, patch: Partial<PendingPermission> = {}): PendingPermission => ({
  sessionId: "session-1", requestId, permission: "package-tool", tool: "polyth_peer",
  patterns: ["harness-runtime.peer-observations"], status: "pending", time: 1,
  preview: { title: "package-tool via polyth_peer", lines: ["harness-runtime.peer-observations"] },
  ...patch,
});

test("identical pending subjects group without losing their canonical identities or order", () => {
  const first = permission("first");
  const other = permission("other", { patterns: ["another-tool"] });
  const last = permission("last", { time: 2 });
  const groups = groupPermissions([first, other, last, first, permission("done", { status: "resolved" })]);
  assert.deepEqual(groups.map((group) => group.requests), [[first, last], [other]]);
  assert.equal(groups[0]!.key, groupPermissions([last])[0]!.key, "membership does not remount the busy row");
});

test("each authorization and preview boundary keeps requests separate", () => {
  const first = permission("first");
  for (const patch of [
    { sessionId: "session-2" },
    { permission: "edit" },
    { tool: "another-tool" },
    { patterns: ["another-target"] },
    { preview: { title: "Another title", lines: first.preview!.lines } },
    { preview: { title: first.preview!.title, lines: ["another-preview"] } },
    { preview: { ...first.preview!, risk: "high" as const } },
    { preview: undefined },
    { allowedScopes: ["once"] as const },
  ]) {
    assert.equal(groupPermissions([first, permission("second", patch as Partial<PendingPermission>)]).length, 2);
  }
  assert.equal(groupPermissions([first, permission("first", { sessionId: "session-2" })]).length, 2);
});

test("equivalent scope sets match their default regardless of order", () => {
  assert.equal(groupPermissions([
    permission("first"),
    permission("second", { allowedScopes: ["project", "once", "session"] }),
  ]).length, 1);
  assert.deepEqual(groupPermissions([permission("done", { status: "resolved" })]), []);
});
