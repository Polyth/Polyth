// `host.execution.describe`: the timeline's tool classification reduced to a
// kind and a short subject that is safe to say aloud (voice mode narration).
import test from "node:test";
import assert from "node:assert/strict";
import { describeToolActivity } from "../src/execution.ts";

test("a tool call is described by kind and a speakable subject, never a path or command line", () => {
  assert.deepEqual(describeToolActivity("Read", { file_path: "/home/someone/project/src/config.ts" }), { kind: "read", target: "config.ts" });
  assert.deepEqual(describeToolActivity("Edit", { file_path: "src/app.tsx", old_string: "a", new_string: "b" }), { kind: "edit", target: "app.tsx" });
  assert.deepEqual(describeToolActivity("Bash", { command: "cd /repo && npm test -- --watch" }), { kind: "test" });
  assert.deepEqual(describeToolActivity("Bash", { command: "FOO=1 /usr/bin/python3 tools/x.py --secret abc" }), { kind: "shell", target: "python3" });
  assert.deepEqual(describeToolActivity("Grep", { pattern: "parseConfig" }), { kind: "search", target: "parseConfig" });
  assert.deepEqual(describeToolActivity("Grep", { pattern: "\\bfoo\\(\\s*[a-z]+" }), { kind: "search" }, "a regex is not read out");
  assert.deepEqual(describeToolActivity("Grep", { pattern: "(?:[^)]+)\\d{3}" }), { kind: "search" });
  assert.deepEqual(describeToolActivity("WebFetch", { url: "https://www.example.com/docs/page" }), { kind: "web", target: "example.com" });
  assert.deepEqual(describeToolActivity("TodoWrite", { todos: [] }), { kind: "plan" });
  assert.equal(describeToolActivity("Task", { description: "Investigate" }).kind, "subagent");
});
