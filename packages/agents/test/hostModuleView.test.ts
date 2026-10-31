// How Agents present is this package's own UI decision, so it is asserted
// here rather than in the host surface test, which no longer names a
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

/** Brace-matched bodies of every `surfaces.register(...)` call in a source file. */
function surfaceRegisterCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "surfaces.register(";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const open = index + marker.length - 1;
    let depth = 0;
    let cursor = open;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) { cursor += 1; break; }
      cursor += 1;
    }
    calls.push(source.slice(open, cursor));
    index = source.indexOf(marker, cursor);
  }
  return calls;
}

test("Agents open as a page in place of Chat and register no workspace surface", async () => {
  const source = await read("../widgets/index.tsx");
  // A docked workspace surface would need the shared ModuleView subtitle
  // decision; the agents' own page replaces Chat instead (host.pages).
  assert.deepEqual(surfaceRegisterCalls(source), [], "no workspace surface");
  assert.match(source, /pages\.register\(\{\s*id:\s*AGENTS_PAGE_ID/, "the agents page is registered");
});

test("Agents start on a Personal project's right rail", async () => {
  const source = await read("../widgets/index.tsx");
  const registration = source.split("capabilities.register(").find((chunk) => chunk.slice(0, 200).includes('id: "schedule"'));
  assert.match(/defaultRails: (\{[^}]*\})/.exec(registration ?? "")?.[1] ?? "", /personal: "right"/);
});
