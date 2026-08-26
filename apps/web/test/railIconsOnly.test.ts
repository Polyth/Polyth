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

// UX-PANE-MODEL: registered panes and capabilities without a panel body use
// the same strip launcher contract.
test("ContextRail has no JUMPS rows — every placed capability gets a launcher", async () => {
  const src = await railSource();
  assert.ok(!src.includes("JUMPS"), "jump rows were replaced by workspace pane launchers");
  assert.ok(src.includes("onClick={s.activate}"), "strip buttons use their shared launcher");
  assert.ok(src.includes('capability.tier === "more"'), "right-rail placement drives the button list");
  assert.ok(src.includes("capability.descriptor.open()"), "capabilities without panel surfaces still open");
});

test("right-rail utilities use distinct semantic icons", async () => {
  const [shell, knowledge, usage] = await Promise.all([
    readFile(new URL("../src/components/railSurfaces.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/knowledge/widgets/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/usage/widgets/index.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /id: "context"[\s\S]*?icon: RAIL_ICONS\.context/);
  assert.match(shell, /id: "events"[\s\S]*?icon: RAIL_ICONS\.events/);
  assert.match(knowledge, /id: "knowledge"/);
  assert.match(usage, /id: "usage"/);
});

test("every built-in rail item has a unique rendered icon", async () => {
  const [mappingSource, iconsSource] = await Promise.all([
    readFile(new URL("../src/railIcons.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/icons.tsx", import.meta.url), "utf8"),
  ]);
  const entries = [...mappingSource.matchAll(/^\s{2}(?:"([^"]+)"|([\w-]+)): Icon\.(\w+),$/gm)]
    .map((match) => ({ item: match[1] ?? match[2]!, icon: match[3]! }));
  assert.deepEqual(entries.map((entry) => entry.item), [
    "session", "files", "git", "terminal", "browser", "goals", "multirun",
    "workflow", "fusion", "walkthrough", "schedule", "usage", "github",
    "knowledge", "context", "voice", "models-agents", "events", "diagnostics",
    "tracks", "notification-centre",
  ]);
  assert.equal(new Set(entries.map((entry) => entry.icon)).size, entries.length);

  const markup = entries.map((entry) => {
    const match = iconsSource.match(new RegExp(`^\\s{2}${entry.icon}: \\(\\) => (.+),$`, "m"));
    assert.ok(match, `missing Icon.${entry.icon}`);
    return match[1]!;
  });
  assert.equal(new Set(markup).size, markup.length, "rail icons must render different SVG markup");
});
