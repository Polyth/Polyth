import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflows = join(import.meta.dirname, "..", "..", ".github", "workflows");

// A tag can be moved to other code; a commit SHA cannot. Dependabot keeps the
// SHA and the version comment in step.
test("every workflow action is pinned to a full commit SHA with its version in a comment", () => {
  const unpinned: string[] = [];
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
    for (const [index, line] of readFileSync(join(workflows, file), "utf8").split("\n").entries()) {
      const uses = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (!uses || uses[1]!.startsWith("./")) continue;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(uses[1]!) || !/^\s+#\s*\S+/.test(uses[2]!)) {
        unpinned.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(unpinned, []);
});
