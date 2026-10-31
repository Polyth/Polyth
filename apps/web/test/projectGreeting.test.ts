import assert from "node:assert/strict";
import test from "node:test";
import { projectGreetingParts } from "../src/projectGreeting.ts";

test("absent greeting keeps the built-in line and empty text hides it", () => {
  assert.equal(projectGreetingParts(undefined), undefined);
  assert.equal(projectGreetingParts(""), null);
  assert.equal(projectGreetingParts("   "), null);
});

test("custom greeting splits around every project-name token", () => {
  assert.deepEqual(projectGreetingParts("Hello there"), [{ kind: "text", text: "Hello there" }]);
  assert.deepEqual(projectGreetingParts("Build {project}, ship {project}!"), [
    { kind: "text", text: "Build " },
    { kind: "name" },
    { kind: "text", text: ", ship " },
    { kind: "name" },
    { kind: "text", text: "!" },
  ]);
  assert.deepEqual(projectGreetingParts("{project}"), [{ kind: "name" }]);
});
