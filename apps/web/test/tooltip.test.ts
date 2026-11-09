import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Tooltip component uses 0.7 second (700ms) hover intent delay", async () => {
  const tooltipSrc = await readFile(new URL("../src/components/ui/Tooltip.tsx", import.meta.url), "utf8");
  assert.match(tooltipSrc, /const SHOW_DELAY_MS = 700;/);
});

test(".ui-tooltip is a legible help tag drawn in the theme's own surface and ink", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const tooltipRule = styles.match(/(?:^|\n)\.ui-tooltip\s*\{([^}]+)\}/);
  assert.ok(tooltipRule, ".ui-tooltip rule exists in styles.css");
  const body = tooltipRule[1];

  // Light themes get a light tag, dark themes a dark one: no fixed colours.
  assert.match(body, /background:\s*var\(--material-glass\)/);
  assert.match(body, /border:\s*1px solid var\(--material-glass-border\)/);
  assert.match(body, /color:\s*var\(--text\)/);
  assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b|rgba?\(/i);
  assert.match(body, /border-radius:\s*(?:8px|var\(--radius-control\))/);
  assert.match(body, /padding:\s*7px\s+11px/);
  assert.match(body, /font-weight:\s*500/);
  assert.match(body, /font-size:\s*calc\(var\(--font-meta\)\s*\+\s*2pt\)/);
});

test("SessionContextBar uses Tooltip component on the isolation switch instead of native title", async () => {
  const barSrc = await readFile(new URL("../src/components/mobile/SessionContextBar.tsx", import.meta.url), "utf8");
  assert.match(barSrc, /import Tooltip from "\.\.\/ui\/Tooltip\.tsx";/);
  assert.match(barSrc, /<Tooltip\s+content=\{multiRepository\s*\?\s*tr\("mobile\.sessioncontextbar\.isolateRepositoriesHint"\)\s*:\s*tr\("isolation\.workInIsolationHint"\)\}/);
  assert.doesNotMatch(barSrc, /className="context-isolation-control"[^>]*title=/);
});

test("every tooltip surface (chat actions, themes, rail) follows the theme's surface and ink", async () => {
  const chatChromeCss = await readFile(new URL("../src/components/ChatChrome.css", import.meta.url), "utf8");
  assert.doesNotMatch(chatChromeCss, /\.ui-tooltip\.chat-action-tooltip\s*\{[^}]*background:/);

  const fluentCss = await readFile(new URL("../src/fluentTheme.css", import.meta.url), "utf8");
  assert.doesNotMatch(fluentCss, /html\[data-theme-style="fluent"\]\s+\.ui-tooltip\s*\{/);

  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const msgActionTooltip = styles.match(/(?:^|\n)\.msg-action-btn::after\s*\{([^}]+)\}/);
  assert.ok(msgActionTooltip, ".msg-action-btn::after exists in styles.css");
  const msgBody = msgActionTooltip[1]!;
  assert.match(msgBody, /background:\s*var\(--material-glass\)/);
  assert.match(msgBody, /color:\s*var\(--text\)/);
  assert.match(msgBody, /padding:\s*7px\s+11px/);
  assert.doesNotMatch(msgBody, /#1a1a1a|#fff\b/);

  const railTooltip = styles.match(/(?:^|\n)\.sidebar-project-rail-tooltip\.ui-tooltip\s*\{([^}]+)\}/);
  assert.ok(railTooltip, ".sidebar-project-rail-tooltip.ui-tooltip exists in styles.css");
  const railBody = railTooltip[1]!;
  assert.match(railBody, /color:\s*var\(--text\)/);
  assert.doesNotMatch(railBody, /#fff\b|background:/);
});
