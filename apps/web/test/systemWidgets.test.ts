import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("system status is registered as a movable workspace widget, not header chrome", async () => {
  const source = await readFile(new URL("../src/widgets/systemWidgets.tsx", import.meta.url), "utf8");
  const slots = source.slice(source.indexOf("const SYSTEM_STATUS_SLOTS"), source.indexOf("function SystemStatusWidget"));
  for (const slot of [
    "workspace.header", "workspace.left", "workspace.main", "workspace.right",
    "workspace.bottom", "workspace.floating",
  ]) assert.match(slots, new RegExp(`"${slot}"`), `${slot} remains supported`);
  assert.match(source, /id: "system\.status"/);
  assert.match(source, /defaultSlot: "workspace\.right"/);
  assert.match(source, /supportedSlots: SYSTEM_STATUS_SLOTS/);
  assert.match(source, /defaultVisible: true/);
  assert.match(source, /registerWidgetPlugin\(SYSTEM_WIDGET_PLUGIN\)/);
  assert.doesNotMatch(source, /registerSlot\(|app\.header/);
});
