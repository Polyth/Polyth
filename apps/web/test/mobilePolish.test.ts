import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { summarizeUnifiedDiff } = await import("../src/components/PendingChangesBar.tsx");
const { shellCardCopyText } = await import("../src/components/Timeline.tsx");

test("workspace diff totals count content without file headers", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " unchanged",
    "-old",
    "+new",
    "+another",
    "",
  ].join("\n");
  assert.deepEqual(summarizeUnifiedDiff(diff), { additions: 2, deletions: 1 });
});

test("shell card copy combines the command and its result", () => {
  assert.equal(
    shellCardCopyText({ command: "npm test" }, "started\npid 42"),
    "npm test\n\nstarted\npid 42",
  );
  assert.equal(shellCardCopyText({ argv: ["npm", "test"] }), '{\n  "argv": [\n    "npm",\n    "test"\n  ]\n}');
});
