// Navigator affordances for people-first conversations: a group glyph instead
// of the agent/status mark and no running clock, on both navigators.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("desktop conversation rows use the people glyph and skip agent status cues", async () => {
  const [source, icons] = await Promise.all([
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/components/ui/icons.ts"),
  ]);
  assert.match(icons, /UsersRound as PeopleIcon/);
  assert.match(source, /PeopleIcon/);
  assert.match(source, /s\.purpose === "conversation"/);
  assert.match(source, /\{conversation\s*\? <span className="session-lead-mark people" aria-hidden="true"><UiIcon icon=\{PeopleIcon\} size="sm" \/><\/span>\s*: <LeadStatus status=\{rowStatus\} opening=\{opening\} \/>\}/);
  assert.match(source, /const leadDescription = conversation \? undefined : statusDescription\(rowStatus, opening\);/);
  assert.match(source, /\{!conversation && <ElapsedBadge status=\{rowStatus\} \/>\}/);
});

test("the desktop people mark drops the status-badge disc", async () => {
  // The base .session-lead-mark paints a disc for "!"/"?" badges; the group
  // glyph inside it read as a blurred "8" in a ring.
  const css = await read("../src/styles.css");
  assert.match(css, /\.session-lead-mark\.people \{ background: none; box-shadow: none; \}/);
  assert.match(css, /\.session-lead-mark\.people svg \{ width: 100%; height: 100%; \}/);
});

test("phone conversation rows use the people glyph and no duration", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  assert.match(source, /PeopleIcon/);
  assert.match(source, /session\.purpose === "conversation"/);
  assert.match(source, /leadStatus\(rowStatus, conversation\)/);
  assert.match(source, /\{!conversation && rowStatus\.kind === "working" && \(/);
});
