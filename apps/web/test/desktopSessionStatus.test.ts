import test from "node:test";
import assert from "node:assert/strict";
import { nextSessionSwitcherIndex } from "../src/sessionSwitcher.ts";
import { readFile } from "node:fs/promises";

test("session switcher cycles up then back down", () => {
  let index = 0;
  let direction: 1 | -1 = 1;
  const cycle = [index];
  for (let count = 0; count < 4; count++) {
    [index, direction] = nextSessionSwitcherIndex(index, direction, 3);
    cycle.push(index);
  }
  assert.deepEqual(cycle, [0, 1, 2, 1, 0]);
});

test("desktop status shares the live chat column geometry", async () => {
  const [header, rail, styles] = await Promise.all([
    readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(header, /--sidebar-inline-size/);
  assert.match(rail, /--workspace-pane-inline-size/);
  assert.match(styles, /\.desktop-session-status[^}]+--sidebar-inline-size[^}]+--workspace-pane-inline-size/);
  assert.match(styles, /body\[data-chatwidth="wide"\]\s*\{\s*--chat-measure:\s*1180px;/);
  assert.doesNotMatch(styles, /body\[data-chatwidth="wide"\] \.timeline\s*\{/);
  assert.doesNotMatch(styles, /\.timeline\s*\{[^}]*padding-inline-end:[^}]*--rail-strip-width-right/s);
});

test("session status hides a prompt that is visible in the timeline", async () => {
  const [desktop, mobile, timeline] = await Promise.all([
    readFile(new URL("../src/components/DesktopSessionStatus.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(desktop, /intent && !promptVisible/);
  assert.match(mobile, /promptVisible \? undefined : prompt/);
  assert.match(timeline, /row\.bottom > viewport\.top && row\.top < viewport\.bottom/);
});
