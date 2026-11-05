import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Tooltip component uses 0.7 second (700ms) hover intent delay", async () => {
  const tooltipSrc = await readFile(new URL("../src/components/ui/Tooltip.tsx", import.meta.url), "utf8");
  assert.match(tooltipSrc, /const SHOW_DELAY_MS = 700;/);
});

test(".ui-tooltip styling meets high-visibility specification", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const tooltipRule = styles.match(/(?:^|\n)\.ui-tooltip\s*\{([^}]+)\}/);
  assert.ok(tooltipRule, ".ui-tooltip rule exists in styles.css");
  const body = tooltipRule[1];

  assert.match(body, /background:\s*#1a1a1a/);
  assert.match(body, /border-radius:\s*(?:8px|var\(--radius-control\))/);
  assert.match(body, /padding:\s*7px\s+11px/);
  assert.match(body, /color:\s*#fff/);
  assert.match(body, /font-weight:\s*500/);
  assert.match(body, /font-size:\s*calc\(var\(--font-meta\)\s*\+\s*2pt\)/);
  assert.match(body, /box-shadow:\s*0\s+4px\s+8px\s+rgba\(67,\s*78,\s*92,\s*0\.16\),\s*0\s+8px\s+16px\s+rgba\(55,\s*67,\s*82,\s*0\.14\)/);
});

test("SessionContextBar uses Tooltip component on the isolation switch instead of native title", async () => {
  const barSrc = await readFile(new URL("../src/components/mobile/SessionContextBar.tsx", import.meta.url), "utf8");
  assert.match(barSrc, /import Tooltip from "\.\.\/ui\/Tooltip\.tsx";/);
  assert.match(barSrc, /<Tooltip\s+content=\{multiRepository\s*\?\s*tr\("mobile\.sessioncontextbar\.isolateRepositoriesHint"\)\s*:\s*tr\("isolation\.workInIsolationHint"\)\}/);
  assert.doesNotMatch(barSrc, /className="context-isolation-control"[^>]*title=/);
});
