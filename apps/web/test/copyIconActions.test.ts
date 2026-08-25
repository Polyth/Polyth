import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("copy and message actions are icon-only with hover and accessible names", async () => {
  const [copy, timeline] = await Promise.all([
    readFile(new URL("../src/components/CopyButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(copy, /aria-label=\{tr\("copybutton\.copyToClipboard"\)\}/);
  assert.match(copy, /title=\{tr\("copybutton\.copyToClipboard"\)\}/);
  assert.match(copy, /<Icon\.(?:check|copy)/);

  for (const icon of ["copy", "fork", "rewind"]) {
    assert.match(timeline, new RegExp(`<Icon\\.${icon}`));
  }
  assert.doesNotMatch(timeline, /<Icon\.(?:markdown|json)/);
  assert.match(timeline, /aria-label=\{entry\.name\}/);
  assert.match(timeline, /title=\{entry\.disabledReason \?\? entry\.name\}/);
  assert.doesNotMatch(timeline, />Copy MD<\/button>|>Copy JSON<\/button>|>Fork and edit<\/button>/);
});
