import test from "node:test";
import assert from "node:assert/strict";
import {
  hasTypeRequest, requestTypeIntoTerminal, shellCommandFromBlock, takeTypeRequest,
} from "../widgets/typeIntoTerminal.ts";

test("shell blocks yield one command; console prompts are stripped", () => {
  assert.equal(shellCommandFromBlock("bash", "npm test\n"), "npm test");
  assert.equal(shellCommandFromBlock("console", "$ git status\nOn branch main\n"), "git status");
  assert.equal(shellCommandFromBlock("console", "> dir"), "dir");
  assert.equal(shellCommandFromBlock("sh", "docker run \\\n  -it ubuntu\n"), "docker run -it ubuntu");
  assert.equal(shellCommandFromBlock("zsh", "$ not a prompt strip"), "$ not a prompt strip");
});

test("non-shell, empty and multi-command blocks are not offered", () => {
  assert.equal(shellCommandFromBlock("python", "print(1)"), null);
  assert.equal(shellCommandFromBlock("bash", "  \n"), null);
  assert.equal(shellCommandFromBlock("bash", "cd app\nnpm i\n"), null, "two commands would need Enter between them");
  assert.equal(shellCommandFromBlock("bash", "echo \u001b[2Jhi"), null, "control characters are refused");
});

test("a type request never carries a newline and is taken once", () => {
  requestTypeIntoTerminal("s1", "ls\n");
  assert.equal(hasTypeRequest("s1"), false, "text with Enter is refused");
  requestTypeIntoTerminal("s1", "ls -la");
  assert.equal(hasTypeRequest("s1"), true);
  assert.equal(hasTypeRequest("s2"), false);
  assert.equal(takeTypeRequest("s1")?.text, "ls -la");
  assert.equal(takeTypeRequest("s1"), undefined);
});
