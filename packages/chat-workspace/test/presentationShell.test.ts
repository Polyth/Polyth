import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const widgetsDir = join(import.meta.dirname, "../widgets");

test("chat-workspace view renders tab strip, viewport shell, and dock together", async () => {
  const source = await readFile(join(widgetsDir, "ChatWorkspaceView.tsx"), "utf8");
  assert.doesNotMatch(
    source,
    /if\s*\(\s*tabs\.length\s*===\s*0\s*\)\s*\{[\s\S]*?return\s*\(/,
    "empty tabs must not short-circuit the three-part shell",
  );
  assert.match(source, /ChatWorkspaceTabStrip/);
  assert.match(source, /ChatWorkspaceDock/);
  assert.match(source, /ChatWorkspaceEmptyState/);
  assert.match(source, /chat-workspace-viewport/);
});

test("chat-workspace tab strip keeps add control with zero tabs", async () => {
  const source = await readFile(join(widgetsDir, "ChatWorkspaceTabStrip.tsx"), "utf8");
  assert.match(source, /chat-workspace-tab-add/);
  assert.doesNotMatch(
    source,
    /tabs\.length\s*===\s*0[\s\S]*?return\s+null/,
    "tab strip must render when there are no tabs",
  );
});
