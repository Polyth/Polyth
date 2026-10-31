// Tasks opened from Chat keeps Chat primary at the 0.45 ratio. Moved out of
// apps/web/test/focusedSplit.test.ts so the host geometry test no longer names
// the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideDock,
  type WorkspacePanePresentation,
} from "../../../apps/web/src/surfaces.ts";

test("Tasks opened from Chat keeps Chat primary: 0.45 ratio", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8"));
  assert.match(source, /defaultRatio: 0\.45,/);
  const tasks: WorkspacePanePresentation = {
    kind: "workspace", defaultRatio: 0.45, minWidth: 380, minHeight: 320, preferredMaxWidth: 1400,
    keepAlive: true, escape: "close",
  };
  for (const workspace of [1100, 1330, 1522]) {
    const d = decideDock(null, tasks, { workspaceWidth: workspace, chrome: 6 });
    assert.equal(d.dock, true);
    assert.ok(workspace - d.width > d.width, `${workspace}: chat ${workspace - d.width} stays wider than the board ${d.width}`);
  }
});
