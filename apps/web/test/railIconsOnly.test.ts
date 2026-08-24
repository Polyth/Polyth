// Regression guard for the right rail UX decision: icons only, no visible
// labels (the old strip-label spans truncated to "Chan…", "Comp…", …).
// Accessibility is carried by title + aria-label on every strip button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const railSource = () =>
  readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8");

test("ContextRail renders no visible strip labels", async () => {
  const src = await railSource();
  assert.ok(!src.includes("strip-label"), "rail must stay icons-only (no strip-label spans)");
});

test("ContextRail strip buttons keep title + aria-label for hover/accessibility", async () => {
  const src = await railSource();
  assert.ok(src.includes("title={s.title}"), "surface buttons need title");
  assert.ok(src.includes("aria-label={s.title}"), "surface buttons need aria-label");
});

test("ContextRail omits the bottom add and More button group", async () => {
  const src = await railSource();
  assert.ok(!src.includes("rail-add-button"), "the add control is gone");
  assert.ok(!src.includes("strip-more"), "the More control is gone");
  assert.ok(!src.includes("moreToolsPicker"), "the old bottom button group is gone");
});

// UX-PANE-MODEL: Terminal and Preview are registered workspace surfaces
// launched through the same strip buttons as everything else.
test("ContextRail has no JUMPS rows — panes open through registered launchers", async () => {
  const src = await railSource();
  assert.ok(!src.includes("JUMPS"), "jump rows were replaced by workspace pane launchers");
  assert.ok(src.includes("toggleRailPlugin(s.id)"), "strip buttons route through the shared toggle");
});

test("right-rail utilities use distinct semantic icons", async () => {
  const src = await readFile(new URL("../src/components/railSurfaces.tsx", import.meta.url), "utf8");
  assert.match(src, /id: "context"[\s\S]*?icon: Icon\.context/);
  assert.match(src, /id: "knowledge"[\s\S]*?icon: Icon\.book/);
  assert.match(src, /id: "usage"[\s\S]*?icon: Icon\.usage/);
  assert.match(src, /id: "events"[\s\S]*?icon: Icon\.events/);
});
