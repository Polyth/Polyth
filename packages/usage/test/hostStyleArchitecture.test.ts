// Moved from apps/web/test/styleArchitecture.test.ts: these cases are about the
// usage package's own CSS and the host's obligation not to restyle it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("Usage layout is container-responsive in narrow docked surfaces", async () => {
  const usage = await read("../widgets/usageAnalytics.css");

  assert.match(usage, /\.usage-clean\s*\{[^}]*container:\s*usage-clean\s*\/\s*inline-size/s);
  assert.match(
    usage,
    /@container usage-clean \(max-width: 620px\)[\s\S]*?\.usage-clean-toolbar\s*\{[\s\S]*?display:\s*grid/,
  );
  // Only the full-page Limits settings form may follow the viewport.
  for (const block of usage.matchAll(/@media[^{]*max-width[^{]*\{([\s\S]*?)\n\}/g)) {
    assert.doesNotMatch(block[1]!, /\.usage-clean/, "the docked dashboard responds to its container, not the viewport");
  }
});

test("Workspace chrome does not restyle package-owned Usage content", async () => {
  const [premium, widgetFixes, widgets] = await Promise.all([
    read("../../../apps/web/src/workspacePanelPremium.css"),
    read("../../../apps/web/src/workspacePanelWidgetFixes.css"),
    read("../widgets/usageWidgets.css"),
  ]);
  const host = `${premium}\n${widgetFixes}`;

  assert.doesNotMatch(host, /\.usage-[\w-]+/, "host Workspace CSS must not target package-owned Usage selectors");
  assert.match(widgets, /container:\s*usage-widget\s*\/\s*size/);
  assert.doesNotMatch(widgets, /@media[^{]*max-width/,
    "embedded Usage content responds to its container, not the viewport");
});
