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
  assert.ok(src.includes("title={c.descriptor.label}"), "jump buttons need title");
  assert.ok(src.includes("aria-label={c.descriptor.label}"), "jump buttons need aria-label");
});

test("ContextRail exposes a named More tools disclosure, not an icon-only plus picker", async () => {
  const src = await railSource();
  assert.ok(!src.includes("Add or remove plugins"), "the plugin allow-list picker is gone");
  assert.ok(src.includes('aria-label="More tools"'), "the disclosure trigger is named");
  assert.ok(src.includes("aria-expanded={moreOpen}"), "the disclosure reports expanded state");
});
